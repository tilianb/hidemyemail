import { Hono } from "hono";
import type { AppEnv } from "../app";
import { getEnvWithOverride } from "../../lib/settings";
import { verifySnsMessage } from "../../lib/sns";

// SNS posts JSON (often Content-Type text/plain). We verify SNS signatures,
// validate TopicArn, and log SubscribeURL for one-time manual confirmation.
export function sesWebhookRoutes() {
  const r = new Hono<AppEnv>();
  r.post("/ses/notification", async (c) => {
    const body = await c.req.json<any>().catch(() => null);
    if (!body) return c.json({ error: "Bad body" }, 400);

    const sesRegion = await getEnvWithOverride(c.env.DB, c.env, "ses_region");
    const verified = await verifySnsMessage(body, {
      region: sesRegion,
      fetchCert: (c.env as any).__snsCertFetch ?? fetch,
    });
    if (!verified.ok) return c.json({ error: "Invalid sns signature" }, 401);

    // Enforce the configured outbound notification topic.
    const snsAllowedTopicArn = await getEnvWithOverride(c.env.DB, c.env, "sns_allowed_topic_arn");
    if (!snsAllowedTopicArn) return c.json({ error: "Missing SNS_ALLOWED_TOPIC_ARN configuration" }, 500);
    if (body.TopicArn !== snsAllowedTopicArn) {
      return c.json({ error: "Forbidden topic" }, 403);
    }

    if (body.Type === "SubscriptionConfirmation") {
      const subscribeUrl = body.SubscribeURL;
      if (typeof subscribeUrl !== "string" || !/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//i.test(subscribeUrl)) {
        return c.json({ error: "Invalid subscribe url" }, 400);
      }
      console.log("SNS SubscribeURL (confirm manually):", subscribeUrl);
      return c.json({ ok: true });
    }

    if (body.Type === "Notification") {
      let msg: any;
      try {
        msg = JSON.parse(body.Message);
      } catch {
        return c.json({ error: "Invalid Message JSON" }, 400);
      }
      const kind = msg.notificationType ?? msg.eventType ?? "unknown";
      await c.env.DB.prepare("INSERT INTO events (alias_id, type, detail, ts) VALUES (NULL, 'error', ?, ?)")
        .bind(`ses:${kind}`, Date.now()).run();
      return c.json({ ok: true });
    }
    return c.json({ ok: true });
  });
  return r;
}
