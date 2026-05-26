import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { signSession, derivePassphraseHash } from "../src/lib/auth";

let testEnv: any;

beforeAll(async () => {
  testEnv = { ...env, SESSION_SECRET: "sek", AUTH_PASSWORD_SALT: "deadbeef" };
});

async function makeUser(active: number = 1): Promise<number> {
  // Create user with given active flag. Use unique passphrase hash per call.
  const hash = await derivePassphraseHash("p-" + Math.random(), "deadbeef");
  const res = await (env.DB as D1Database).prepare(
    "INSERT INTO users (passphrase_hash, active, created_at) VALUES (?, ?, ?)"
  ).bind(hash, active, Date.now()).run();
  return Number(res.meta.last_row_id);
}

beforeEach(async () => {
  // Clean state between tests. Only touch tables relevant to these tests.
  const db = env.DB as D1Database;
  await db.prepare("DELETE FROM events").run();
  await db.prepare("DELETE FROM reverse_map").run();
  await db.prepare("DELETE FROM blocks").run();
  await db.prepare("DELETE FROM aliases").run();
  await db.prepare("DELETE FROM domains").run();
  await db.prepare("DELETE FROM users WHERE id > 1").run();
  await db.prepare("DELETE FROM rate_limits").run();
});

test("P1: DELETE /domains/:id returns 404 for another user's domain (no IDOR leak)", async () => {
  const app = createApp();
  const victimId = await makeUser();
  const attackerId = await makeUser();

  // Victim owns a domain
  const ins = await (env.DB as D1Database).prepare(
    "INSERT INTO domains (user_id, is_global, domain, created_at) VALUES (?, 0, 'victim.hidemyemail.dev', ?)"
  ).bind(victimId, Date.now()).run();
  const domainId = Number(ins.meta.last_row_id);

  // Attacker (non-admin) tries to delete it
  const attackerCookie = "__Host-session=" + (await signSession("sek", attackerId, 3600));
  const res = await app.request(`/api/domains/${domainId}`, { method: "DELETE", headers: { cookie: attackerCookie } }, testEnv);
  expect(res.status).toBe(404);

  // Victim's domain still exists
  const stillThere = await (env.DB as D1Database).prepare("SELECT id FROM domains WHERE id = ?").bind(domainId).first();
  expect(stillThere).toBeTruthy();
});

test("P1: admin (userId=1) can still delete any non-global domain", async () => {
  const app = createApp();
  const victimId = await makeUser();
  const ins = await (env.DB as D1Database).prepare(
    "INSERT INTO domains (user_id, is_global, domain, created_at) VALUES (?, 0, 'admin-target.hidemyemail.dev', ?)"
  ).bind(victimId, Date.now()).run();
  const domainId = Number(ins.meta.last_row_id);

  const adminCookie = "__Host-session=" + (await signSession("sek", 1, 3600));
  const res = await app.request(`/api/domains/${domainId}`, { method: "DELETE", headers: { cookie: adminCookie } }, testEnv);
  expect(res.status).toBe(200);

  const gone = await (env.DB as D1Database).prepare("SELECT id FROM domains WHERE id = ?").bind(domainId).first();
  expect(gone).toBeFalsy();
});

test("P2: recovery /recover/verify rejects inactive users", async () => {
  const app = createApp();
  const userId = await makeUser(0); // inactive

  const token = "rec-tok-" + Math.random();
  const code = "123456";
  const futureMs = Date.now() + 60_000;
  await (env.DB as D1Database).prepare(
    "UPDATE users SET recovery_token = ?, recovery_mfa_code = ?, recovery_expires_at = ? WHERE id = ?"
  ).bind(token, code, futureMs, userId).run();

  const res = await app.request("/api/recover/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, code })
  }, testEnv);
  expect(res.status).toBe(400);

  // No session cookie issued
  const setCookie = res.headers.get("set-cookie") || "";
  expect(setCookie).not.toContain("__Host-session=");

  // Passphrase not rotated
  const after = await (env.DB as D1Database).prepare("SELECT recovery_token FROM users WHERE id = ?").bind(userId).first<{ recovery_token: string | null }>();
  expect(after?.recovery_token).toBe(token); // unchanged
});

test("P2: recovery /recover/verify works for active users with valid token+code", async () => {
  const app = createApp();
  const userId = await makeUser(1);
  const token = "rec-tok-ok-" + Math.random();
  const code = "654321";
  const futureMs = Date.now() + 60_000;
  await (env.DB as D1Database).prepare(
    "UPDATE users SET recovery_token = ?, recovery_mfa_code = ?, recovery_expires_at = ? WHERE id = ?"
  ).bind(token, code, futureMs, userId).run();

  const res = await app.request("/api/recover/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, code })
  }, testEnv);
  expect(res.status).toBe(200);
  const body = await res.json<{ ok: boolean; passphrase: string }>();
  expect(body.ok).toBe(true);
  expect(typeof body.passphrase).toBe("string");
});

test("P2: recovery /recover/send-code rejects inactive users", async () => {
  const app = createApp();
  const userId = await makeUser(0);
  const token = "rec-tok-send-" + Math.random();
  const futureMs = Date.now() + 60_000;
  await (env.DB as D1Database).prepare(
    "UPDATE users SET recovery_token = ?, recovery_expires_at = ? WHERE id = ?"
  ).bind(token, futureMs, userId).run();

  const res = await app.request("/api/recover/send-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  }, testEnv);
  expect(res.status).toBe(400);
});
