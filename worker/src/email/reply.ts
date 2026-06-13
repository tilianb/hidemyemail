import type { Env, ParsedReverse, ReplyAuth } from "../types";
import * as q from "../db/queries";
import { streamToBytes, toBase64 } from "../lib/bytes";
import { parseMime, setHeader, removeHeaders, getHeader, serializeMime } from "../lib/mime";
import { sendRaw, SesTransientError } from "../lib/ses";
import { getEnvWithOverride, getNumericSetting } from "../lib/settings";

type SesSend = typeof sendRaw;

// Pull the bare "user@host" out of an RFC 5322 From header. Handles "Name <a@b>",
// '"Quoted Name" <a@b>', and bare "a@b". Returns "" if no '@' is present.
//
// SECURITY: RFC 5322 lets a quoted-string display-name (and parenthesised
// comments) contain arbitrary characters, including '<', '>', and '@'. SES
// parses the real addr-spec out of the From header for DMARC alignment, so a
// naïve "first <addr> wins" regex disagrees with SES when the display-name
// embeds an angle-bracketed string — e.g. `From: "spoof <owner@me.com>"
// <attacker@evil.com>` makes SES report DMARC=PASS for evil.com while a
// naïve parser returns owner@me.com, opening the relay gate to anyone with a
// DMARC-aligned attacker domain. Strip quoted-strings and comments first, then
// take the *last* <addr-spec> (RFC 5322 places it after the display-name).
function extractEmailAddress(value: string): string {
  const stripped = value
    .replace(/"(?:\\.|[^"\\])*"/g, "")  // RFC 5322 quoted-string display-name
    .replace(/\([^()]*\)/g, "");         // RFC 5322 comment (non-nested)
  const matches = [...stripped.matchAll(/<\s*([^<>\s]+@[^<>\s]+)\s*>/g)];
  if (matches.length > 0) return matches[matches.length - 1]![1]!.trim();
  const bare = stripped.match(/[^\s<>"',;]+@[^\s<>"',;]+/);
  return bare ? bare[0].trim() : "";
}

export async function handleReply(
  message: ForwardableEmailMessage, env: Env, parsed: ParsedReverse, auth?: ReplyAuth,
): Promise<void> {
  const db = env.DB;
  const ses: SesSend = (env as any).__sesSend ?? sendRaw;
  const now = Date.now();
  const domainName = message.to.slice(message.to.lastIndexOf("@") + 1).toLowerCase();
  const aliasFull = `${parsed.aliasLocal}@${domainName}`.toLowerCase();

  const alias = await q.getAlias(db, aliasFull);
  if (!alias || alias.active === 0) return;

  const userRow = await db.prepare("SELECT forwarding FROM users WHERE id = ?").bind(alias.user_id).first<{ forwarding: number }>();
  if (!userRow || userRow.forwarding === 0) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: parsed.externalSender, detail: "user_forwarding_disabled", ts: now });
    return;
  }

  if (alias.source === "auto_over_quota") {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: parsed.externalSender, detail: "quota_exceeded", ts: now });
    return;
  }

  // SECURITY: reverse addresses are self-describing and therefore guessable (no random
  // token). The relay gate must bind the *authenticated* principal to a verified owner
  // destination. Each SES verdict authenticates a different RFC5322 field:
  //   - spfVerdict PASS ⇒ envelope MAIL FROM (message.from) is authentic.
  //   - dmarcVerdict PASS ⇒ header-From (after alignment) is authentic.
  // Accepting `spf || dmarc` while only matching the envelope lets an attacker spoof
  // MAIL FROM=owner and DKIM-sign with their own header-From to slip past. Match each
  // signal against the principal it actually authenticates. Fail closed.
  const rawBytes = await streamToBytes(message.raw);
  let mime = parseMime(rawBytes);
  const subject = getHeader(mime, "Subject") ?? "";
  const rawFromHeader = getHeader(mime, "From") ?? "";
  const headerFrom = extractEmailAddress(rawFromHeader).toLowerCase();
  const envelopeFrom = message.from.toLowerCase();
  const owners = await q.ownerDestinations(db, alias.user_id, env.DESTINATION_ENCRYPTION_KEY);
  const spfOwner = auth?.spf === "PASS" && owners.has(envelopeFrom);
  const dmarcOwner = auth?.dmarc === "PASS" && !!headerFrom && owners.has(headerFrom);
  if (!spfOwner && !dmarcOwner) {
    await q.insertEvent(db, {
      alias_id: alias.id, type: "reject", external_sender: parsed.externalSender,
      detail: owners.has(envelopeFrom) || (headerFrom && owners.has(headerFrom)) ? "auth" : "not_owner", ts: now,
    });
    return;
  }

  // ABUSE: reverse addresses are guessable, so the authenticated owner gate alone does
  // not stop the owner from crafting a reverse address for an arbitrary stranger and
  // using the alias as a cold-outbound spam relay. Require a prior inbound forward from
  // the same external sender — turning this into a genuine *reply*, not an *originate*.
  // Fail closed.
  if (!(await q.hasPriorInbound(db, alias.id, parsed.externalSender))) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: parsed.externalSender, detail: "no_prior_contact", ts: now });
    return;
  }

  // Reply rate limit: outbound consumes SES quota and sender reputation, so cap
  // replies only. Busy inbound aliases must not lose outbound reply capability
  // just because they received many forwards. -1 disables a cap.
  const replyCap = await getNumericSetting(db, "rate_limit_reply_per_alias");
  const globalCap = await getNumericSetting(db, "rate_limit_global");
  const aliasCount = await q.countEventsByTypeSince(db, alias.id, now - 3600_000, ["reply"]);
  const globalCount = await q.countEventsByTypeSince(db, null, now - 3600_000, ["reply"]);
  if ((replyCap >= 0 && aliasCount >= replyCap) || (globalCap >= 0 && globalCount >= globalCap)) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: parsed.externalSender, detail: "rate", ts: now });
    return;
  }

  // ABUSE: even with first-contact + per-alias rate limiting, an authenticated owner
  // can reply to MANY DISTINCT strangers (each of whom emailed them once) and use the
  // alias as a cold-outbound spam relay. Cap the number of unique recipients an alias
  // replies to per 24h. Replying to an already-contacted correspondent never increases
  // the distinct count — only NEW recipients are gated, so ongoing threads are not
  // affected. Tripping the cap mutes the alias for 24h (inbound also pauses) to force
  // owner attention. -1 disables the cap. Fail closed.
  const distinctCap = await getNumericSetting(db, "reply_distinct_recipient_cap");
  if (distinctCap >= 0) {
    const since = now - 24 * 3600_000;
    const alreadyContacted = await q.hasRepliedTo(db, alias.id, parsed.externalSender, since);
    if (!alreadyContacted) {
      const distinct = await q.countDistinctReplyRecipientsSince(db, alias.id, since);
      if (distinct >= distinctCap) {
        await q.muteAlias(db, alias.id, now + 24 * 3600_000); // 24h cooldown mute
        await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: parsed.externalSender, detail: "distinct_recipient_cap", ts: now });
        return;
      }
    }
  }

  // Strip both legacy (X-Reinjected, X-Forwarded-*, X-Original-From) and the
  // current X-HideMyEmail-* forwarding metadata so an outbound reply never
  // re-exposes the sender's destination or the forwarder hop chain.
  mime = removeHeaders(mime, [
    "From", "Sender", "Reply-To", "Return-Path", "DKIM-Signature", "Message-ID", "Received",
    "X-Reinjected", "X-Forwarded-For", "X-Forwarded-To", "X-Original-From",
    "X-HideMyEmail-Forwarded-For", "X-HideMyEmail-Forwarded-To", "X-HideMyEmail-Original-From",
    "List-Unsubscribe", "List-Unsubscribe-Post",
  ]);
  mime = setHeader(mime, "From", alias.full_address);
  mime = setHeader(mime, "To", parsed.externalSender || message.to);
  mime = setHeader(mime, "Message-ID", `<${crypto.randomUUID()}@${domainName}>`);

  const rawBase64 = toBase64(serializeMime(mime));
  try {
    const sesAccessKeyId = await getEnvWithOverride(db, env, "ses_access_key_id");
    const sesSecretAccessKey = await getEnvWithOverride(db, env, "ses_secret_access_key");
    const sesRegion = await getEnvWithOverride(db, env, "ses_region");
    await ses(
      { accessKeyId: sesAccessKeyId, secretAccessKey: sesSecretAccessKey, region: sesRegion },
      { from: alias.full_address, to: parsed.externalSender, rawBase64 }
    );
  } catch (err) {
    await q.insertEvent(db, { alias_id: alias.id, type: "error", detail: String(err), ts: now });
    if (err instanceof SesTransientError) throw err;
    return;
  }

  await q.insertEvent(db, { alias_id: alias.id, type: "reply", external_sender: parsed.externalSender, subject, ts: now });
  await q.incCounter(db, alias.id, "reply_count");
}
