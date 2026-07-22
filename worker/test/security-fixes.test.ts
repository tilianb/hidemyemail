import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/api/app";
import { signFreshAuth, signSession, verifyFreshAuth, verifySession, derivePassphraseHash } from "../src/lib/auth";
import { encryptDestination } from "../src/lib/crypto";
import { generatePassphrase } from "../src/lib/passphrase";
import { hashBackupCode } from "../src/lib/totp";

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
  await db.prepare("UPDATE users SET active = 1 WHERE id = 1").run();
  await db.prepare("DELETE FROM rate_limits").run();
});

afterEach(() => vi.restoreAllMocks());

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

  // Enroll in MFA to ensure it gets reset
  await (env.DB as D1Database).prepare(
    "INSERT INTO mfa (user_id, totp_secret, totp_enabled, totp_backup_codes) VALUES (?, 'sec', 1, '[]')"
  ).bind(userId).run();

  const res = await app.request("/api/recover/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, code })
  }, testEnv);
  expect(res.status).toBe(200);
  const body = await res.json<{ ok: boolean; passphrase: string }>();
  expect(body.ok).toBe(true);
  expect(typeof body.passphrase).toBe("string");

  const mfaAfter = await (env.DB as D1Database).prepare("SELECT totp_enabled FROM mfa WHERE user_id = ?").bind(userId).first<{ totp_enabled: number }>();
  expect(mfaAfter?.totp_enabled).toBe(0);
});

test("P2: admin-token recovery invalidates old credentials and returns the winning auth version", async () => {
  const app = createApp();
  const userId = await makeUser(1);
  const oldSession = await signSession("sek", userId, 3600, 0);
  const oldFresh = await signFreshAuth("sek", userId, 300, 0);
  const token = "rec-tok-version-" + Math.random();
  const code = "345678";
  await (env.DB as D1Database).prepare(
    "UPDATE users SET auth_version = 0, recovery_token = ?, recovery_mfa_code = ?, recovery_expires_at = ? WHERE id = ?"
  ).bind(token, code, Date.now() + 60_000, userId).run();

  const recovered = await app.request("/api/recover/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, code }),
  }, testEnv);
  expect(recovered.status).toBe(200);

  const cookieHeader = recovered.headers.get("set-cookie") ?? "";
  const sessionToken = cookieHeader.match(/__Host-session=([^;,]+)/)?.[1];
  const freshToken = cookieHeader.match(/__Host-fresh-auth=([^;,]+)/)?.[1];
  expect(sessionToken).toBeTruthy();
  expect(freshToken).toBeTruthy();
  expect(await verifySession("sek", sessionToken!)).toEqual({ userId, authVersion: 1 });
  expect(await verifyFreshAuth("sek", freshToken!, userId, 1)).toBe(true);

  const oldGuarded = await app.request("/api/stats", {
    headers: { Authorization: `Bearer ${oldSession}` },
  }, testEnv);
  expect(oldGuarded.status).toBe(401);
  const oldFreshGuarded = await app.request("/api/account/recovery-codes", {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}`, "X-Fresh-Auth": oldFresh },
  }, testEnv);
  expect(oldFreshGuarded.status).toBe(401);
  expect((await oldFreshGuarded.json() as { error: string }).error).toBe("Fresh authentication required");
});

test("P2: concurrent admin-token recovery has exactly one winner", async () => {
  const app = createApp();
  const userId = await makeUser(1);
  const token = "rec-tok-race-" + Math.random();
  const code = "456789";
  const futureMs = Date.now() + 60_000;
  await (env.DB as D1Database).prepare(
    "UPDATE users SET recovery_token = ?, recovery_mfa_code = ?, recovery_expires_at = ? WHERE id = ?"
  ).bind(token, code, futureMs, userId).run();
  const request = () => app.request("/api/recover/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, code }),
  }, testEnv);

  const responses = await Promise.all([request(), request()]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
});

test("P2: admin recovery rejects a token that expires after selection but before consumption", async () => {
  const app = createApp();
  const userId = await makeUser(1);
  const token = "rec-tok-expiry-" + Math.random();
  const code = "567890";
  const expiry = 10_000;
  await (env.DB as D1Database).prepare(
    "UPDATE users SET recovery_token = ?, recovery_mfa_code = ?, recovery_expires_at = ? WHERE id = ?"
  ).bind(token, code, expiry, userId).run();
  let calls = 0;
  vi.spyOn(Date, "now").mockImplementation(() => ++calls <= 2 ? expiry - 1 : expiry + 1);

  const res = await app.request("/api/recover/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, code }),
  }, testEnv);

  expect(res.status).toBe(400);
  expect(res.headers.get("set-cookie") ?? "").not.toContain("__Host-session=");
  const after = await (env.DB as D1Database).prepare(
    "SELECT recovery_token FROM users WHERE id = ?"
  ).bind(userId).first<{ recovery_token: string | null }>();
  expect(after?.recovery_token).toBe(token);
});

test("P2: stale MFA challenge cannot mint credentials after recovery advances auth version", async () => {
  const app = createApp();
  const password = "mfa-version-password";
  const passphraseHash = await derivePassphraseHash(password, testEnv.AUTH_PASSWORD_SALT);
  const userId = await makeUser(1);
  const backupCode = "ABCD-EFGH";
  const encryptedSecret = await encryptDestination("JBSWY3DPEHPK3PXP", testEnv.DESTINATION_ENCRYPTION_KEY);
  await (env.DB as D1Database).prepare("UPDATE users SET passphrase_hash = ?, auth_version = 0 WHERE id = ?")
    .bind(passphraseHash, userId).run();
  await (env.DB as D1Database).prepare(
    "INSERT INTO mfa (user_id, totp_secret, totp_enabled, totp_backup_codes) VALUES (?, ?, 1, ?)"
  ).bind(userId, encryptedSecret, JSON.stringify([await hashBackupCode(backupCode)])).run();

  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Mode": "token" },
    body: JSON.stringify({ password }),
  }, testEnv);
  const challenge = (await login.json() as { mfa_token: string }).mfa_token;
  expect(challenge).toBeTruthy();
  await (env.DB as D1Database).prepare("UPDATE users SET auth_version = 1 WHERE id = ?").bind(userId).run();

  const completion = await app.request("/api/mfa/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Mode": "token" },
    body: JSON.stringify({ code: backupCode, mfa_token: challenge }),
  }, testEnv);

  expect(completion.status).toBe(401);
  const body = await completion.json() as Record<string, unknown>;
  expect(body.token).toBeUndefined();
  expect(body.fresh_auth).toBeUndefined();
});

test("P3: /api/settings/mfa/setup refuses to overwrite enabled MFA (re-enrol bypass)", async () => {
  const app = createApp();
  const userId = await makeUser(1);

  // User has MFA enabled.
  await (env.DB as D1Database).prepare(
    "INSERT INTO mfa (user_id, totp_secret, totp_enabled, totp_backup_codes) VALUES (?, 'oldsec', 1, '[\"hashedA\",\"hashedB\"]')"
  ).bind(userId).run();

  const cookie = "__Host-session=" + (await signSession("sek", userId, 3600));
  const freshCookie = "__Host-fresh-auth=" + (await signFreshAuth("sek", userId, 300));
  const res = await app.request("/api/settings/mfa/setup", {
    method: "POST",
    headers: { cookie: `${cookie}; ${freshCookie}`, "Content-Type": "application/json" },
    body: "{}"
  }, testEnv);

  expect(res.status).toBe(409);

  // Secret and backup codes must be untouched — bypass would have wiped them.
  const after = await (env.DB as D1Database).prepare(
    "SELECT totp_secret, totp_enabled, totp_backup_codes FROM mfa WHERE user_id = ?"
  ).bind(userId).first<{ totp_secret: string; totp_enabled: number; totp_backup_codes: string }>();
  expect(after?.totp_secret).toBe("oldsec");
  expect(after?.totp_enabled).toBe(1);
  expect(after?.totp_backup_codes).toBe('["hashedA","hashedB"]');
});

test("P3: /api/settings/mfa/setup still works when MFA not yet enabled", async () => {
  const app = createApp();
  const userId = await makeUser(1);

  const cookie = "__Host-session=" + (await signSession("sek", userId, 3600));
  const freshCookie = "__Host-fresh-auth=" + (await signFreshAuth("sek", userId, 300));
  const res = await app.request("/api/settings/mfa/setup", {
    method: "POST",
    headers: { cookie: `${cookie}; ${freshCookie}`, "Content-Type": "application/json" },
    body: "{}"
  }, testEnv);

  expect(res.status).toBe(200);
  const body = await res.json<{ secret: string; uri: string }>();
  expect(typeof body.secret).toBe("string");
  expect(body.uri).toContain("otpauth://");
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

test("P4: generated recovery passphrases have at least 100 bits of entropy from current word list", () => {
  const passphrase = generatePassphrase();
  expect(passphrase.split("-")).toHaveLength(16);
});

test("P4: inactive users cannot use existing session cookies", async () => {
  const app = createApp();
  const userId = await makeUser(0);
  const cookie = "__Host-session=" + (await signSession("sek", userId, 3600));

  const res = await app.request("/api/stats", { headers: { cookie } }, testEnv);

  expect(res.status).toBe(403);
});

test("P4: inactive admin cannot use existing session cookies", async () => {
  const app = createApp();
  await (env.DB as D1Database).prepare("UPDATE users SET active = 0 WHERE id = 1").run();
  const cookie = "__Host-session=" + (await signSession("sek", 1, 3600));

  const res = await app.request("/api/stats", { headers: { cookie } }, testEnv);

  expect(res.status).toBe(403);
  await (env.DB as D1Database).prepare("UPDATE users SET active = 1 WHERE id = 1").run();
});

test("P4: credentialed CORS only allows exact configured origins", async () => {
  const app = createApp();
  await (env.DB as D1Database).prepare(
    "UPDATE settings SET value = 'https://hidemyemail.dev,http://localhost:5173' WHERE key = 'cors_allowed_domains'"
  ).run();

  const evil = await app.request("/api/aliases", { headers: { Origin: "https://foo.pages.dev" } }, testEnv);
  expect(evil.headers.get("access-control-allow-origin")).toBeNull();

  const allowed = await app.request("/api/aliases", { headers: { Origin: "https://hidemyemail.dev" } }, testEnv);
  expect(allowed.headers.get("access-control-allow-origin")).toBe("https://hidemyemail.dev");
});

test("P4: MFA setup requires fresh auth", async () => {
  const app = createApp();
  const userId = await makeUser(1);
  const cookie = "__Host-session=" + (await signSession("sek", userId, 3600));

  const res = await app.request("/api/settings/mfa/setup", {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: "{}"
  }, testEnv);

  expect(res.status).toBe(401);
});

test("P4: MFA disable failures are rate limited", async () => {
  const app = createApp();
  const userId = await makeUser(1);
  const cookie = "__Host-session=" + (await signSession("sek", userId, 3600));
  const freshCookie = "__Host-fresh-auth=" + (await signFreshAuth("sek", userId, 300));
  const secret = await encryptDestination("JBSWY3DPEHPK3PXP", testEnv.DESTINATION_ENCRYPTION_KEY);
  await (env.DB as D1Database).prepare(
    "INSERT INTO mfa (user_id, totp_secret, totp_enabled, totp_backup_codes) VALUES (?, ?, 1, '[]')"
  ).bind(userId, secret).run();

  for (let i = 0; i < 10; i++) {
    const res = await app.request("/api/settings/mfa/disable", {
      method: "POST",
      headers: { cookie: `${cookie}; ${freshCookie}`, "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify({ code: "000000" })
    }, testEnv);
    expect(res.status).toBe(401);
  }

  const limited = await app.request("/api/settings/mfa/disable", {
    method: "POST",
    headers: { cookie: `${cookie}; ${freshCookie}`, "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify({ code: "000000" })
  }, testEnv);
  expect(limited.status).toBe(429);
});
