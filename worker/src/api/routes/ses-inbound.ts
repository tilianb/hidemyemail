import { Hono } from "hono";
import type { AppEnv } from "../app";
import { handleInbound } from "../../email/inbound";
import { fetchS3Object } from "../../lib/s3";

export function sesInboundRoutes() {
  const r = new Hono<AppEnv>();

  r.post("/ses/inbound", async (c) => {
    const body = await c.req.json<any>().catch(() => null);
    if (!body) return c.json({ error: "bad body" }, 400);

    // Guard: only accept the configured inbound SNS topic
    if (c.env.SNS_INBOUND_TOPIC_ARN && body.TopicArn !== c.env.SNS_INBOUND_TOPIC_ARN) {
      return c.json({ error: "forbidden topic" }, 403);
    }

    // SNS subscription handshake — log URL for manual confirmation
    if (body.Type === "SubscriptionConfirmation") {
      console.log("SNS inbound SubscribeURL:", body.SubscribeURL);
      return c.json({ ok: true });
    }

    if (body.Type !== "Notification") return c.json({ ok: true });

    let msg: any;
    try {
      msg = JSON.parse(body.Message);
    } catch {
      return c.json({ error: "invalid Message JSON" }, 400);
    }

    // Only process inbound email receipts; ignore bounce/complaint/etc
    if (msg.notificationType !== "Received") return c.json({ ok: true });

    const to: string | undefined = msg.receipt?.recipients?.[0];
    const from: string | undefined = msg.mail?.source;
    const messageId: string | undefined = msg.mail?.messageId;
    if (!to || !from || !messageId) {
      return c.json({ error: "missing required fields" }, 400);
    }

    // Fetch full raw MIME from S3 (supports emails of any size, no SNS 256KB truncation risk)
    const creds = {
      accessKeyId: c.env.SES_ACCESS_KEY_ID,
      secretAccessKey: c.env.SES_SECRET_ACCESS_KEY,
      region: c.env.SES_REGION,
    };
    const s3Fetch = (c.env as any).__s3Fetch ?? fetchS3Object;
    let raw: Uint8Array;
    try {
      raw = await s3Fetch(creds, c.env.S3_INBOUND_BUCKET, messageId);
    } catch (err) {
      console.error("S3 fetch failed for", messageId, String(err));
      return c.json({ error: "s3 unavailable" }, 500); // 5xx → SNS retries for up to 23 days
    }

    // Wrap bytes in a minimal ForwardableEmailMessage for handleInbound()
    // handleInbound() only uses: to, from, rawSize, raw — the rest are stubs
    const rawStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(raw);
        controller.close();
      },
    });
    const fakeMessage = {
      to,
      from,
      rawSize: raw.length,
      raw: rawStream,
      headers: new Headers(),
      setReject: (_code: number, _reason: string) => {},
      forward: async (_addr: string) => {},
      reply: async (_body: Uint8Array) => {},
    } as unknown as ForwardableEmailMessage;

    try {
      await handleInbound(fakeMessage, c.env);
    } catch (err) {
      console.error("handleInbound failed for", messageId, String(err));
      return c.json({ error: "processing failed" }, 500); // 5xx → SNS retries
    }

    return c.json({ ok: true });
  });

  return r;
}
