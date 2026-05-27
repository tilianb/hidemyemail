import type { Env } from "../types";
import * as q from "../db/queries";
import { isBlocked } from "../lib/blocks";
import { streamToBytes, toBase64 } from "../lib/bytes";
import { parseMime, setHeader, removeHeaders, getHeader, serializeMime } from "../lib/mime";
import { reverseAddress } from "../lib/reverse";
import { sendRaw, SesTransientError } from "../lib/ses";
import { getNumericSetting, getBoolSetting, getEnvWithOverride } from "../lib/settings";
import { decryptDestination } from "../lib/crypto";

type SesSend = typeof sendRaw;

export async function handleInbound(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const db = env.DB;
  const ses: SesSend = (env as any).__sesSend ?? sendRaw;
  const now = Date.now();
  const [localPart, domainName] = splitAddress(message.to);

  const domain = await q.getDomain(db, domainName);
  if (!domain || domain.active === 0) return;

  // Check catch-all auto-create setting
  const autoCreateEnabled = await getBoolSetting(db, "catch_all_auto_create");
  let alias;
  if (autoCreateEnabled) {
    alias = await q.autoCreateAlias(db, domain.id, localPart, message.to.toLowerCase());
  } else {
    alias = await q.getAlias(db, message.to.toLowerCase());
  }
  
  if (!alias) {
    // No alias found, and autoCreate disabled or failed
    // Silently drop
    return;
  }

  if (alias.active === 0) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "disabled", ts: now });
    return;
  }

  const userRow = await db.prepare("SELECT forwarding FROM users WHERE id = ?").bind(alias.user_id).first<{ forwarding: number }>();
  if (!userRow || userRow.forwarding === 0) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "user_forwarding_disabled", ts: now });
    return;
  }

  const rules = await q.listBlocks(db, alias.id, alias.user_id);
  if (isBlocked(rules, message.from)) {
    await q.insertEvent(db, { alias_id: alias.id, type: "block", external_sender: message.from, ts: now });
    await q.incCounter(db, alias.id, "blocked_count");
    return;
  }

  // Read rate limits from DB settings (falls back to hardcoded defaults)
  const rateLimitAlias = await getNumericSetting(db, "rate_limit_per_alias");
  const rateLimitGlobal = await getNumericSetting(db, "rate_limit_global");
  const aliasCount = await q.countEventsSince(db, alias.id, now - 3600_000);
  const globalCount = await q.countEventsSince(db, null, now - 3600_000);
  if (aliasCount >= rateLimitAlias || globalCount >= rateLimitGlobal) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "rate", ts: now });
    return;
  }

  const maxInboundBytes = await getNumericSetting(db, "max_inbound_bytes");
  if (message.rawSize > maxInboundBytes) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "too_large", ts: now });
    return;
  }

  const encDest = alias.destination ?? domain.default_destination;
  if (!encDest) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "no_destination", ts: now });
    return;
  }
  const dest = await decryptDestination(encDest, env.DESTINATION_ENCRYPTION_KEY);
  const reverseAddr = reverseAddress(localPart, message.from, domainName);

  const raw = await streamToBytes(message.raw);
  let mime = parseMime(raw);
  const origFrom = getHeader(mime, "From") ?? message.from;
  // addy style: From shows the alias, display name carries the real sender's name + email;
  // Reply-To is the reverse address so hitting Reply routes back through the alias.
  // e.g. From: "Alice 'alice@store.com'" <shop@domain>  Reply-To: shop+alice=store.com@domain
  const senderName = extractDisplayName(origFrom);
  const safeSenderName = senderName.replace(/@/g, " at ");
  const safeFrom = message.from.replace(/@/g, " at ");
  const display = safeSenderName ? `${safeSenderName} - ${safeFrom}` : safeFrom;
  mime = setHeader(mime, "From", `"${sanitize(display)}" <${alias.full_address}>`);
  mime = setHeader(mime, "Reply-To", reverseAddr);
  mime = removeHeaders(mime, ["DKIM-Signature", "ARC-Seal", "ARC-Message-Signature", "ARC-Authentication-Results", "Return-Path", "Sender"]);
  mime = setHeader(mime, "X-Reinjected", "1");
  mime = setHeader(mime, "X-Forwarded-For", message.from);
  mime = setHeader(mime, "X-Forwarded-To", message.to);
  mime = setHeader(mime, "X-Original-From", origFrom);
  
  const { signAction } = await import("./action");
  const disableSig = await signAction("disable", alias.id, env);
  const actionEmail = `action+disable=${alias.id}_${disableSig}@${domainName}`;
  mime = setHeader(mime, "List-Unsubscribe", `<mailto:${actionEmail}>`);
  mime = setHeader(mime, "List-Unsubscribe-Post", "List-Unsubscribe=One-Click");

  const rawBase64 = toBase64(serializeMime(mime));

  try {
    const sesAccessKeyId = await getEnvWithOverride(db, env, "ses_access_key_id");
    const sesSecretAccessKey = await getEnvWithOverride(db, env, "ses_secret_access_key");
    const sesRegion = await getEnvWithOverride(db, env, "ses_region");
    await ses(
      { accessKeyId: sesAccessKeyId, secretAccessKey: sesSecretAccessKey, region: sesRegion },
      { from: alias.full_address, to: dest, rawBase64 }
    );
  } catch (err) {
    await q.insertEvent(db, { alias_id: alias.id, type: "error", external_sender: message.from, detail: String(err), ts: now });
    if (err instanceof SesTransientError) throw err; // tempfail → sender retries
    return;
  }

  await q.insertEvent(db, { alias_id: alias.id, type: "forward", external_sender: message.from, subject: getHeader(mime, "Subject"), bytes: message.rawSize, ts: now });
  await q.incCounter(db, alias.id, "fwd_count");
}

function splitAddress(addr: string): [string, string] {
  const at = addr.lastIndexOf("@");
  return [addr.slice(0, at).toLowerCase(), addr.slice(at + 1).toLowerCase()];
}
function extractDisplayName(from: string): string {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*</);
  return m?.[1]?.trim() ?? "";
}
function sanitize(s: string): string {
  return s.replace(/["\r\n]/g, "").slice(0, 100);
}
