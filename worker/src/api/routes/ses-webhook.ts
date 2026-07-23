import { Hono } from "hono";
import type { AppEnv } from "../app";
import { getEnvWithOverride, getNumericSetting } from "../../lib/settings";
import { readSnsJson, verifySnsMessage } from "../../lib/sns";
import { decryptDestination, hashDestination } from "../../lib/crypto";
import { buildNotificationEmail } from "../../lib/emails";
import { sendRaw } from "../../lib/ses";
import { pushSuppression } from "../../lib/push";
import * as q from "../../db/queries";

// SNS posts JSON (often Content-Type text/plain). We verify SNS signatures,
// validate TopicArn, and log SubscribeURL for one-time manual confirmation.
export function sesWebhookRoutes() {
  const r = new Hono<AppEnv>();
  r.post("/ses/notification", async (c) => {
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
      const safeUrl = new URL(subscribeUrl);
      console.log("SNS subscription auto-confirming", `${safeUrl.origin}${safeUrl.pathname}`);
      
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
      const deliveryId = `sns:${body.MessageId}`;
      let msg: any;
      try {
        msg = JSON.parse(body.Message);
      } catch {
        return c.json({ error: "Invalid Message JSON" }, 400);
      }
      const semanticId = typeof msg.mail?.messageId === "string" ? `ses:${msg.mail.messageId}:${msg.notificationType ?? msg.eventType ?? "unknown"}` : undefined;
      const claim = await q.claimDelivery(c.env.DB, deliveryId, "notification", Date.now(), semanticId);
      if (claim.status !== "claimed") {
        return claim.status === "completed" ? c.json({ ok: true }) : c.json({ error: "Already processing" }, 503);
      }

      const kind: string = msg.notificationType ?? msg.eventType ?? "unknown";
      const db = c.env.DB;
      const now = Date.now();
      const encKey = c.env.DESTINATION_ENCRYPTION_KEY;

      try {
        const durable: D1PreparedStatement[] = [];
        const notifications: Array<{ statement: number; dest: import("../../types").DestinationRow; reason: "complaint" | "hard_bounce" | "soft_bounce"; suppressionClass: "hard" | "soft" }> = [];
        if (kind === "Bounce") {
          await buildBounce(db, msg, encKey, now, durable, notifications);
        } else if (kind === "Complaint") {
          await buildComplaint(db, msg, encKey, now, durable, notifications);
        } else {
          durable.push(db.prepare("INSERT INTO events (alias_id, type, detail, ts) VALUES (NULL, 'error', ?, ?)").bind(`ses:${kind}`, now));
        }
        await (c.env as any).__beforeFeedbackCommit?.();
        const results = await q.commitDeliveryBatch(db, deliveryId, claim.token, Date.now(), durable);
        if (results.length === 0) {
          return c.json({ error: "Delivery lease lost" }, 503);
        }
        for (const pending of notifications) {
          if ((results[pending.statement]?.meta.changes ?? 0) === 0) continue;
          await notifySuppression(c.env, pending.dest, pending.reason, pending.suppressionClass);
          await pushSuppression(c.env, pending.dest.user_id, pending.reason);
        }
      } catch (error) {
        await q.releaseDelivery(db, deliveryId, claim.token);
        throw error;
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
async function buildRecipients(
  db: D1Database,
  recipients: any[],
  encKey: string,
  now: number,
  unknownDetail: string,
  statements: D1PreparedStatement[],
  handle: (dest: import("../../types").DestinationRow) => void,
): Promise<void> {
  for (const recipient of recipients) {
    const addr: string = recipient.emailAddress;
    if (!addr) continue;

    const emailHash = await hashDestination(addr.toLowerCase(), encKey);
    const destinations = await q.findDestinationsByHash(db, emailHash);

    if (destinations.length === 0) {
      // Destination emails are encrypted at rest and looked up by hash; never
      // persist (or log) the raw address — the hash is enough to correlate.
      console.log(`${unknownDetail}: hash:${emailHash}`);
      statements.push(db.prepare(
        "INSERT INTO events (alias_id,type,external_sender,detail,ts) VALUES (NULL,'error',?,?,?)"
      ).bind(`hash:${emailHash}`, unknownDetail, now));
    }

    for (const dest of destinations) {
      handle(dest);
    }
  }
}

type PendingNotification = { statement: number; dest: import("../../types").DestinationRow; reason: "complaint" | "hard_bounce" | "soft_bounce"; suppressionClass: "hard" | "soft" };

async function buildBounce(db: D1Database, msg: any, encKey: string, now: number, statements: D1PreparedStatement[], notifications: PendingNotification[]): Promise<void> {
  const bounce = msg.bounce;
  if (!bounce || !Array.isArray(bounce.bouncedRecipients)) {
    console.log("Bounce notification missing bounce.bouncedRecipients");
    return;
  }

  const isHard = (bounce.bounceType ?? "") === "Permanent";
  const softThreshold = await getNumericSetting(db, "soft_bounce_threshold");

  await buildRecipients(db, bounce.bouncedRecipients, encKey, now, "ses:bounce_unknown_destination", statements, (dest) => {
    if (isHard) {
      // Hard bounce: record and suppress immediately. `dest:<id>` is the only
      // reference stored — the plaintext address must never land in events.
      statements.push(db.prepare("INSERT INTO events (alias_id,type,detail,ts) VALUES (NULL,'bounce',?,?)").bind(`dest:${dest.id}`, now));
      const statement = statements.push(db.prepare(
        "UPDATE destinations SET suppressed_at=?,suppression_reason='hard_bounce',suppression_class='hard' WHERE id=? AND (suppressed_at IS NULL OR suppression_class='soft')"
      ).bind(now, dest.id)) - 1;
      notifications.push({ statement, dest, reason: "hard_bounce", suppressionClass: "hard" });
    } else {
      // Soft/transient bounce: record as soft_bounce so the threshold counts
      // ONLY soft bounces (a prior hard bounce must never inflate the count).
      // The event we just inserted is included in the count.
      statements.push(db.prepare("INSERT INTO events (alias_id,type,detail,ts) VALUES (NULL,'soft_bounce',?,?)").bind(`dest:${dest.id}`, now));
      const since = now - 24 * 3600_000;
      if (softThreshold > 0) {
        const statement = statements.push(db.prepare(
          "UPDATE destinations SET suppressed_at=?,suppression_reason='soft_bounce',suppression_class='soft' WHERE id=? AND suppressed_at IS NULL AND " +
          "(SELECT COUNT(*) FROM events WHERE type='soft_bounce' AND detail=? AND ts>=?)>=?"
        ).bind(now, dest.id, `dest:${dest.id}`, since, softThreshold)) - 1;
        notifications.push({ statement, dest, reason: "soft_bounce", suppressionClass: "soft" });
      }
    }
  });
}

async function buildComplaint(db: D1Database, msg: any, encKey: string, now: number, statements: D1PreparedStatement[], notifications: PendingNotification[]): Promise<void> {
  const complaint = msg.complaint;
  if (!complaint || !Array.isArray(complaint.complainedRecipients)) {
    console.log("Complaint notification missing complaint.complainedRecipients");
    return;
  }

  await buildRecipients(db, complaint.complainedRecipients, encKey, now, "ses:complaint_unknown_destination", statements, (dest) => {
    statements.push(db.prepare("INSERT INTO events (alias_id,type,detail,ts) VALUES (NULL,'complaint',?,?)").bind(`dest:${dest.id}`, now));
    // Always hard-suppress on complaint.
    const statement = statements.push(db.prepare(
      "UPDATE destinations SET suppressed_at=?,suppression_reason='complaint',suppression_class='hard' WHERE id=? AND (suppressed_at IS NULL OR suppression_class='soft')"
    ).bind(now, dest.id)) - 1;
    notifications.push({ statement, dest, reason: "complaint", suppressionClass: "hard" });
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
    // Notify another working mailbox of the same user: prefer the default
    // destination; when the suppressed destination IS the default (the
    // single-destination common case), fall back to any other verified,
    // unsuppressed destination so a hard suppression never goes silent.
    const notifyDestination = await findNotificationDestination(db, suppressed.user_id, suppressed.id);
    if (notifyDestination) {
      recipientRows.set(notifyDestination.id, notifyDestination.email);
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

async function findNotificationDestination(db: D1Database, userId: number, excludeId: number): Promise<{ id: number; email: string } | null> {
  return await db.prepare(
    "SELECT id, email FROM destinations WHERE user_id = ? AND id != ? AND verified_at IS NOT NULL AND suppressed_at IS NULL " +
    "ORDER BY is_default DESC, created_at ASC LIMIT 1"
  ).bind(userId, excludeId).first<{ id: number; email: string }>();
}
