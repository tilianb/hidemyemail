import type { Env } from "../types";
import * as q from "../db/queries";
import PostalMime from "postal-mime";
import { createMimeMessage, Mailbox } from "mimetext";
import { evaluateSenderRules } from "../lib/blocks";
import { streamToBytes, toBase64 } from "../lib/bytes";
import { parseMime, setHeader, removeHeaders, getHeader, serializeMime } from "../lib/mime";
import { reverseAddress } from "../lib/reverse";
import { sendRaw, SesTransientError } from "../lib/ses";
import { getNumericSetting, getBoolSetting, getEnvWithOverride, getSetting, getMainGlobalDomain } from "../lib/settings";
import { decryptDestination } from "../lib/crypto";
import { extractDisplayName, sanitizeDisplay as sanitize, buildForwardedFromDisplay } from "../lib/from-format";

type SesSend = typeof sendRaw;

export async function handleInbound(message: ForwardableEmailMessage, env: Env): Promise<void> {
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

  const userRow = await db.prepare("SELECT forwarding FROM users WHERE id = ?").bind(alias.user_id).first<{ forwarding: number }>();
  if (!userRow || userRow.forwarding === 0) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "user_forwarding_disabled", ts: now });
    return;
  }

  const rules = await q.listBlocks(db, alias.id, alias.domain_id, alias.user_id);
  if (evaluateSenderRules(rules, message.from) === "block") {
    await q.insertEvent(db, { alias_id: alias.id, type: "block", external_sender: message.from, ts: now });
    await q.incCounter(db, alias.id, "blocked_count");
    return;
  }

  // Read rate limits from DB settings (falls back to hardcoded defaults)
  const rateLimitAlias = await getNumericSetting(db, "rate_limit_per_alias");
  const rateLimitGlobal = await getNumericSetting(db, "rate_limit_global");
  const aliasCount = await q.countEventsSince(db, alias.id, now - 3600_000);
  const globalCount = await q.countEventsSince(db, null, now - 3600_000);
  if ((rateLimitAlias >= 0 && aliasCount >= rateLimitAlias) || (rateLimitGlobal >= 0 && globalCount >= rateLimitGlobal)) {
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
    const { hashDestination } = await import("../lib/crypto");
    const destHash = await hashDestination(dest.toLowerCase(), env.DESTINATION_ENCRYPTION_KEY);
    let destRow: { suppressed_at: number | null } | null = null;
    try {
      destRow = await db.prepare("SELECT suppressed_at FROM destinations WHERE email_hash = ? AND user_id = ?").bind(destHash, alias.user_id).first<{ suppressed_at: number | null }>();
    } catch (err: any) {
      if (!String(err?.message ?? err).includes("no such column")) throw err;
    }
    if (destRow?.suppressed_at) {
      await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "suppressed", ts: now });
      return;
    }
  }

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

  const rawBytes = await streamToBytes(message.raw);
  if (alias.source !== "auto_over_quota" && !inlineActionsEnabled) {
    let mime = parseMime(rawBytes);
    const origFrom = getHeader(mime, "From") ?? message.from;
    const senderName = extractDisplayName(origFrom);
    const format = await getSetting(db, "forwarded_from_format");
    const display = buildForwardedFromDisplay(senderName, message.from, format);
    const fromHeader = `"${sanitize(display)}" <${alias.full_address}>`;

    mime = setHeader(mime, "From", fromHeader);
    mime = setHeader(mime, "Reply-To", reverseAddr);
    mime = removeHeaders(mime, ["DKIM-Signature", "ARC-Seal", "ARC-Message-Signature", "ARC-Authentication-Results", "Return-Path", "Sender"]);
    // Internal-only forwarding metadata. Prefixed with X-HideMyEmail- so
    // recipient spam filters don't recognise these as the generic forwarder
    // / open-relay headers (X-Reinjected, X-Forwarded-For, X-Original-From)
    // that classifiers learn to penalise. X-Reinjected is dropped entirely:
    // nothing in the router uses it for loop detection.
    mime = setHeader(mime, "X-HideMyEmail-Forwarded-For", message.from);
    mime = setHeader(mime, "X-HideMyEmail-Forwarded-To", message.to);
    mime = setHeader(mime, "X-HideMyEmail-Original-From", origFrom);

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

    const rawBase64 = toBase64(serializeMime(mime));
    try {
      const sesAccessKeyId = await getEnvWithOverride(db, env, "ses_access_key_id");
      const sesSecretAccessKey = await getEnvWithOverride(db, env, "ses_secret_access_key");
      const sesRegion = await getEnvWithOverride(db, env, "ses_region");
      await ses(
        { accessKeyId: sesAccessKeyId, secretAccessKey: sesSecretAccessKey, region: sesRegion },
        { from: fromHeader, to: dest, rawBase64 }
      );
    } catch (err) {
      await q.insertEvent(db, { alias_id: alias.id, type: "error", external_sender: message.from, detail: String(err), ts: now });
      if (err instanceof SesTransientError) throw err;
      return;
    }

    await q.insertEvent(db, { alias_id: alias.id, type: "forward", external_sender: message.from, subject: getHeader(mime, "Subject"), bytes: message.rawSize, ts: now });
    await q.incCounter(db, alias.id, "fwd_count");
    return;
  }

  const parsedEmail = await PostalMime.parse(rawBytes);

  const msg = createMimeMessage();
  const skipHeaders = [
    "return-path", "dkim-signature", "arc-seal", "arc-message-signature",
    "arc-authentication-results", "sender", "content-type", "content-transfer-encoding",
    "mime-version", "from", "reply-to", "subject", "to", "cc", "bcc", "message-id", "date"
  ];
  for (const h of parsedEmail.headers) {
    if (!skipHeaders.includes(h.key.toLowerCase())) {
      msg.setHeader(h.key, h.value);
    }
  }

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

  try {
    const sesAccessKeyId = await getEnvWithOverride(db, env, "ses_access_key_id");
    const sesSecretAccessKey = await getEnvWithOverride(db, env, "ses_secret_access_key");
    const sesRegion = await getEnvWithOverride(db, env, "ses_region");
    await ses(
      { accessKeyId: sesAccessKeyId, secretAccessKey: sesSecretAccessKey, region: sesRegion },
      { from: fromHeader, to: dest, rawBase64 }
    );
  } catch (err) {
    await q.insertEvent(db, { alias_id: alias.id, type: "error", external_sender: message.from, detail: String(err), ts: now });
    if (err instanceof SesTransientError) throw err; // tempfail → sender retries
    return;
  }

  await q.insertEvent(db, { alias_id: alias.id, type: "forward", external_sender: message.from, subject: parsedEmail.subject, bytes: message.rawSize, ts: now });
  await q.incCounter(db, alias.id, "fwd_count");
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
