import type { Env } from "../types";
import * as q from "../db/queries";
import { isBlocked } from "../lib/blocks";
import { streamToBytes, toBase64 } from "../lib/bytes";
import { parseMime, setHeader, removeHeaders, getHeader, serializeMime } from "../lib/mime";
import { reverseAddress } from "../lib/reverse";
import { sendRaw, SesTransientError } from "../lib/ses";
import { RATE_PER_HOUR_ALIAS, RATE_PER_HOUR_GLOBAL, MAX_INBOUND_BYTES } from "../config";

type SesSend = typeof sendRaw;

export async function handleInbound(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const db = env.DB;
  const ses: SesSend = (env as any).__sesSend ?? sendRaw;
  const now = Date.now();
  const [localPart, domainName] = splitAddress(message.to);

  const domain = await q.getDomain(db, domainName);
  if (!domain || domain.active === 0) return;

  const alias = await q.autoCreateAlias(db, domain.id, localPart, message.to.toLowerCase());

  if (alias.active === 0) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "disabled", ts: now });
    return;
  }

  const rules = await q.listBlocks(db, alias.id);
  if (isBlocked(rules, message.from)) {
    await q.insertEvent(db, { alias_id: alias.id, type: "block", external_sender: message.from, ts: now });
    await q.incCounter(db, alias.id, "blocked_count");
    return;
  }

  const aliasCount = await q.countEventsSince(db, alias.id, now - 3600_000);
  const globalCount = await q.countEventsSince(db, null, now - 3600_000);
  if (aliasCount >= RATE_PER_HOUR_ALIAS || globalCount >= RATE_PER_HOUR_GLOBAL) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "rate", ts: now });
    return;
  }

  if (message.rawSize > MAX_INBOUND_BYTES) {
    await q.insertEvent(db, { alias_id: alias.id, type: "reject", external_sender: message.from, detail: "too_large", ts: now });
    return;
  }

  const dest = alias.destination ?? domain.default_destination;
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
  const rawBase64 = toBase64(serializeMime(mime));

  try {
    await ses(
      { accessKeyId: env.SES_ACCESS_KEY_ID, secretAccessKey: env.SES_SECRET_ACCESS_KEY, region: env.SES_REGION },
      { from: reverseAddr, to: dest, rawBase64 }
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
