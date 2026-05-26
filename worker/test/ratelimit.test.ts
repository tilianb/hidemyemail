import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { hashPassword } from "../src/lib/auth";

let testEnv: any;
beforeAll(async () => {
  const { saltHex, hashHex } = await hashPassword("hunter2");
  testEnv = { ...env, SESSION_SECRET: "sek", AUTH_PASSWORD_SALT: saltHex, AUTH_PASSWORD_HASH: hashHex };
});

beforeEach(async () => {
  await (env.DB as D1Database).prepare("DELETE FROM rate_limits").run();
});

function withIp(ip: string) {
  return { "Content-Type": "application/json", "cf-connecting-ip": ip };
}

async function loginAttempt(app: ReturnType<typeof createApp>, password: string, ip: string) {
  return app.request("/api/login", { method: "POST", body: JSON.stringify({ password }), headers: withIp(ip) }, testEnv);
}

test("successful logins do not consume rate limit budget", async () => {
  const app = createApp();
  const ip = "10.0.0.1";

  // 12 successful admin logins back-to-back — should all succeed.
  for (let i = 0; i < 12; i++) {
    const res = await loginAttempt(app, "hunter2", ip);
    expect(res.status, `attempt ${i + 1}`).toBe(200);
  }

  const row = await (env.DB as D1Database)
    .prepare("SELECT attempts FROM rate_limits WHERE ip = ?")
    .bind(ip)
    .first<{ attempts: number }>();
  // No row should exist because no failure ever happened.
  expect(row).toBeNull();
});

test("failed logins consume budget and 11th attempt is blocked", async () => {
  const app = createApp();
  const ip = "10.0.0.2";

  // 10 failed attempts → all rejected as Invalid passphrase (401).
  for (let i = 0; i < 10; i++) {
    const res = await loginAttempt(app, "wrong-passphrase", ip);
    expect(res.status, `failed attempt ${i + 1}`).toBe(401);
  }

  // 11th attempt — even with the correct password — is blocked by rate limit.
  const blocked = await loginAttempt(app, "hunter2", ip);
  expect(blocked.status).toBe(429);
});

test("rate limit is shared across login and register endpoints", async () => {
  const app = createApp();
  const ip = "10.0.0.3";

  for (let i = 0; i < 10; i++) {
    const res = await loginAttempt(app, "wrong-passphrase", ip);
    expect(res.status).toBe(401);
  }

  // Register from the same IP should also be 429 now.
  const reg = await app.request("/api/register", {
    method: "POST",
    body: JSON.stringify({ password: "horse-staple-battery-correct-99" }),
    headers: withIp(ip),
  }, testEnv);
  expect(reg.status).toBe(429);
});

test("different IPs have independent buckets", async () => {
  const app = createApp();

  for (let i = 0; i < 10; i++) {
    const res = await loginAttempt(app, "wrong-passphrase", "10.0.0.4");
    expect(res.status).toBe(401);
  }

  // A different IP should still be allowed.
  const ok = await loginAttempt(app, "hunter2", "10.0.0.5");
  expect(ok.status).toBe(200);
});

test("disabled-account 403 does not consume rate limit budget", async () => {
  const app = createApp();
  const ip = "10.0.0.6";

  // Create a user, then deactivate them.
  const passphrase = "horse-staple-battery-disabled-1";
  const reg = await app.request("/api/register", {
    method: "POST",
    body: JSON.stringify({ password: passphrase }),
    headers: withIp(ip),
  }, testEnv);
  expect(reg.status).toBe(200);
  const userId = ((await reg.json()) as { userId: number }).userId;
  await (env.DB as D1Database).prepare("UPDATE users SET active = 0 WHERE id = ?").bind(userId).run();

  // 12 logins for a disabled account → all 403, but none consumes budget.
  for (let i = 0; i < 12; i++) {
    const res = await loginAttempt(app, passphrase, ip);
    expect(res.status, `attempt ${i + 1}`).toBe(403);
  }

  // A subsequent failed login (wrong password) is still allowed — bucket wasn't drained.
  const wrong = await loginAttempt(app, "this-is-not-the-passphrase", ip);
  expect(wrong.status).toBe(401);
});

test("passkey/challenge is not rate limited", async () => {
  const app = createApp();
  const ip = "10.0.0.7";

  // Drain the bucket with failed logins first.
  for (let i = 0; i < 10; i++) {
    const res = await loginAttempt(app, "wrong-passphrase", ip);
    expect(res.status).toBe(401);
  }

  // Challenge endpoint must still respond — it doesn't authenticate, just issues a random challenge.
  const ch = await app.request("/api/passkey/challenge", { method: "POST", headers: withIp(ip) }, testEnv);
  expect(ch.status).toBe(200);
}, 15000);
