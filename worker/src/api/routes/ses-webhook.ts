import { Hono } from "hono";
import type { AppEnv } from "../app";

// SNS posts JSON (often Content-Type text/plain). We validate TopicArn and (prod TODO)
// the SNS signature. SubscriptionConfirmation logs SubscribeURL for one-time manual confirm.
export function sesWebhookRoutes() {
  const r = new Hono<AppEnv>();
  r.post("/ses/notification", async (c) => {
    const body = await c.req.json<any>().catch(() => null);
    if (!body) return c.json({ error: "bad body" }, 400);

    // Secure webhook verification via secret token query parameter
    const secret = c.req.query("secret");
    if (c.env.SNS_SECRET && secret !== c.env.SNS_SECRET) {
      return c.json({ error: "unauthorized" }, 401);
    }

    if (c.env.SNS_ALLOWED_TOPIC_ARN && body.TopicArn !== c.env.SNS_ALLOWED_TOPIC_ARN) {
      return c.json({ error: "forbidden topic" }, 403);
    }

    if (body.Type === "SubscriptionConfirmation") {
      const subscribeUrl = body.SubscribeURL;
      if (typeof subscribeUrl !== "string" || !/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//i.test(subscribeUrl)) {
        return c.json({ error: "invalid subscribe url" }, 400);
      }
      console.log("SNS SubscribeURL:", subscribeUrl);
      await fetch(subscribeUrl).catch(console.error);
      return c.json({ ok: true });
    }

    if (body.Type === "Notification") {
      let msg: any;
      try {
        msg = JSON.parse(body.Message);
      } catch {
        return c.json({ error: "invalid Message JSON" }, 400);
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
