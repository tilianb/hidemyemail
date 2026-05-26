import { Hono } from "hono";
import type { AppEnv } from "../app";
import { routeEmail } from "../../email/router";
import { fetchS3Object } from "../../lib/s3";
import { timingSafeEqual } from "../../lib/auth";

export function sesInboundRoutes() {
  const r = new Hono<AppEnv>();

  r.post("/ses/inbound", async (c) => {
    const body = await c.req.json<any>().catch(() => null);
    if (!body) return c.json({ error: "bad body" }, 400);

    // Webhook authentication — SNS_SECRET must be set
    const secret = c.req.header("x-webhook-secret") || c.req.query("secret") || "";
    if (!c.env.SNS_SECRET || !timingSafeEqual(secret, c.env.SNS_SECRET)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    // Guard: only accept the configured inbound SNS topic(s)
    // We allow passing an additional allowed_topic via query string to make branch preview testing easier.
    const allowedTopics = [c.env.SNS_INBOUND_TOPIC_ARN, c.req.query("allowed_topic")].filter(Boolean);
    if (allowedTopics.length > 0 && !allowedTopics.includes(body.TopicArn)) {
      return c.json({ error: "forbidden topic" }, 403);
    }

    // SNS subscription handshake — log URL for manual confirmation
    if (body.Type === "SubscriptionConfirmation") {
      const subscribeUrl = body.SubscribeURL;
      if (typeof subscribeUrl !== "string" || !/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//i.test(subscribeUrl)) {
        return c.json({ error: "invalid subscribe url" }, 400);
      }
      console.log("SNS inbound SubscribeURL (confirm manually):", subscribeUrl);
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

    // SES receipt verdicts — used as the anti-spoof gate for reverse-alias replies.
    const auth = {
      spf: msg.receipt?.spfVerdict?.status as string | undefined,
      dmarc: msg.receipt?.dmarcVerdict?.status as string | undefined,
    };

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
      // routeEmail dispatches reverse-alias replies → handleReply, everything else → handleInbound.
      await routeEmail(fakeMessage, c.env, undefined, auth);
    } catch (err) {
      console.error("routeEmail failed for", messageId, String(err));
      return c.json({ error: "processing failed" }, 500); // 5xx → SNS retries
    }

    return c.json({ ok: true });
  });

  return r;
}
