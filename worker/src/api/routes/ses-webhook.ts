import { Hono } from "hono";
import type { AppEnv } from "../app";

// SNS posts JSON (often Content-Type text/plain). We validate TopicArn and (prod TODO)
// the SNS signature. SubscriptionConfirmation logs SubscribeURL for one-time manual confirm.
export function sesWebhookRoutes() {
  const r = new Hono<AppEnv>();
  r.post("/ses/notification", async (c) => {
    const body = await c.req.json<any>().catch(() => null);
    if (!body) return c.json({ error: "bad body" }, 400);
    if (c.env.SNS_ALLOWED_TOPIC_ARN && body.TopicArn !== c.env.SNS_ALLOWED_TOPIC_ARN) {
      return c.json({ error: "forbidden topic" }, 403);
    }
    if (body.Type === "SubscriptionConfirmation") {
      console.log("SNS SubscribeURL:", body.SubscribeURL);
      return c.json({ ok: true });
    }
    if (body.Type === "Notification") {
      const msg = JSON.parse(body.Message);
      const kind = msg.notificationType ?? msg.eventType ?? "unknown";
      await c.env.DB.prepare("INSERT INTO events (alias_id, type, detail, ts) VALUES (NULL, 'error', ?, ?)")
        .bind(`ses:${kind}`, Date.now()).run();
      return c.json({ ok: true });
    }
    return c.json({ ok: true });
  });
  return r;
}
