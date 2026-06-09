import { Hono } from "hono";
import type { AppEnv } from "../app";
import { getEnvWithOverride, getNumericSetting } from "../../lib/settings";
import { verifySnsMessage } from "../../lib/sns";
import { decryptDestination, hashDestination } from "../../lib/crypto";
import { buildNotificationEmail } from "../../lib/emails";
import { sendRaw } from "../../lib/ses";
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

    // SNS subscription handshake — log URL for manual confirmation
    if (body.Type === "SubscriptionConfirmation") {
      const subscribeUrl = body.SubscribeURL;
      if (typeof subscribeUrl !== "string" || !/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//i.test(subscribeUrl)) {
        return c.json({ error: "Invalid subscribe url" }, 400);
      }
      console.log("SNS inbound SubscribeURL (auto-confirming):", subscribeUrl);
      
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
        await processBounce(c.env, msg, encKey, now);
      } else if (kind === "Complaint") {
        await processComplaint(c.env, msg, encKey, now);
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

// Walk an SNS bounce/complaint recipient list: hash each address, look up the
// matching destinations, log a stable `*_unknown_destination` error when none
// match, and hand every matched destination to `handle`. Shared by bounce and
// complaint processing so the unknown-recipient logging and lookup never drift.
async function processRecipients(
  env: AppEnv["Bindings"],
  recipients: any[],
  encKey: string,
  now: number,
  unknownDetail: string,
  handle: (dest: import("../../types").DestinationRow, addr: string) => Promise<void>,
): Promise<void> {
  const db = env.DB;
  for (const recipient of recipients) {
    const addr: string = recipient.emailAddress;
    if (!addr) continue;

    const emailHash = await hashDestination(addr.toLowerCase(), encKey);
    const destinations = await q.findDestinationsByHash(db, emailHash);

    if (destinations.length === 0) {
      console.log(`${unknownDetail}: ${addr}`);
      await q.insertEvent(db, { alias_id: null, type: "error", external_sender: addr, detail: unknownDetail, ts: now });
    }

    for (const dest of destinations) {
      await handle(dest, addr);
    }
  }
}

async function processBounce(env: AppEnv["Bindings"], msg: any, encKey: string, now: number): Promise<void> {
  const db = env.DB;
  const bounce = msg.bounce;
  if (!bounce || !Array.isArray(bounce.bouncedRecipients)) {
    console.log("Bounce notification missing bounce.bouncedRecipients");
    return;
  }

  const isHard = (bounce.bounceType ?? "") === "Permanent";
  const softThreshold = await getNumericSetting(db, "soft_bounce_threshold");

  await processRecipients(env, bounce.bouncedRecipients, encKey, now, "ses:bounce_unknown_destination", async (dest, addr) => {
    if (isHard) {
      // Hard bounce: record and suppress immediately.
      await q.insertEvent(db, { alias_id: null, type: "bounce", external_sender: addr, detail: `dest:${dest.id}`, ts: now });
      const changed = await q.suppressDestination(db, dest.id, "hard_bounce", "hard", now);
      if (changed) await notifySuppression(env, dest, "hard_bounce", "hard");
    } else {
      // Soft/transient bounce: record as soft_bounce so the threshold counts
      // ONLY soft bounces (a prior hard bounce must never inflate the count).
      // The event we just inserted is included in the count.
      await q.insertEvent(db, { alias_id: null, type: "soft_bounce", external_sender: addr, detail: `dest:${dest.id}`, ts: now });
      const since = now - 24 * 3600_000;
      const softCount = await q.countEventsForDestinationSince(db, dest.id, "soft_bounce", since);
      if (softThreshold > 0 && softCount >= softThreshold) {
        const changed = await q.suppressDestination(db, dest.id, "soft_bounce", "soft", now);
        if (changed) await notifySuppression(env, dest, "soft_bounce", "soft");
      }
    }
  });
}

async function processComplaint(env: AppEnv["Bindings"], msg: any, encKey: string, now: number): Promise<void> {
  const db = env.DB;
  const complaint = msg.complaint;
  if (!complaint || !Array.isArray(complaint.complainedRecipients)) {
    console.log("Complaint notification missing complaint.complainedRecipients");
    return;
  }

  await processRecipients(env, complaint.complainedRecipients, encKey, now, "ses:complaint_unknown_destination", async (dest, addr) => {
    await q.insertEvent(db, { alias_id: null, type: "complaint", external_sender: addr, detail: `dest:${dest.id}`, ts: now });
    // Always hard-suppress on complaint.
    const changed = await q.suppressDestination(db, dest.id, "complaint", "hard", now);
    if (changed) await notifySuppression(env, dest, "complaint", "hard");
  });
}

async function notifySuppression(
  env: AppEnv["Bindings"],
  suppressed: { id: number; user_id: number; email: string },
  reason: "complaint" | "hard_bounce" | "soft_bounce",
  suppressionClass: "hard" | "soft",
): Promise<void> {
  try {
    const db = env.DB;
    const sesAccessKeyId = await getEnvWithOverride(db, env, "ses_access_key_id");
    const sesSecretAccessKey = await getEnvWithOverride(db, env, "ses_secret_access_key");
    const sesRegion = await getEnvWithOverride(db, env, "ses_region");
    const mainGlobalDomain = await getEnvWithOverride(db, env, "main_global_domain") || "example.com";
    if (!sesAccessKeyId || !sesSecretAccessKey || !sesRegion) return;

    const recipientRows = new Map<number, string>();
    if (suppressionClass === "soft") {
      recipientRows.set(suppressed.id, suppressed.email);
    }
    const defaultDestination = await findDefaultDestination(db, suppressed.user_id);
    if (defaultDestination && defaultDestination.id !== suppressed.id) {
      recipientRows.set(defaultDestination.id, defaultDestination.email);
    }

    const isSoft = suppressionClass === "soft";
    const subject = isSoft ? "Forwarding paused for one destination" : "Destination forwarding paused";
    const heading = isSoft ? "Forwarding paused" : "Destination suppressed";
    const bodyText = isSoft
      ? "A destination was paused after repeated temporary delivery failures. You can resume forwarding from the Destinations page once the mailbox is ready."
      : reason === "complaint"
        ? "A destination was paused after a spam complaint. Hard suppressions protect shared sender reputation and must be cleared by an admin."
        : "A destination was paused after a permanent delivery failure. Hard suppressions protect shared sender reputation and must be cleared by an admin.";

    const sesSend: typeof sendRaw = (env as any).__sesSend ?? sendRaw;
    for (const encryptedEmail of recipientRows.values()) {
      const to = await decryptDestination(encryptedEmail, env.DESTINATION_ENCRYPTION_KEY);
      await sesSend({
        accessKeyId: sesAccessKeyId,
        secretAccessKey: sesSecretAccessKey,
        region: sesRegion,
      }, {
        from: `HideMyEmail <noreply@${mainGlobalDomain}>`,
        to,
        rawBase64: buildNotificationEmail(to, subject, heading, bodyText, mainGlobalDomain),
      });
    }
  } catch (err) {
    console.error("Failed to send suppression notification", err);
  }
}

async function findDefaultDestination(db: D1Database, userId: number): Promise<{ id: number; email: string } | null> {
  return await db.prepare(
    "SELECT id, email FROM destinations WHERE user_id = ? AND is_default = 1 AND verified_at IS NOT NULL LIMIT 1"
  ).bind(userId).first<{ id: number; email: string }>();
}
