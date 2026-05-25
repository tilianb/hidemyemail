import type { Env, ParsedReverse, ReplyAuth } from "../types";
import * as q from "../db/queries";
import { streamToBytes, toBase64 } from "../lib/bytes";
import { parseMime, setHeader, removeHeaders, getHeader, serializeMime } from "../lib/mime";
import { sendRaw, SesTransientError } from "../lib/ses";

type SesSend = typeof sendRaw;

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

  // SECURITY: reverse addresses are self-describing and therefore guessable (no random
  // token). The relay gate is: (1) envelope sender ∈ owner destinations, AND (2) SES
  // SPF/DMARC verdict PASS so that owner address cannot be spoofed. Fail closed.
  const owners = await q.ownerDestinations(db);
  const fromOwner = owners.has(message.from.toLowerCase());
  const authOk = !auth || auth.spf === "PASS" || auth.dmarc === "PASS";
  if (!fromOwner || !authOk) {
    await q.insertEvent(db, {
      alias_id: alias.id, type: "reject", external_sender: parsed.externalSender,
      detail: fromOwner ? "spf" : "not_owner", ts: now,
    });
    return;
  }

  const raw = await streamToBytes(message.raw);
  let mime = parseMime(raw);
  const subject = getHeader(mime, "Subject") ?? "";
  mime = removeHeaders(mime, ["From", "Sender", "Reply-To", "Return-Path", "DKIM-Signature", "Message-ID", "X-Reinjected", "Received"]);
  mime = setHeader(mime, "From", alias.full_address);
  mime = setHeader(mime, "To", parsed.externalSender);
  mime = setHeader(mime, "Message-ID", `<${crypto.randomUUID()}@${domainName}>`);

  const rawBase64 = toBase64(serializeMime(mime));
  try {
    await ses(
      { accessKeyId: env.SES_ACCESS_KEY_ID, secretAccessKey: env.SES_SECRET_ACCESS_KEY, region: env.SES_REGION },
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
