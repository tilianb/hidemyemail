/**
 * Tests for v1 account features:
 *  - GET /api/account/export: returns caller's data with decrypted destination email
 *  - POST /api/account/delete: tombstones account with guards
 *  - purgeDeletedAccounts: hard-deletes expired tombstones, retains recent ones
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { signSession, derivePassphraseHash } from "../src/lib/auth";
import { encryptDestination, hashDestination } from "../src/lib/crypto";
import { purgeDeletedAccounts } from "../src/lib/purge";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DB = () => env.DB as D1Database;

let testEnv: any;

beforeAll(async () => {
  testEnv = {
    ...env,
    SESSION_SECRET: "sek",
    AUTH_PASSWORD_SALT: "deadbeef",
  };
});

beforeEach(async () => {
  const db = DB();
  await db.prepare("DELETE FROM events").run();
  await db.prepare("DELETE FROM reverse_map").run();
  await db.prepare("DELETE FROM blocks").run();
  await db.prepare("DELETE FROM aliases").run();
  await db.prepare("DELETE FROM destinations").run();
  await db.prepare("DELETE FROM domains WHERE user_id != 1").run();
  await db.prepare("DELETE FROM mfa").run();
  await db.prepare("DELETE FROM passkey_credentials").run();
  await db.prepare("DELETE FROM users WHERE id > 1").run();
  // Reset admin to pristine state
  await db.prepare("UPDATE users SET active = 1, forwarding = 1, deleted_at = NULL WHERE id = 1").run();
  await db.prepare("DELETE FROM rate_limits").run();
});

/** Insert a user with a known passphrase, return { userId, hash, cookie }. */
async function makeUser(passphrase = "my-secret-pass"): Promise<{ userId: number; hash: string; cookie: string }> {
  const hash = await derivePassphraseHash(passphrase, "deadbeef");
  const res = await DB().prepare(
    "INSERT INTO users (passphrase_hash, active, forwarding, created_at) VALUES (?, 1, 1, ?)"
  ).bind(hash, Date.now()).run();
  const userId = Number(res.meta.last_row_id);
  const cookie = "__Host-session=" + (await signSession("sek", userId, 3600));
  return { userId, hash, cookie };
}

/** Insert an encrypted destination for a user. */
async function insertDestination(email: string, userId: number, isDefault = 1): Promise<number> {
  const enc = await encryptDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY);
  const h = await hashDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY);
  const r = await DB().prepare(
    "INSERT INTO destinations (user_id, email, email_hash, token, verified_at, created_at, is_default) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(userId, enc, h, `tok-${email}-${userId}`, Date.now(), Date.now(), isDefault).run();
  return Number(r.meta.last_row_id);
}

// ---------------------------------------------------------------------------
// GET /api/account/export
// ---------------------------------------------------------------------------

test("export returns only the caller's data", async () => {
  const app = createApp();
  const { userId, cookie } = await makeUser();

  // Create another user's destination — must NOT appear in the export
  const { userId: otherId } = await makeUser("other-pass");
  await insertDestination("other@example.com", otherId);

  // Create the caller's destination with an encrypted email
  await insertDestination("mine@example.com", userId);

  const res = await app.request("/api/account/export", {
    headers: { cookie },
  }, testEnv);

  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Disposition")).toContain("attachment");
  expect(res.headers.get("Content-Disposition")).toContain(".json");

  const body = await res.json<any>();

  // User row is present
  expect(body.user).toBeDefined();
  expect(body.user.id).toBe(userId);
  // Secret columns must be absent
  expect(body.user).not.toHaveProperty("passphrase_hash");
  expect(body.user).not.toHaveProperty("recovery_token");

  // Destination is present with decrypted email
  expect(body.destinations).toHaveLength(1);
  expect(body.destinations[0].email).toBe("mine@example.com");

  // Other user's destination must not appear
  const allEmails = body.destinations.map((d: any) => d.email);
  expect(allEmails).not.toContain("other@example.com");
});

test("export includes events only for caller's aliases", async () => {
  const app = createApp();
  const { userId, cookie } = await makeUser();

  // Create a domain + alias for the caller
  const domRes = await DB().prepare(
    "INSERT INTO domains (user_id, is_global, domain, active, created_at) VALUES (?, 0, 'mydom.example.com', 1, ?)"
  ).bind(userId, Date.now()).run();
  const domainId = Number(domRes.meta.last_row_id);

  const aliasRes = await DB().prepare(
    "INSERT INTO aliases (domain_id, user_id, local_part, full_address, active, source, created_at) VALUES (?, ?, 'test', 'test@mydom.example.com', 1, 'dashboard', ?)"
  ).bind(domainId, userId, Date.now()).run();
  const aliasId = Number(aliasRes.meta.last_row_id);

  // Event for caller's alias
  await DB().prepare(
    "INSERT INTO events (alias_id, type, ts) VALUES (?, 'forward', ?)"
  ).bind(aliasId, Date.now()).run();

  const res = await app.request("/api/account/export", {
    headers: { cookie },
  }, testEnv);

  expect(res.status).toBe(200);
  const body = await res.json<any>();
  expect(body.events.length).toBeGreaterThanOrEqual(1);
  expect(body.events.every((e: any) => e.alias_id === aliasId)).toBe(true);
});

test("export includes destination suppression events owned by caller", async () => {
  const app = createApp();
  const { userId, cookie } = await makeUser();
  const destinationId = await insertDestination("bouncy@example.com", userId);
  const { userId: otherId } = await makeUser("other-pass");
  const otherDestinationId = await insertDestination("other-bouncy@example.com", otherId);

  await DB().prepare(
    "INSERT INTO events (alias_id, type, external_sender, detail, ts) VALUES (NULL, 'bounce', 'ses@example.com', ?, ?)"
  ).bind(`dest:${destinationId}`, Date.now()).run();
  await DB().prepare(
    "INSERT INTO events (alias_id, type, external_sender, detail, ts) VALUES (NULL, 'complaint', 'ses@example.com', ?, ?)"
  ).bind(`dest:${otherDestinationId}`, Date.now()).run();

  const res = await app.request("/api/account/export", {
    headers: { cookie },
  }, testEnv);

  expect(res.status).toBe(200);
  const body = await res.json<any>();
  expect(body.events.map((e: any) => e.detail)).toContain(`dest:${destinationId}`);
  expect(body.events.map((e: any) => e.detail)).not.toContain(`dest:${otherDestinationId}`);
});

test("export requires authentication", async () => {
  const app = createApp();
  const res = await app.request("/api/account/export", {}, testEnv);
  expect(res.status).toBe(401);
});

// ---------------------------------------------------------------------------
// POST /api/account/delete
// ---------------------------------------------------------------------------

test("delete: confirm !== 'DELETE' → 400", async () => {
  const app = createApp();
  const { cookie } = await makeUser();

  const res = await app.request("/api/account/delete", {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "my-secret-pass", confirm: "yes" }),
  }, testEnv);

  expect(res.status).toBe(400);
});

test("delete: wrong password → 401", async () => {
  const app = createApp();
  const { cookie } = await makeUser();

  const res = await app.request("/api/account/delete", {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "wrong-password", confirm: "DELETE" }),
  }, testEnv);

  expect(res.status).toBe(401);
});

test("delete: userId 1 (admin) → 403", async () => {
  const app = createApp();
  const adminCookie = "__Host-session=" + (await signSession("sek", 1, 3600));

  const res = await app.request("/api/account/delete", {
    method: "POST",
    headers: { cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "anything", confirm: "DELETE" }),
  }, testEnv);

  expect(res.status).toBe(403);
  const body = await res.json<any>();
  expect(body.error).toContain("admin");
});

test("delete: valid → sets deleted_at, active=0, forwarding=0; subsequent login blocked", async () => {
  const app = createApp();
  const { userId, cookie } = await makeUser("correct-passphrase");

  const res = await app.request("/api/account/delete", {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "correct-passphrase", confirm: "DELETE" }),
  }, testEnv);

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });

  // Session cookies must be cleared
  const setCookieHeader = res.headers.get("set-cookie") ?? "";
  expect(setCookieHeader).toContain("__Host-session=;");

  // DB state: deleted_at is set, active=0, forwarding=0
  const row = await DB().prepare(
    "SELECT active, forwarding, deleted_at FROM users WHERE id = ?"
  ).bind(userId).first<{ active: number; forwarding: number; deleted_at: number | null }>();
  expect(row?.active).toBe(0);
  expect(row?.forwarding).toBe(0);
  expect(row?.deleted_at).toBeTypeOf("number");

  // Subsequent login with correct passphrase must be blocked (active=0 / deleted)
  const loginRes = await app.request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "correct-passphrase" }),
  }, testEnv);
  expect(loginRes.status).toBe(403);
});

test("delete: existing session cannot access guarded routes after deletion", async () => {
  const app = createApp();
  const { userId, cookie } = await makeUser();

  // Tombstone via direct DB update (simulating a completed delete)
  await DB().prepare(
    "UPDATE users SET deleted_at = ?, active = 0, forwarding = 0 WHERE id = ?"
  ).bind(Date.now(), userId).run();

  // Try to use the old cookie on a guarded route
  const res = await app.request("/api/stats", {
    headers: { cookie },
  }, testEnv);
  expect(res.status).toBe(403);
});

// ---------------------------------------------------------------------------
// purgeDeletedAccounts
// ---------------------------------------------------------------------------

test("purge: user with deleted_at past 7 days is fully removed", async () => {
  const { userId } = await makeUser();
  const destId = await insertDestination("purge@example.com", userId);

  // Create an alias + event so we can assert they are gone too
  const domRes = await DB().prepare(
    "INSERT INTO domains (user_id, is_global, domain, active, created_at) VALUES (?, 0, 'purge.example.com', 1, ?)"
  ).bind(userId, Date.now()).run();
  const domainId = Number(domRes.meta.last_row_id);
  const aliasRes = await DB().prepare(
    "INSERT INTO aliases (domain_id, user_id, local_part, full_address, active, source, created_at) VALUES (?, ?, 'a', 'a@purge.example.com', 1, 'dashboard', ?)"
  ).bind(domainId, userId, Date.now()).run();
  const aliasId = Number(aliasRes.meta.last_row_id);
  await DB().prepare("INSERT INTO events (alias_id, type, ts) VALUES (?, 'forward', ?)").bind(aliasId, Date.now()).run();
  await DB().prepare("INSERT INTO blocks (user_id, alias_id, pattern, created_at) VALUES (?, ?, 'spam@example.com', ?)").bind(userId, aliasId, Date.now()).run();
  await DB().prepare("INSERT INTO events (alias_id, type, detail, ts) VALUES (NULL, 'bounce', ?, ?)").bind(`dest:${destId}`, Date.now()).run();

  // Set deleted_at 8 days ago (past the 7-day window)
  const eightDaysAgo = Date.now() - 8 * 24 * 3_600_000;
  await DB().prepare("UPDATE users SET deleted_at = ?, active = 0, forwarding = 0 WHERE id = ?").bind(eightDaysAgo, userId).run();

  const count = await purgeDeletedAccounts(DB(), Date.now());

  expect(count).toBe(1);

  // User row must be gone
  const userRow = await DB().prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
  expect(userRow).toBeNull();

  // Alias must be gone
  const aliasRow = await DB().prepare("SELECT id FROM aliases WHERE id = ?").bind(aliasId).first();
  expect(aliasRow).toBeNull();

  // Destination must be gone
  const destRow = await DB().prepare("SELECT id FROM destinations WHERE id = ?").bind(destId).first();
  expect(destRow).toBeNull();

  // Events must be gone
  const eventRow = await DB().prepare("SELECT id FROM events WHERE alias_id = ?").bind(aliasId).first();
  expect(eventRow).toBeNull();
  const destEventRow = await DB().prepare("SELECT id FROM events WHERE detail = ?").bind(`dest:${destId}`).first();
  expect(destEventRow).toBeNull();

  // Alias-scoped blocks must be gone before their parent alias is deleted
  const blockRow = await DB().prepare("SELECT id FROM blocks WHERE alias_id = ?").bind(aliasId).first();
  expect(blockRow).toBeNull();
});

test("purge: user with deleted_at within 7 days is retained", async () => {
  const { userId } = await makeUser();

  // Set deleted_at only 3 days ago (within grace period)
  const threeDaysAgo = Date.now() - 3 * 24 * 3_600_000;
  await DB().prepare("UPDATE users SET deleted_at = ?, active = 0, forwarding = 0 WHERE id = ?").bind(threeDaysAgo, userId).run();

  const count = await purgeDeletedAccounts(DB(), Date.now());

  expect(count).toBe(0);

  // User row must still exist
  const userRow = await DB().prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
  expect(userRow).not.toBeNull();
});

test("purge: returns correct count when multiple users qualify", async () => {
  const { userId: u1 } = await makeUser("p1");
  const { userId: u2 } = await makeUser("p2");
  const { userId: u3 } = await makeUser("p3");

  const eightDaysAgo = Date.now() - 8 * 24 * 3_600_000;
  await DB().prepare("UPDATE users SET deleted_at = ?, active = 0 WHERE id IN (?, ?)").bind(eightDaysAgo, u1, u2).run();
  // u3 is not tombstoned — must be retained

  const count = await purgeDeletedAccounts(DB(), Date.now());

  expect(count).toBe(2);

  expect(await DB().prepare("SELECT id FROM users WHERE id = ?").bind(u1).first()).toBeNull();
  expect(await DB().prepare("SELECT id FROM users WHERE id = ?").bind(u2).first()).toBeNull();
  expect(await DB().prepare("SELECT id FROM users WHERE id = ?").bind(u3).first()).not.toBeNull();
});
