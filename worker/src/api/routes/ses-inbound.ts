import { Hono } from "hono";
import type { AppEnv } from "../app";
import { routeEmail } from "../../email/router";
import { fetchS3Object } from "../../lib/s3";
import { getEnvWithOverride } from "../../lib/settings";
import { getNumericSetting } from "../../lib/settings";
import { readSnsJson, verifySnsMessage } from "../../lib/sns";
import { BodyTooLargeError } from "../../lib/bytes";
import { SesTransientError } from "../../lib/ses";
import * as q from "../../db/queries";

export function sesInboundRoutes() {
  const r = new Hono<AppEnv>();

  r.post("/ses/inbound", async (c) => {
    const parsedBody = await readSnsJson(c.req.raw);
    if (parsedBody.tooLarge) return c.json({ error: "Body too large" }, 413);
    const body = parsedBody.body as any;
    if (!body) return c.json({ error: "Bad body" }, 400);

    const sesRegion = await getEnvWithOverride(c.env.DB, c.env, "ses_region");
    const verified = await verifySnsMessage(body, {
      region: sesRegion,
      fetchCert: (c.env as any).__snsCertFetch ?? fetch,
    });
    if (!verified.ok) return c.json({ error: "Invalid sns signature" }, 401);

    // Guard: only accept the configured inbound SNS topic.
    const snsInboundTopic = await getEnvWithOverride(c.env.DB, c.env, "sns_inbound_topic_arn");
    if (!snsInboundTopic) return c.json({ error: "Missing SNS_INBOUND_TOPIC_ARN configuration" }, 500);
    if (body.TopicArn !== snsInboundTopic) {
      return c.json({ error: "Forbidden topic" }, 403);
    }

    // SNS subscription handshake — log URL for manual confirmation
    if (body.Type === "SubscriptionConfirmation") {
      const subscribeUrl = body.SubscribeURL;
      if (typeof subscribeUrl !== "string" || !/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//i.test(subscribeUrl)) {
        return c.json({ error: "Invalid subscribe url" }, 400);
      }
      const safeUrl = new URL(subscribeUrl);
      console.log("SNS inbound subscription auto-confirming", `${safeUrl.origin}${safeUrl.pathname}`);
      
      // Auto-confirm the subscription so you don't have to check logs
      const confirmFetch: typeof fetch = (c.env as any).__snsConfirmFetch ?? fetch;
      try {
        c.executionCtx.waitUntil(confirmFetch(subscribeUrl).catch(err => console.error("Auto-confirm failed:", err)));
      } catch (e) {
        // Fallback for tests or environments without executionCtx
        void confirmFetch(subscribeUrl).catch(err => console.error("Auto-confirm failed:", err));
      }
      
      return c.json({ ok: true });
    }

    if (body.Type !== "Notification") return c.json({ ok: true });

    let msg: any;
    try {
      msg = JSON.parse(body.Message);
    } catch {
      return c.json({ error: "Invalid Message JSON" }, 400);
    }

    // Only process inbound email receipts; ignore bounce/complaint/etc
    if (msg.notificationType !== "Received") return c.json({ ok: true });

    const to: string | undefined = msg.receipt?.recipients?.[0];
    const from: string | undefined = msg.mail?.source;
    const messageId: string | undefined = msg.mail?.messageId;
    if (!to || !from || !messageId) {
      return c.json({ error: "Missing required fields" }, 400);
    }

    // The SES message identity survives SNS republishing under a new MessageId.
    // Use it for the delivery and quota reservation so accepted sends can resume
    // bookkeeping without rekeying related durable rows.
    const deliveryId = `ses:${messageId}`;
    const claim = await q.claimDelivery(c.env.DB, deliveryId, "inbound", Date.now(), deliveryId);
    if (claim.status !== "claimed") {
      return claim.status === "completed" ? c.json({ ok: true }) : c.json({ error: "Already processing" }, 503);
    }

    // SES receipt verdicts — spf/dmarc gate reverse-alias replies (anti-spoof);
    // spam/virus gate inbound forwards (sender-reputation protection).
    const auth = {
      spf: msg.receipt?.spfVerdict?.status as string | undefined,
      dmarc: msg.receipt?.dmarcVerdict?.status as string | undefined,
      spam: msg.receipt?.spamVerdict?.status as string | undefined,
      virus: msg.receipt?.virusVerdict?.status as string | undefined,
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
      const maxInboundBytes = await getNumericSetting(c.env.DB, "max_inbound_bytes");
      raw = await s3Fetch(creds, s3InboundBucket, messageId, undefined, maxInboundBytes);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return (await q.completeDelivery(c.env.DB, deliveryId, claim.token, Date.now()))
          ? c.json({ ok: true })
          : c.json({ error: "Delivery lease lost" }, 503);
      }
      await q.releaseDelivery(c.env.DB, deliveryId, claim.token);
      console.error("S3 fetch failed for", messageId, String(err));
      return c.json({ error: "S3 unavailable" }, 500); // 5xx → SNS retries for up to 23 days
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
      await routeEmail(fakeMessage, c.env, undefined, auth, { id: deliveryId, token: claim.token });
    } catch (err) {
      // A timeout/network failure may have reached SES. Keep both the delivery
      // claim and sending fence until their deadline prevents an immediate,
      // potentially duplicate send on SNS retry.
      if (!(err instanceof SesTransientError)) await q.releaseDelivery(c.env.DB, deliveryId, claim.token);
      console.error("routeEmail failed for", messageId, String(err));
      return c.json({ error: "Processing failed" }, 500); // 5xx → SNS retries
    }

    const completed = await c.env.DB.prepare("SELECT state FROM mail_deliveries WHERE external_id=? AND claim_token=?")
      .bind(deliveryId, claim.token).first<{ state: string }>();
    if (completed?.state !== "completed" && !(await q.completeDelivery(c.env.DB, deliveryId, claim.token, Date.now()))) {
      return c.json({ error: "Delivery lease lost" }, 503);
    }

    return c.json({ ok: true });
  });

  return r;
}
