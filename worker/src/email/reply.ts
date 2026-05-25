import type { Env } from "../types";
import * as q from "../db/queries";
import { streamToBytes, toBase64 } from "../lib/bytes";
import { parseMime, setHeader, removeHeaders, getHeader, serializeMime } from "../lib/mime";
import { sendRaw, SesTransientError } from "../lib/ses";

type SesSend = typeof sendRaw;

export async function handleReply(message: ForwardableEmailMessage, env: Env, token: string): Promise<void> {
  const db = env.DB;
  const ses: SesSend = (env as any).__sesSend ?? sendRaw;
  const now = Date.now();

  const reverse = await q.getReverseByToken(db, token);
  if (!reverse) return;

  const owners = await q.ownerDestinations(db);
  if (!owners.has(message.from.toLowerCase())) {
    await q.insertEvent(db, { alias_id: reverse.alias_id, type: "reject", external_sender: message.from, detail: "not_owner", ts: now });
    return;
  }

  const alias = await db.prepare("SELECT full_address FROM aliases WHERE id = ?").bind(reverse.alias_id).first<{ full_address: string }>();
  if (!alias) return;

  const raw = await streamToBytes(message.raw);
  let mime = parseMime(raw);
  const subject = getHeader(mime, "Subject") ?? "";
  mime = removeHeaders(mime, ["From", "Sender", "Reply-To", "Return-Path", "DKIM-Signature", "Message-ID", "X-Reinjected", "Received"]);
  mime = setHeader(mime, "From", alias.full_address);
  mime = setHeader(mime, "To", reverse.external_sender);
  mime = setHeader(mime, "Message-ID", `<${crypto.randomUUID()}@${alias.full_address.split("@")[1]}>`);

  const rawBase64 = toBase64(serializeMime(mime));
  try {
    await ses(
      { accessKeyId: env.SES_ACCESS_KEY_ID, secretAccessKey: env.SES_SECRET_ACCESS_KEY, region: env.SES_REGION },
      { from: alias.full_address, to: reverse.external_sender, rawBase64 }
    );
  } catch (err) {
    await q.insertEvent(db, { alias_id: reverse.alias_id, type: "error", detail: String(err), ts: now });
    if (err instanceof SesTransientError) throw err;
    return;
  }

  await q.touchReverse(db, reverse.id);
  await q.insertEvent(db, { alias_id: reverse.alias_id, type: "reply", external_sender: reverse.external_sender, subject, ts: now });
  await q.incCounter(db, reverse.alias_id, "reply_count");
}
