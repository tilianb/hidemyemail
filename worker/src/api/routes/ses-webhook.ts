import { Hono } from "hono";
import type { AppEnv } from "../app";
import { getEnvWithOverride, getNumericSetting } from "../../lib/settings";
import { verifySnsMessage } from "../../lib/sns";
import { hashDestination } from "../../lib/crypto";
import * as q from "../../db/queries";

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

      const kind: string = msg.notificationType ?? msg.eventType ?? "unknown";
      const db = c.env.DB;
      const now = Date.now();
      const encKey = c.env.DESTINATION_ENCRYPTION_KEY;

      if (kind === "Bounce") {
        await processBounce(db, msg, encKey, now);
      } else if (kind === "Complaint") {
        await processComplaint(db, msg, encKey, now);
      } else {
        // Unknown notification type: log it
        await db.prepare("INSERT INTO events (alias_id, type, detail, ts) VALUES (NULL, 'error', ?, ?)")
          .bind(`ses:${kind}`, now).run();
      }

      return c.json({ ok: true });
    }
    return c.json({ ok: true });
  });
  return r;
}

async function processBounce(db: D1Database, msg: any, encKey: string, now: number): Promise<void> {
  const bounce = msg.bounce;
  if (!bounce || !Array.isArray(bounce.bouncedRecipients)) {
    console.log("Bounce notification missing bounce.bouncedRecipients");
    return;
  }

  const bounceType: string = bounce.bounceType ?? "";
  const isHard = bounceType === "Permanent";
  const softThreshold = await getNumericSetting(db, "soft_bounce_threshold");

  for (const recipient of bounce.bouncedRecipients) {
    const addr: string = recipient.emailAddress;
    if (!addr) continue;

    const emailHash = await hashDestination(addr.toLowerCase(), encKey);
    const destinations = await q.findDestinationsByHash(db, emailHash);

    if (destinations.length === 0) {
      console.log(`Bounce for unknown destination: ${addr}`);
      await q.insertEvent(db, {
        alias_id: null,
        type: "error",
        external_sender: addr,
        detail: "ses:bounce_unknown_destination",
        ts: now,
      });
    }

    for (const dest of destinations) {
      // Always insert a bounce event referencing this destination
      await q.insertEvent(db, {
        alias_id: null,
        type: "bounce",
        external_sender: addr,
        detail: `dest:${dest.id}`,
        ts: now,
      });

      if (isHard) {
        // Hard bounce: suppress immediately
        await q.suppressDestination(db, dest.id, "hard_bounce", "hard", now);
      } else {
        // Soft/Transient bounce: count prior soft bounce events in last 24h
        // The event we just inserted is included in this count
        const since = now - 24 * 3600_000;
        const bounceCount = await q.countEventsForDestinationSince(db, dest.id, "bounce", since);
        if (softThreshold > 0 && bounceCount >= softThreshold) {
          await q.suppressDestination(db, dest.id, "soft_bounce", "soft", now);
        }
      }
    }
  }
}

async function processComplaint(db: D1Database, msg: any, encKey: string, now: number): Promise<void> {
  const complaint = msg.complaint;
  if (!complaint || !Array.isArray(complaint.complainedRecipients)) {
    console.log("Complaint notification missing complaint.complainedRecipients");
    return;
  }

  for (const recipient of complaint.complainedRecipients) {
    const addr: string = recipient.emailAddress;
    if (!addr) continue;

    const emailHash = await hashDestination(addr.toLowerCase(), encKey);
    const destinations = await q.findDestinationsByHash(db, emailHash);

    if (destinations.length === 0) {
      console.log(`Complaint for unknown destination: ${addr}`);
      await q.insertEvent(db, {
        alias_id: null,
        type: "error",
        external_sender: addr,
        detail: "ses:complaint_unknown_destination",
        ts: now,
      });
    }

    for (const dest of destinations) {
      // Insert complaint event referencing this destination
      await q.insertEvent(db, {
        alias_id: null,
        type: "complaint",
        external_sender: addr,
        detail: `dest:${dest.id}`,
        ts: now,
      });

      // Always hard-suppress on complaint
      await q.suppressDestination(db, dest.id, "complaint", "hard", now);
    }
  }
}
