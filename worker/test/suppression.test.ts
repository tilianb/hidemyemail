/**
 * Tests for SES bounce/complaint feedback loop and destination suppression.
 *
 * Covers:
 * - Complaint → destination suppressed (hard class)
 * - Permanent bounce → suppressed (hard class)
 * - Transient bounce below threshold → NOT suppressed
 * - Transient bounce reaching threshold → suppressed (soft class)
 * - Inbound to suppressed destination → no SES send (reject "suppressed")
 * - Soft unsuppress by owner works
 * - Hard unsuppress by owner → 403
 * - Admin clear works (clears any class)
 */

import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { signSession } from "../src/lib/auth";
import { encryptDestination, hashDestination } from "../src/lib/crypto";
import { makeSignedSnsBody } from "./sns-signature";

// --------------------------------------------------------------------------
// Constants & helpers
// --------------------------------------------------------------------------

const ARN = "arn:aws:sns:ap-southeast-2:123:ses-notifs";
const INBOUND_ARN = "arn:aws:sns:ap-southeast-2:123456789012:hidemyemail-inbound-notifications";

const DB = () => env.DB as D1Database;

/** Build a testEnv for the ses/notification (outbound feedback) webhook. */
function webhookEnv(certPem = "bad cert", overrides: Record<string, unknown> = {}) {
  return {
    ...env,
    SNS_ALLOWED_TOPIC_ARN: ARN,
    SES_REGION: "ap-southeast-2",
    __snsCertFetch: async () => new Response(certPem, { status: 200 }),
    ...overrides,
  };
}

/** Build a testEnv for the ses/inbound endpoint. */
function inboundEnv(opts: { certPem?: string; raw?: string } = {}) {
  const sesSent: any[] = [];
  const raw = opts.raw ?? [
    "From: Alice <alice@store.com>",
    "To: shop@test.hidemyemail.dev",
    "Subject: Order update",
    "MIME-Version: 1.0",
    "Content-Type: text/plain",
    "",
    "Your order ships tomorrow.",
    "",
  ].join("\r\n");
  return {
    ...env,
    SNS_INBOUND_TOPIC_ARN: INBOUND_ARN,
    S3_INBOUND_BUCKET: "hidemyemail-inbound-raw",
    SES_ACCESS_KEY_ID: "AKIATEST",
    SES_SECRET_ACCESS_KEY: "testsecret",
    SES_REGION: "ap-southeast-2",
    __snsCertFetch: async (_u: string) => new Response(opts.certPem ?? "bad cert", { status: 200 }),
    __s3Fetch: async () => new TextEncoder().encode(raw),
    __sesSend: async (_c: any, m: any) => { sesSent.push(m); return "mid"; },
    _sesSent: sesSent,
  } as any;
}

/** Build a signed SNS body for the notification (feedback) topic. */
async function signedNotification(message: Record<string, unknown>) {
  return makeSignedSnsBody({ topicArn: ARN, message: JSON.stringify(message) });
}

/** Build a signed SNS body for the inbound topic. */
async function signedInbound(to: string) {
  return makeSignedSnsBody({
    topicArn: INBOUND_ARN,
    message: JSON.stringify({
      notificationType: "Received",
      mail: { source: "alice@store.com", messageId: "test-msg", destination: [to] },
      receipt: {
        recipients: [to],
        spfVerdict: { status: "PASS" },
        dmarcVerdict: { status: "PASS" },
      },
    }),
  });
}

/** Post a signed notification to /api/ses/notification. */
async function postNotification(app: ReturnType<typeof createApp>, signed: { body: Record<string, string>; certPem: string }, overrides: Record<string, unknown> = {}) {
  return app.request("/api/ses/notification", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(signed.body),
  }, webhookEnv(signed.certPem, overrides));
}

/** Insert a real destination row and return its id. */
async function insertDestination(email: string, userId = 1): Promise<number> {
  const enc = await encryptDestination(email, env.DESTINATION_ENCRYPTION_KEY);
  const hash = await hashDestination(email, env.DESTINATION_ENCRYPTION_KEY);
  const r = await DB().prepare(
    "INSERT INTO destinations (user_id, email, email_hash, token, verified_at, created_at, is_default) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id"
  ).bind(userId, enc, hash, `tok-${email}-${Date.now()}`, Date.now(), Date.now()).first<{ id: number }>();
  return r!.id;
}

/** Read destination row suppression fields. */
async function getSuppressionFields(id: number) {
  return DB().prepare(
    "SELECT suppressed_at, suppression_reason, suppression_class FROM destinations WHERE id = ?"
  ).bind(id).first<{ suppressed_at: number | null; suppression_reason: string | null; suppression_class: string | null }>();
}

/** Set soft_bounce_threshold in settings. */
async function setSoftBounceThreshold(threshold: number) {
  await DB().prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('soft_bounce_threshold', ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(String(threshold)).run();
}

/** Count bounce events for a destination. */
async function countBounceEvents(destId: number): Promise<number> {
  const r = await DB().prepare(
    "SELECT COUNT(*) AS n FROM events WHERE type = 'bounce' AND detail = ?"
  ).bind(`dest:${destId}`).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Count complaint events for a destination. */
async function countComplaintEvents(destId: number): Promise<number> {
  const r = await DB().prepare(
    "SELECT COUNT(*) AS n FROM events WHERE type = 'complaint' AND detail = ?"
  ).bind(`dest:${destId}`).first<{ n: number }>();
  return r?.n ?? 0;
}

// --------------------------------------------------------------------------
// Test lifecycle
// --------------------------------------------------------------------------

beforeEach(async () => {
  // Clear all relevant tables — resetDb does NOT clear destinations or users
  for (const t of ["events", "reverse_map", "blocks", "aliases", "domains", "rate_limits"]) {
    await DB().prepare(`DELETE FROM ${t}`).run();
  }
  await DB().prepare("DELETE FROM destinations").run();
  // Reset soft_bounce_threshold to default (3)
  await DB().prepare("DELETE FROM settings WHERE key = 'soft_bounce_threshold'").run();
});

// --------------------------------------------------------------------------
// Complaint → hard suppression
// --------------------------------------------------------------------------

test("complaint → destination suppressed (hard class)", async () => {
  const destId = await insertDestination("victim@example.com");
  const app = createApp();

  const msg = {
    notificationType: "Complaint",
    complaint: {
      complainedRecipients: [{ emailAddress: "victim@example.com" }],
    },
  };
  const signed = await signedNotification(msg);
  const res = await postNotification(app, signed);

  expect(res.status).toBe(200);

  const sup = await getSuppressionFields(destId);
  expect(sup?.suppressed_at).toBeTypeOf("number");
  expect(sup?.suppression_class).toBe("hard");
  expect(sup?.suppression_reason).toBe("complaint");

  const evtCount = await countComplaintEvents(destId);
  expect(evtCount).toBe(1);
});

// --------------------------------------------------------------------------
// Permanent bounce → hard suppression
// --------------------------------------------------------------------------

test("permanent bounce → destination suppressed (hard class)", async () => {
  const destId = await insertDestination("hard@example.com");
  const app = createApp();

  const msg = {
    notificationType: "Bounce",
    bounce: {
      bounceType: "Permanent",
      bouncedRecipients: [{ emailAddress: "hard@example.com" }],
    },
  };
  const signed = await signedNotification(msg);
  const res = await postNotification(app, signed);

  expect(res.status).toBe(200);

  const sup = await getSuppressionFields(destId);
  expect(sup?.suppressed_at).toBeTypeOf("number");
  expect(sup?.suppression_class).toBe("hard");
  expect(sup?.suppression_reason).toBe("hard_bounce");

  const evtCount = await countBounceEvents(destId);
  expect(evtCount).toBe(1);
});

test("first suppression emails suppressed destination and default destination", async () => {
  const suppressedId = await insertDestination("bad@example.com");
  await DB().prepare("UPDATE destinations SET is_default = 0 WHERE id = ?").bind(suppressedId).run();
  const defaultId = await insertDestination("default@example.com");
  await DB().prepare("UPDATE destinations SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE user_id = 1")
    .bind(defaultId).run();

  const sent: any[] = [];
  const app = createApp();
  const msg = {
    notificationType: "Bounce",
    bounce: {
      bounceType: "Permanent",
      bouncedRecipients: [{ emailAddress: "bad@example.com" }],
    },
  };
  const signed = await signedNotification(msg);
  const res = await postNotification(app, signed, {
    SES_ACCESS_KEY_ID: "AKIATEST",
    SES_SECRET_ACCESS_KEY: "testsecret",
    __sesSend: async (_c: any, m: any) => { sent.push(m); return `mid-${sent.length}`; },
  });

  expect(res.status).toBe(200);
  expect(sent.map(m => m.to).sort()).toEqual(["bad@example.com", "default@example.com"]);
});

test("duplicate suppression does not resend notification", async () => {
  const suppressedId = await insertDestination("already@example.com");
  await DB().prepare("UPDATE destinations SET suppressed_at = ?, suppression_class = 'hard', suppression_reason = 'hard_bounce' WHERE id = ?")
    .bind(Date.now(), suppressedId).run();
  const sent: any[] = [];
  const app = createApp();
  const msg = {
    notificationType: "Bounce",
    bounce: {
      bounceType: "Permanent",
      bouncedRecipients: [{ emailAddress: "already@example.com" }],
    },
  };
  const signed = await signedNotification(msg);
  const res = await postNotification(app, signed, {
    SES_ACCESS_KEY_ID: "AKIATEST",
    SES_SECRET_ACCESS_KEY: "testsecret",
    __sesSend: async (_c: any, m: any) => { sent.push(m); return `mid-${sent.length}`; },
  });

  expect(res.status).toBe(200);
  expect(sent).toHaveLength(0);
});

// --------------------------------------------------------------------------
// Transient bounce below threshold → NOT suppressed
// --------------------------------------------------------------------------

test("transient bounce below threshold → NOT suppressed", async () => {
  await setSoftBounceThreshold(3);
  const destId = await insertDestination("soft@example.com");
  const app = createApp();

  // Send 2 transient bounces (threshold is 3, so should not yet suppress)
  for (let i = 0; i < 2; i++) {
    const msg = {
      notificationType: "Bounce",
      bounce: {
        bounceType: "Transient",
        bouncedRecipients: [{ emailAddress: "soft@example.com" }],
      },
    };
    const signed = await signedNotification(msg);
    await postNotification(app, signed);
  }

  const sup = await getSuppressionFields(destId);
  expect(sup?.suppressed_at).toBeNull();

  const evtCount = await countBounceEvents(destId);
  expect(evtCount).toBe(2);
});

// --------------------------------------------------------------------------
// Transient bounce reaching threshold → soft suppression
// --------------------------------------------------------------------------

test("transient bounce reaching threshold → suppressed (soft class)", async () => {
  await setSoftBounceThreshold(3);
  const destId = await insertDestination("willbesoft@example.com");
  const app = createApp();

  // Send 3 transient bounces (threshold is 3)
  for (let i = 0; i < 3; i++) {
    const msg = {
      notificationType: "Bounce",
      bounce: {
        bounceType: "Transient",
        bouncedRecipients: [{ emailAddress: "willbesoft@example.com" }],
      },
    };
    const signed = await signedNotification(msg);
    const res = await postNotification(app, signed);
    expect(res.status).toBe(200);
  }

  const sup = await getSuppressionFields(destId);
  expect(sup?.suppressed_at).toBeTypeOf("number");
  expect(sup?.suppression_class).toBe("soft");
  expect(sup?.suppression_reason).toBe("soft_bounce");

  const evtCount = await countBounceEvents(destId);
  expect(evtCount).toBe(3);
});

// --------------------------------------------------------------------------
// Unknown destination in bounce/complaint → no error, just logs
// --------------------------------------------------------------------------

test("bounce for unknown destination → 200, no crash", async () => {
  const app = createApp();
  const msg = {
    notificationType: "Bounce",
    bounce: {
      bounceType: "Permanent",
      bouncedRecipients: [{ emailAddress: "nobody@nowhere.invalid" }],
    },
  };
  const signed = await signedNotification(msg);
  const res = await postNotification(app, signed);
  expect(res.status).toBe(200);

  const row = await DB().prepare(
    "SELECT detail FROM events WHERE type = 'error' LIMIT 1"
  ).first<{ detail: string }>();
  expect(row?.detail).toBe("ses:bounce_unknown_destination");
});

test("soft bounce threshold 0 disables transient suppression", async () => {
  await setSoftBounceThreshold(0);
  const destId = await insertDestination("disabled-soft@example.com");
  const app = createApp();

  const msg = {
    notificationType: "Bounce",
    bounce: {
      bounceType: "Transient",
      bouncedRecipients: [{ emailAddress: "disabled-soft@example.com" }],
    },
  };
  const signed = await signedNotification(msg);
  const res = await postNotification(app, signed);
  expect(res.status).toBe(200);

  const sup = await getSuppressionFields(destId);
  expect(sup?.suppressed_at).toBeNull();
});

// --------------------------------------------------------------------------
// Inbound to suppressed destination → no SES send (reject "suppressed")
// --------------------------------------------------------------------------

test("inbound to suppressed destination → no SES send, reject event", async () => {
  // Insert a domain for inbound routing
  await DB().prepare(
    "INSERT INTO domains (user_id, is_global, domain, default_destination, active, created_at) VALUES (1, 1, 'test.hidemyemail.dev', NULL, 1, ?)"
  ).bind(Date.now()).run();

  // Insert suppressed destination as is_default for user 1
  const destId = await insertDestination("suppressed@example.com");
  await DB().prepare("UPDATE destinations SET suppressed_at = ?, suppression_class = 'hard', suppression_reason = 'complaint' WHERE id = ?")
    .bind(Date.now(), destId).run();

  // Set this destination as the domain default using the encrypted value
  const enc = await encryptDestination("global", env.DESTINATION_ENCRYPTION_KEY);
  // The domain default_destination points to "global" (resolves to is_default destination)
  await DB().prepare("UPDATE domains SET default_destination = ? WHERE domain = 'test.hidemyemail.dev'")
    .bind(enc).run();

  const e = inboundEnv();
  const app = createApp();
  const signed = await signedInbound("shop@test.hidemyemail.dev");
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(signed.body),
  }, { ...e, __snsCertFetch: async () => new Response(signed.certPem, { status: 200 }) });

  expect(res.status).toBe(200);
  expect(e._sesSent.length).toBe(0);

  // Verify reject event with "suppressed" detail was inserted
  const rejectEvt = await DB().prepare(
    "SELECT detail FROM events WHERE type = 'reject' AND detail = 'suppressed' LIMIT 1"
  ).first<{ detail: string }>();
  expect(rejectEvt?.detail).toBe("suppressed");
});

// --------------------------------------------------------------------------
// User API: soft unsuppress works
// --------------------------------------------------------------------------

test("POST /api/destinations/:id/unsuppress clears soft suppression", async () => {
  const cookie = "__Host-session=" + (await signSession(env.SESSION_SECRET, 1, 3600));
  const destId = await insertDestination("resume@example.com");
  await DB().prepare("UPDATE destinations SET suppressed_at = ?, suppression_class = 'soft', suppression_reason = 'soft_bounce' WHERE id = ?")
    .bind(Date.now(), destId).run();

  const app = createApp();
  const testEnv = { ...env };
  const res = await app.request(`/api/destinations/${destId}/unsuppress`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
  }, testEnv);

  expect(res.status).toBe(200);
  const sup = await getSuppressionFields(destId);
  expect(sup?.suppressed_at).toBeNull();
  expect(sup?.suppression_reason).toBeNull();
  expect(sup?.suppression_class).toBeNull();
});

// --------------------------------------------------------------------------
// User API: hard unsuppress → 403
// --------------------------------------------------------------------------

test("POST /api/destinations/:id/unsuppress for hard suppression → 403", async () => {
  const cookie = "__Host-session=" + (await signSession(env.SESSION_SECRET, 1, 3600));
  const destId = await insertDestination("hardsup@example.com");
  await DB().prepare("UPDATE destinations SET suppressed_at = ?, suppression_class = 'hard', suppression_reason = 'complaint' WHERE id = ?")
    .bind(Date.now(), destId).run();

  const app = createApp();
  const testEnv = { ...env };
  const res = await app.request(`/api/destinations/${destId}/unsuppress`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
  }, testEnv);

  expect(res.status).toBe(403);

  // Destination should still be suppressed
  const sup = await getSuppressionFields(destId);
  expect(sup?.suppressed_at).toBeTypeOf("number");
});

// --------------------------------------------------------------------------
// User cannot unsuppress another user's destination
// --------------------------------------------------------------------------

test("unsuppress cross-user → 404", async () => {
  // Insert user 2
  await DB().prepare("INSERT INTO users (id, passphrase_hash, created_at) VALUES (2, 'hash2', ?)").bind(Date.now()).run();
  const cookie2 = "__Host-session=" + (await signSession(env.SESSION_SECRET, 2, 3600));

  // Destination belongs to user 1
  const destId = await insertDestination("user1dest@example.com", 1);
  await DB().prepare("UPDATE destinations SET suppressed_at = ?, suppression_class = 'soft' WHERE id = ?")
    .bind(Date.now(), destId).run();

  const app = createApp();
  const testEnv = { ...env };
  const res = await app.request(`/api/destinations/${destId}/unsuppress`, {
    method: "POST",
    headers: { "cookie": cookie2, "Content-Type": "application/json" },
  }, testEnv);

  expect(res.status).toBe(404);
});

// --------------------------------------------------------------------------
// Admin: GET /api/admin/suppressions returns list
// --------------------------------------------------------------------------

test("GET /api/admin/suppressions returns suppressed destinations", async () => {
  const cookie = "__Host-session=" + (await signSession(env.SESSION_SECRET, 1, 3600));
  const destId = await insertDestination("adminsup@example.com");
  await DB().prepare("UPDATE destinations SET suppressed_at = ?, suppression_class = 'hard', suppression_reason = 'hard_bounce' WHERE id = ?")
    .bind(Date.now(), destId).run();

  const app = createApp();
  const testEnv = { ...env };
  const res = await app.request("/api/admin/suppressions", {
    headers: { cookie, "Content-Type": "application/json" },
  }, testEnv);

  expect(res.status).toBe(200);
  const body = await res.json<{ suppressions: any[] }>();
  expect(body.suppressions.length).toBeGreaterThanOrEqual(1);
  const entry = body.suppressions.find((s: any) => s.id === destId);
  expect(entry).toBeDefined();
  expect(entry.suppression_class).toBe("hard");
  expect(entry.bounce_24h).toBeTypeOf("number");
  expect(entry.complaint_24h).toBeTypeOf("number");
  expect((body as any).totals.suppressed).toBeGreaterThanOrEqual(1);
  expect((body as any).health).toBe("attention");
});

// --------------------------------------------------------------------------
// Admin: POST /api/admin/suppressions/:id/clear works for any class
// --------------------------------------------------------------------------

test("POST /api/admin/suppressions/:id/clear clears hard suppression", async () => {
  const cookie = "__Host-session=" + (await signSession(env.SESSION_SECRET, 1, 3600));
  const destId = await insertDestination("clearme@example.com");
  await DB().prepare("UPDATE destinations SET suppressed_at = ?, suppression_class = 'hard', suppression_reason = 'complaint' WHERE id = ?")
    .bind(Date.now(), destId).run();

  const app = createApp();
  const testEnv = { ...env };
  const res = await app.request(`/api/admin/suppressions/${destId}/clear`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
  }, testEnv);

  expect(res.status).toBe(200);
  const sup = await getSuppressionFields(destId);
  expect(sup?.suppressed_at).toBeNull();
});

// --------------------------------------------------------------------------
// Destinations list includes suppression fields
// --------------------------------------------------------------------------

test("GET /api/destinations includes suppression fields", async () => {
  const cookie = "__Host-session=" + (await signSession(env.SESSION_SECRET, 1, 3600));
  const destId = await insertDestination("listed@example.com");
  await DB().prepare("UPDATE destinations SET suppressed_at = 1234567890, suppression_class = 'soft', suppression_reason = 'soft_bounce' WHERE id = ?")
    .bind(destId).run();

  const app = createApp();
  const testEnv = { ...env };
  const res = await app.request("/api/destinations", {
    headers: { cookie },
  }, testEnv);

  expect(res.status).toBe(200);
  const dests = await res.json<any[]>();
  const dest = dests.find((d: any) => d.id === destId);
  expect(dest).toBeDefined();
  expect(dest.suppressed_at).toBe(1234567890);
  expect(dest.suppression_class).toBe("soft");
  expect(dest.suppression_reason).toBe("soft_bounce");
});

// --------------------------------------------------------------------------
// Idempotency: re-suppressing already-suppressed destination is fine
// --------------------------------------------------------------------------

test("re-suppressing already-suppressed destination is idempotent", async () => {
  const destId = await insertDestination("idempotent@example.com");
  const app = createApp();

  // Two identical permanent bounces
  for (let i = 0; i < 2; i++) {
    const msg = {
      notificationType: "Bounce",
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: "idempotent@example.com" }],
      },
    };
    const signed = await signedNotification(msg);
    const res = await postNotification(app, signed);
    expect(res.status).toBe(200);
  }

  const sup = await getSuppressionFields(destId);
  expect(sup?.suppression_class).toBe("hard");
  // Two bounce events should exist
  const evtCount = await countBounceEvents(destId);
  expect(evtCount).toBe(2);
});
