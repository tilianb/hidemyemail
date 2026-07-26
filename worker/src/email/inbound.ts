import type { Env, ReplyAuth } from "../types";
import * as q from "../db/queries";
import PostalMime from "postal-mime";
import { createMimeMessage, Mailbox } from "mimetext";
import { evaluateSenderRules } from "../lib/blocks";
import { streamToBytes, toBase64 } from "../lib/bytes";
import { parseMime, setHeader, removeHeaders, getHeader, serializeMime } from "../lib/mime";
import { reverseAddress } from "../lib/reverse";
import { sendRaw, SesTransientError } from "../lib/ses";
import { getNumericSetting, getBoolSetting, getEnvWithOverride, getSetting, getMainGlobalDomain } from "../lib/settings";
import { decryptDestination, hashDestination } from "../lib/crypto";
import { extractDisplayName, sanitizeDisplay as sanitize, buildForwardedFromDisplay } from "../lib/from-format";
import { pushBlocked, pushForward } from "../lib/push";
import type { DeliveryContext } from "./router";

type SesSend = typeof sendRaw;

export async function handleInbound(message: ForwardableEmailMessage, env: Env, auth?: ReplyAuth, delivery?: DeliveryContext): Promise<void> {
  const db = env.DB;
  const ses: SesSend = (env as any).__sesSend ?? sendRaw;
  const now = Date.now();
  const [localPart, domainName] = splitAddress(message.to);

  const domain = await q.getDomain(db, domainName) as import("../types").DomainRow & { user_id: number };
  if (!domain || domain.active === 0) return;

  // Check catch-all auto-create setting. A per-subdomain override (catch_all
  // 0/1) wins; NULL falls back to the global setting.
  const autoCreateEnabled = domain.catch_all != null
    ? domain.catch_all === 1
    : await getBoolSetting(db, "catch_all_auto_create");
  let alias = await q.getAlias(db, message.to.toLowerCase());
  
  if (!alias && autoCreateEnabled) {
    const aliasCount = await db.prepare("SELECT COUNT(*) as c FROM aliases WHERE user_id = ?").bind(domain.user_id).first<{c: number}>();
    const maxTotalAliases = await getNumericSetting(db, "max_total_aliases");
    const quotaBufferEnabled = await getBoolSetting(db, "alias_quota_buffer_enabled");
    if (maxTotalAliases >= 0 && aliasCount) {
      const ceiling = quotaBufferEnabled ? maxTotalAliases + 1 : maxTotalAliases;
      if (aliasCount.c >= ceiling) {
        const canNotify = await checkCooldown(db, `notify:hard_limit:${domain.user_id}`, 24);
        if (canNotify && domain.default_destination) {
          const dest = await decryptDestination(domain.default_destination, env.DESTINATION_ENCRYPTION_KEY);
          await sendSystemNotification(db, env, dest, "Alias Limit Reached", "Absolute Hard Limit Reached", `An incoming email to ${message.to} was dropped because you have reached your absolute hard limit of ${maxTotalAliases} aliases. You must delete old aliases to receive catch-all emails again.`);
        }
        return;
      }
    }
    const source = (maxTotalAliases >= 0 && aliasCount && aliasCount.c >= maxTotalAliases) ? "auto_over_quota" : "auto";
    alias = await q.autoCreateAlias(db, domain.id, localPart, message.to.toLowerCase(), source);
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

  if (alias.muted_until && alias.muted_until > now) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "muted", ts: now });
    return;
  }

  if (alias.source === "auto_over_quota") {
    const ageHours = (now - alias.created_at) / 3600_000;
    if (ageHours >= 1) {
      await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "quota_grace_expired", ts: now });
      const canNotify = await checkCooldown(db, `notify:grace_expired:${alias.id}`, 24);
      const encDest = alias.destination ?? domain.default_destination;
      if (canNotify && encDest) {
         const dest = await decryptDestination(encDest, env.DESTINATION_ENCRYPTION_KEY);
         await sendSystemNotification(db, env, dest, "Email Dropped - Grace Period Expired", "Grace Period Expired", `An incoming email to ${alias.full_address} was dropped because this alias was created while you were over your quota and its 1-hour grace period has expired.`);
      }
      return;
    }
  }

  // SES receipt verdict gate. Forwarded mail is re-signed with OUR domain's
  // DKIM, so forwarding spam/malware burns the alias domain's sender
  // reputation at Gmail/Outlook. Admin picks the action per verdict; only a
  // hard FAIL acts (GRAY/PROCESSING_FAILED/DISABLED pass through untouched).
  let flagSpam = false;
  let flagVirus = false;
  if (auth?.virus === "FAIL") {
    const action = await getSetting(db, "virus_verdict_action");
    if (action !== "forward" && action !== "flag") {
      await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "virus", ts: now });
      return;
    }
    flagVirus = action === "flag";
  }
  if (auth?.spam === "FAIL") {
    const action = await getSetting(db, "spam_verdict_action");
    if (action === "drop") {
      await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "spam", ts: now });
      return;
    }
    flagSpam = action !== "forward";
  }

  const userRow = await db.prepare("SELECT forwarding FROM users WHERE id = ?").bind(alias.user_id).first<{ forwarding: number }>();
  if (!userRow || userRow.forwarding === 0) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "user_forwarding_disabled", ts: now });
    return;
  }

  const rules = await q.listBlocks(db, alias.id, alias.domain_id, alias.user_id);
  if (evaluateSenderRules(rules, message.from) === "block") {
    await q.insertEvent(db, { alias_id: alias.id, type: "block", external_sender: message.from, ts: now });
    await q.incCounter(db, alias.id, "blocked_count");
    await pushBlocked(env, alias.user_id, alias.full_address, message.from);
    return;
  }

  // Read rate limits from DB settings (falls back to hardcoded defaults)
  const rateLimitAlias = await getNumericSetting(db, "rate_limit_per_alias");
  const rateLimitGlobal = await getNumericSetting(db, "rate_limit_global");
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
  let dest = await decryptDestination(encDest, env.DESTINATION_ENCRYPTION_KEY);
  
  if (dest === "global") {
    const globalDestRow = await db.prepare("SELECT * FROM destinations WHERE user_id = ? AND is_default = 1").bind(domain.user_id).first<import("../types").DestinationRow>();
    if (!globalDestRow) {
      await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "no_destination", ts: now });
      return;
    }
    // Suppression check for global (default) destination
    if (globalDestRow.suppressed_at) {
      await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "suppressed", ts: now });
      return;
    }
    dest = await decryptDestination(globalDestRow.email, env.DESTINATION_ENCRYPTION_KEY);
  } else {
    // Suppression check for named destination: look up by encrypted email hash
    const destHash = await hashDestination(dest.toLowerCase(), env.DESTINATION_ENCRYPTION_KEY);
    const destRow = await db.prepare("SELECT suppressed_at FROM destinations WHERE email_hash = ? AND user_id = ?").bind(destHash, alias.user_id).first<{ suppressed_at: number | null }>();
    if (destRow?.suppressed_at) {
      await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "suppressed", ts: now });
      return;
    }
  }

  // Reserve before either SES path. The atomic predicate includes completed
  // forward/reply events and every active forward/reply reservation.
  const reservationId = delivery?.id ?? crypto.randomUUID();
  const reservationToken = crypto.randomUUID();
  const reservation = await q.reserveMailQuota(db, {
    id: reservationId, token: reservationToken, kind: "forward", aliasId: alias.id,
    recipient: message.from, now, aliasCap: rateLimitAlias, globalCap: rateLimitGlobal, distinctCap: -1,
    deliveryToken: delivery?.token,
  });
  if (reservation === "cap") {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "rate", ts: now });
    return;
  }
  if (reservation === "sending") throw new Error("Mail send in flight");

  const reverseAddr = reverseAddress(localPart, message.from, domainName);
  // Suppress inline actions when alias is in over-quota grace: replies are
  // already blocked, mute is meaningless, disable defeats the recovery window.
  let inlineActionsEnabled = false;
  let toolbarPosition: "header" | "footer" = "footer";
  if (alias.source !== "auto_over_quota") {
    const prefRow = await db.prepare("SELECT inline_actions_pref, inline_actions_position FROM users WHERE id = ?")
      .bind(alias.user_id).first<{ inline_actions_pref: string | null; inline_actions_position: string | null }>();
    // Resolution: subdomain pref > user pref > global default. A subdomain is a
    // mail category, so its setting is more specific than the user-wide one.
    const effectivePref = domain.inline_actions_pref ?? prefRow?.inline_actions_pref;
    if (effectivePref === "on") {
      inlineActionsEnabled = true;
    } else if (effectivePref === "off") {
      inlineActionsEnabled = false;
    } else {
      inlineActionsEnabled = await getBoolSetting(db, "inline_actions_default_enabled");
    }
    const userPos = prefRow?.inline_actions_position;
    const resolvedPos = userPos ?? await getSetting(db, "inline_actions_default_position");
    if (resolvedPos === "header" || resolvedPos === "footer") {
      toolbarPosition = resolvedPos;
    }
  }

  const rawBytes = await streamToBytes(message.raw, maxInboundBytes);
  if (alias.source !== "auto_over_quota" && !inlineActionsEnabled) {
    let mime = parseMime(rawBytes);
    const origFrom = getHeader(mime, "From") ?? message.from;
    const senderName = extractDisplayName(origFrom);
    const format = await getSetting(db, "forwarded_from_format");
    const display = buildForwardedFromDisplay(senderName, message.from, format);
    const fromHeader = `"${sanitize(display)}" <${alias.full_address}>`;

    mime = setHeader(mime, "From", fromHeader);
    mime = setHeader(mime, "Reply-To", reverseAddr);
    // Keep the receiving hop's auth results readable for debugging, but under
    // our own name — recipients must never trust a foreign Authentication-Results.
    const origAuthResults = getHeader(mime, "Authentication-Results");
    mime = removeHeaders(mime, ["DKIM-Signature", "ARC-Seal", "ARC-Message-Signature", "ARC-Authentication-Results", "Authentication-Results", "Return-Path", "Sender"]);
    if (origAuthResults) mime = setHeader(mime, "X-HideMyEmail-Authentication-Results", origAuthResults);
    if (flagSpam) mime = setHeader(mime, "X-Spam-Flag", "YES");
    if (flagVirus) mime = setHeader(mime, "X-HideMyEmail-Virus", "detected");
    // Internal-only forwarding metadata. Prefixed with X-HideMyEmail- so
    // recipient spam filters don't recognise these as the generic forwarder
    // / open-relay headers (X-Reinjected, X-Forwarded-For, X-Original-From)
    // that classifiers learn to penalise. X-Reinjected is dropped entirely:
    // nothing in the router uses it for loop detection.
    mime = setHeader(mime, "X-HideMyEmail-Forwarded-For", message.from);
    mime = setHeader(mime, "X-HideMyEmail-Forwarded-To", message.to);
    mime = setHeader(mime, "X-HideMyEmail-Original-From", origFrom);

    // List-Unsubscribe on person-to-person mail makes it look like bulk mail
    // to spam filters, so "bulk_only" (default) only replaces an unsubscribe
    // surface the original message already had. Admin can pick always/never.
    if (await shouldAddUnsubscribe(db, getHeader(mime, "List-Unsubscribe"), getHeader(mime, "Precedence"))) {
      const { signAction } = await import("./action");
      const disableSig = await signAction("disable", String(alias.id), env);
      const actionEmail = `action+disable=${alias.id}_${disableSig}@${domainName}`;
      const mainGlobalDomain = await getMainGlobalDomain(db, env);
      const unsubHttps = mainGlobalDomain
        ? `https://${mainGlobalDomain}/api/unsubscribe?a=${alias.id}&s=${disableSig}`
        : "";
      // RFC 8058 one-click: HTTPS form first so MUAs that support one-click
      // (Gmail, Outlook, Yahoo) hit a real URL instead of the mailto fallback,
      // which spam filters distrust when it carries an opaque local-part.
      mime = setHeader(mime, "List-Unsubscribe",
        unsubHttps ? `<${unsubHttps}>, <mailto:${actionEmail}>` : `<mailto:${actionEmail}>`);
      mime = setHeader(mime, "List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
    }

    const rawBase64 = toBase64(serializeMime(mime));
    let sesAccepted = reservation === "accepted";
    try {
      const sesAccessKeyId = await getEnvWithOverride(db, env, "ses_access_key_id");
      const sesSecretAccessKey = await getEnvWithOverride(db, env, "ses_secret_access_key");
      const sesRegion = await getEnvWithOverride(db, env, "ses_region");
      if (reservation !== "accepted") {
        if (delivery && !(await q.renewDelivery(db, delivery.id, delivery.token, Date.now()))) throw new Error("Delivery lease lost");
        if (!(await q.startMailSend(db, reservationId, reservationToken, Date.now()))) throw new Error("Reservation ownership lost");
        await ses(
          { accessKeyId: sesAccessKeyId, secretAccessKey: sesSecretAccessKey, region: sesRegion },
          { from: fromHeader, to: dest, rawBase64 }
        );
        sesAccepted = true;
        if (!(await q.markMailQuotaAccepted(db, reservationId, reservationToken))) throw new Error("Reservation ownership lost");
      }
    } catch (err) {
      await q.insertEvent(db, { alias_id: alias.id, type: "error", external_sender: message.from, detail: String(err), ts: now });
      if (err instanceof Error && (err.message === "Delivery lease lost" || err.message === "Reservation ownership lost")) throw err;
      if (err instanceof SesTransientError) throw err;
      if (!sesAccepted) await q.releaseMailQuota(db, reservationId, reservationToken);
      return;
    }

    if (!(await q.finishMailBookkeeping(db, { id: reservationId, token: reservationToken, aliasId: alias.id, kind: "forward", sender: message.from, subject: getHeader(mime, "Subject"), bytes: message.rawSize, now, deliveryToken: delivery?.token }))) throw new Error("Reservation ownership lost");
    // Push is noncritical and internally catches provider failures.
    await pushForward(env, alias.user_id, alias.full_address, message.from, getHeader(mime, "Subject"));
    return;
  }

  const parsedEmail = await PostalMime.parse(rawBytes);

  const msg = createMimeMessage();
  const findHeader = (name: string) =>
    parsedEmail.headers.find(h => h.key.toLowerCase() === name)?.value;
  const origListUnsubscribe = findHeader("list-unsubscribe");
  const origPrecedence = findHeader("precedence");
  // See parallel block in the no-toolbar path for rationale.
  const addOwnUnsubscribe = await shouldAddUnsubscribe(db, origListUnsubscribe, origPrecedence);
  const skipHeaders = [
    "return-path", "dkim-signature", "arc-seal", "arc-message-signature",
    "arc-authentication-results", "authentication-results", "sender", "content-type",
    "content-transfer-encoding", "mime-version", "from", "reply-to", "subject",
    "to", "cc", "bcc", "message-id", "date",
  ];
  if (addOwnUnsubscribe) {
    // Ours replaces the original; copying both through would emit duplicates.
    skipHeaders.push("list-unsubscribe", "list-unsubscribe-post");
  }
  for (const h of parsedEmail.headers) {
    const key = h.key.toLowerCase();
    if (key === "authentication-results") {
      // Same rationale as the no-toolbar path: keep for debugging, never
      // re-emit a foreign Authentication-Results under its trusted name.
      msg.setHeader("X-HideMyEmail-Authentication-Results", h.value);
      continue;
    }
    if (!skipHeaders.includes(key)) {
      msg.setHeader(h.key, h.value);
    }
  }
  if (flagSpam) msg.setHeader("X-Spam-Flag", "YES");
  if (flagVirus) msg.setHeader("X-HideMyEmail-Virus", "detected");

  if (parsedEmail.to?.length) {
    const list = parsedEmail.to.map(t => t.name ? `${t.name} <${t.address}>` : t.address).filter((x): x is string => !!x);
    if (list.length) msg.setRecipients(list, { type: 'To' });
  }
  if (parsedEmail.cc?.length) {
    const list = parsedEmail.cc.map(t => t.name ? `${t.name} <${t.address}>` : t.address).filter((x): x is string => !!x);
    if (list.length) msg.setRecipients(list, { type: 'Cc' });
  }
  if (parsedEmail.bcc?.length) {
    const list = parsedEmail.bcc.map(t => t.name ? `${t.name} <${t.address}>` : t.address).filter((x): x is string => !!x);
    if (list.length) msg.setRecipients(list, { type: 'Bcc' });
  }
  if (parsedEmail.messageId) msg.setHeader("Message-ID", parsedEmail.messageId);
  if (parsedEmail.date) msg.setHeader("Date", parsedEmail.date);

  let finalHtml = parsedEmail.html;
  let finalText = parsedEmail.text;

  if (alias.source === "auto_over_quota") {
    const { buildInlineWarningHtml, buildInlineWarningText } = await import("./warning");
    const warningHtml = buildInlineWarningHtml();
    const warningText = buildInlineWarningText();

    if (finalHtml) {
      if (finalHtml.toLowerCase().includes("<body")) {
        finalHtml = finalHtml.replace(/(<body[^>]*>)/i, `$1\n${warningHtml}\n`);
      } else {
        finalHtml = `${warningHtml}\n${finalHtml}`;
      }
    }

    if (finalText) {
      finalText = `${warningText}${finalText}`;
    }

    const subject = parsedEmail.subject || "";
    msg.setHeader("Subject", `[OVER QUOTA] ${subject}`);
    msg.setHeader("X-HideMyEmail-Warning", "Alias auto-created but you are over your quota.");
  } else {
    if (parsedEmail.subject) {
      msg.setHeader("Subject", parsedEmail.subject);
    }
  }

  if (inlineActionsEnabled) {
    const { buildToolbarLinks, buildToolbarHtml, buildToolbarText } = await import("./toolbar");
    const links = await buildToolbarLinks(alias.id, message.from, domainName, env);
    const anchor = toolbarPosition === "header" ? "top" : "bottom";
    const toolbarHtml = buildToolbarHtml(links, anchor);
    const toolbarText = buildToolbarText(links);

    if (finalHtml) {
      if (toolbarPosition === "header") {
        if (finalHtml.toLowerCase().includes("<body")) {
          finalHtml = finalHtml.replace(/(<body[^>]*>)/i, `$1\n${toolbarHtml}\n`);
        } else {
          finalHtml = `${toolbarHtml}\n${finalHtml}`;
        }
      } else {
        if (finalHtml.includes("</body>")) {
          finalHtml = finalHtml.replace(/<\/body>/i, `${toolbarHtml}\n</body>`);
        } else {
          finalHtml = `${finalHtml}\n${toolbarHtml}`;
        }
      }
    } else {
      finalHtml = toolbarHtml;
    }
    finalText = (finalText ?? "") + toolbarText;
    msg.setHeader("X-HideMyEmail-Actions", toolbarPosition);
  }

  const origFrom = parsedEmail.from?.address || message.from;
  const senderName = parsedEmail.from?.name || extractDisplayName(origFrom);
  const format = await getSetting(db, "forwarded_from_format");
  const display = buildForwardedFromDisplay(senderName, message.from, format);
  const fromHeader = `"${sanitize(display)}" <${alias.full_address}>`;
  
  msg.setSender({ name: sanitize(display), addr: alias.full_address });
  msg.setHeader("Reply-To", new Mailbox({ addr: reverseAddr }));
  // See parallel block above for rationale on these header names.
  msg.setHeader("X-HideMyEmail-Forwarded-For", message.from);
  msg.setHeader("X-HideMyEmail-Forwarded-To", message.to);
  msg.setHeader("X-HideMyEmail-Original-From", origFrom);

  if (addOwnUnsubscribe) {
    const { signAction } = await import("./action");
    const disableSig = await signAction("disable", String(alias.id), env);
    const actionEmail = `action+disable=${alias.id}_${disableSig}@${domainName}`;
    const mainGlobalDomainForUnsub = await getMainGlobalDomain(db, env);
    const unsubHttpsUrl = mainGlobalDomainForUnsub
      ? `https://${mainGlobalDomainForUnsub}/api/unsubscribe?a=${alias.id}&s=${disableSig}`
      : "";
    msg.setHeader("List-Unsubscribe",
      unsubHttpsUrl ? `<${unsubHttpsUrl}>, <mailto:${actionEmail}>` : `<mailto:${actionEmail}>`);
    msg.setHeader("List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
  }

  if (!finalText && !finalHtml) {
    finalText = " ";
  }

  if (finalText) msg.addMessage({ contentType: "text/plain", data: finalText });
  if (finalHtml) msg.addMessage({ contentType: "text/html", data: finalHtml });

  for (const att of parsedEmail.attachments) {
    const isInline = att.disposition === "inline" || att.contentId;
    const attData = typeof att.content === "string" ? new TextEncoder().encode(att.content) : new Uint8Array(att.content);
    msg.addAttachment({
      filename: att.filename || "attachment",
      contentType: att.mimeType,
      data: toBase64(attData),
      inline: !!isInline,
      headers: att.contentId ? { "Content-ID": att.contentId } : {}
    });
  }

  const rawBase64 = toBase64(new TextEncoder().encode(msg.asRaw()));

  let sesAccepted = reservation === "accepted";
  try {
    const sesAccessKeyId = await getEnvWithOverride(db, env, "ses_access_key_id");
    const sesSecretAccessKey = await getEnvWithOverride(db, env, "ses_secret_access_key");
    const sesRegion = await getEnvWithOverride(db, env, "ses_region");
    if (reservation !== "accepted") {
      if (delivery && !(await q.renewDelivery(db, delivery.id, delivery.token, Date.now()))) throw new Error("Delivery lease lost");
      if (!(await q.startMailSend(db, reservationId, reservationToken, Date.now()))) throw new Error("Reservation ownership lost");
      await ses(
        { accessKeyId: sesAccessKeyId, secretAccessKey: sesSecretAccessKey, region: sesRegion },
        { from: fromHeader, to: dest, rawBase64 }
      );
      sesAccepted = true;
      if (!(await q.markMailQuotaAccepted(db, reservationId, reservationToken))) throw new Error("Reservation ownership lost");
    }
  } catch (err) {
    await q.insertEvent(db, { alias_id: alias.id, type: "error", external_sender: message.from, detail: String(err), ts: now });
    if (err instanceof Error && (err.message === "Delivery lease lost" || err.message === "Reservation ownership lost")) throw err;
    if (err instanceof SesTransientError) throw err; // tempfail → sender retries
    if (!sesAccepted) await q.releaseMailQuota(db, reservationId, reservationToken);
    return;
  }

  if (!(await q.finishMailBookkeeping(db, { id: reservationId, token: reservationToken, aliasId: alias.id, kind: "forward", sender: message.from, subject: parsedEmail.subject, bytes: message.rawSize, now, deliveryToken: delivery?.token }))) throw new Error("Reservation ownership lost");
  // Push is noncritical and internally catches provider failures.
  await pushForward(env, alias.user_id, alias.full_address, message.from, parsedEmail.subject);
}

async function checkCooldown(db: D1Database, key: string, cooldownHours: number): Promise<boolean> {
  const now = Date.now();
  const row = await db.prepare("SELECT reset_at FROM rate_limits WHERE ip = ?").bind(key).first<{ reset_at: number }>();
  if (row && row.reset_at > now) return false;
  if (row) {
    await db.prepare("UPDATE rate_limits SET reset_at = ? WHERE ip = ?").bind(now + cooldownHours * 3600_000, key).run();
  } else {
    await db.prepare("INSERT INTO rate_limits (ip, attempts, reset_at) VALUES (?, 1, ?)").bind(key, now + cooldownHours * 3600_000).run();
  }
  return true;
}

async function sendSystemNotification(db: D1Database, env: Env, to: string, subject: string, heading: string, bodyText: string) {
  const { buildNotificationEmail } = await import("../lib/emails");
  const mainGlobalDomain = await getMainGlobalDomain(db, env) || "example.com";
  const rawBase64 = buildNotificationEmail(to, subject, heading, bodyText, mainGlobalDomain);
  const sesAccessKeyId = await getEnvWithOverride(db, env, "ses_access_key_id");
  const sesSecretAccessKey = await getEnvWithOverride(db, env, "ses_secret_access_key");
  const sesRegion = await getEnvWithOverride(db, env, "ses_region");
  const ses: SesSend = (env as any).__sesSend ?? sendRaw;
  try {
    await ses(
      { accessKeyId: sesAccessKeyId, secretAccessKey: sesSecretAccessKey, region: sesRegion },
      { from: `HideMyEmail <noreply@${mainGlobalDomain}>`, to, rawBase64 }
    );
  } catch (err) {
    console.error("Failed to send system notification", err);
  }
}

function splitAddress(addr: string): [string, string] {
  const at = addr.lastIndexOf("@");
  return [addr.slice(0, at).toLowerCase(), addr.slice(at + 1).toLowerCase()];
}

async function shouldAddUnsubscribe(
  db: D1Database,
  origListUnsubscribe: string | undefined,
  origPrecedence: string | undefined,
): Promise<boolean> {
  const mode = await getSetting(db, "unsubscribe_header_mode");
  if (mode === "always") return true;
  if (mode === "never") return false;
  const precedence = (origPrecedence ?? "").trim().toLowerCase();
  return !!origListUnsubscribe || precedence === "bulk" || precedence === "list";
}
