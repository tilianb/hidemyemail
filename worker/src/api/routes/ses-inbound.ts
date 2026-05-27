import { Hono } from "hono";
import type { AppEnv } from "../app";
import { routeEmail } from "../../email/router";
import { fetchS3Object } from "../../lib/s3";
import { getEnvWithOverride } from "../../lib/settings";
import { verifySnsMessage } from "../../lib/sns";

export function sesInboundRoutes() {
  const r = new Hono<AppEnv>();

  r.post("/ses/inbound", async (c) => {
    const body = await c.req.json<any>().catch(() => null);
    if (!body) return c.json({ error: "bad body" }, 400);

    const sesRegion = await getEnvWithOverride(c.env.DB, c.env, "ses_region");
    const verified = await verifySnsMessage(body, {
      region: sesRegion,
      fetchCert: (c.env as any).__snsCertFetch ?? fetch,
    });
    if (!verified.ok) return c.json({ error: "invalid sns signature" }, 401);

    // Guard: only accept the configured inbound SNS topic.
    const snsInboundTopic = await getEnvWithOverride(c.env.DB, c.env, "sns_inbound_topic_arn");
    if (!snsInboundTopic) return c.json({ error: "missing SNS_INBOUND_TOPIC_ARN configuration" }, 500);
    if (body.TopicArn !== snsInboundTopic) {
      return c.json({ error: "forbidden topic" }, 403);
    }

    // SNS subscription handshake — log URL for manual confirmation
    if (body.Type === "SubscriptionConfirmation") {
      const subscribeUrl = body.SubscribeURL;
      if (typeof subscribeUrl !== "string" || !/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//i.test(subscribeUrl)) {
        return c.json({ error: "invalid subscribe url" }, 400);
      }
      console.log("SNS inbound SubscribeURL (auto-confirming):", subscribeUrl);
      
      // Auto-confirm the subscription so you don't have to check logs
      try {
        c.executionCtx.waitUntil(fetch(subscribeUrl).catch(err => console.error("Auto-confirm failed:", err)));
      } catch (e) {
        // Fallback for tests or environments without executionCtx
        fetch(subscribeUrl).catch(err => console.error("Auto-confirm failed:", err));
      }
      
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
    const sesAccessKeyId = await getEnvWithOverride(c.env.DB, c.env, "ses_access_key_id");
    const sesSecretAccessKey = await getEnvWithOverride(c.env.DB, c.env, "ses_secret_access_key");
    const s3InboundBucket = await getEnvWithOverride(c.env.DB, c.env, "s3_inbound_bucket");
    
    const creds = {
      accessKeyId: sesAccessKeyId,
      secretAccessKey: sesSecretAccessKey,
      region: sesRegion,
    };
    const s3Fetch = (c.env as any).__s3Fetch ?? fetchS3Object;
    let raw: Uint8Array;
    try {
      raw = await s3Fetch(creds, s3InboundBucket, messageId);
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
