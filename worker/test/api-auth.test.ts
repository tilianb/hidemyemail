import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { hashPassword } from "../src/lib/auth";
import { SETTING_DEFAULTS } from "../src/config";

let testEnv: any;
beforeAll(async () => {
  const { saltHex, hashHex } = await hashPassword("hunter2");
  testEnv = { ...env, SESSION_SECRET: "sek", AUTH_PASSWORD_SALT: saltHex, AUTH_PASSWORD_HASH: hashHex };
});

test("login sets cookie; guarded route requires it", async () => {
  const app = createApp();
  const bad = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "nope" }), headers: { "Content-Type": "application/json" } }, testEnv);
  expect(bad.status).toBe(401);

  const ok = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "hunter2" }), headers: { "Content-Type": "application/json" } }, testEnv);
  expect(ok.status).toBe(200);
  const cookie = ok.headers.get("set-cookie")!;
  expect(cookie).toContain("session=");

  const noauth = await app.request("/api/stats", {}, testEnv);
  expect(noauth.status).toBe(401);

  const authed = await app.request("/api/stats", { headers: { cookie: cookie.split(";")[0]! } }, testEnv);
  expect(authed.status).toBe(200);
});

test("native bearer flow: login returns token, guarded route accepts it", async () => {
  const app = createApp();
  await (env.DB as D1Database).prepare("DELETE FROM rate_limits").run();

  // Without X-Auth-Mode the token is never echoed (web app keeps cookie-only).
  const webLogin = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "hunter2" }), headers: { "Content-Type": "application/json" } }, testEnv);
  expect(webLogin.status).toBe(200);
  expect((await webLogin.json() as any).token).toBeUndefined();

  // Native opt-in returns the session token in the body.
  const login = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "hunter2" }), headers: { "Content-Type": "application/json", "X-Auth-Mode": "token" } }, testEnv);
  expect(login.status).toBe(200);
  const token = (await login.json() as any).token as string;
  expect(typeof token).toBe("string");
  expect(token.split(".")[0]).toBe("v2");

  // Guarded route accepts the bearer token without any cookie.
  const authed = await app.request("/api/stats", { headers: { Authorization: `Bearer ${token}` } }, testEnv);
  expect(authed.status).toBe(200);

  // A bogus bearer token is rejected.
  const bad = await app.request("/api/stats", { headers: { Authorization: "Bearer not.a.real.token" } }, testEnv);
  expect(bad.status).toBe(401);
});

test("register and login with new passphrase", async () => {
  const app = createApp();
  // Clear rate limits just in case
  await (env.DB as D1Database).prepare("DELETE FROM rate_limits").run();
  await (env.DB as D1Database).prepare(
    "UPDATE settings SET value = 'true' WHERE key = 'registration_enabled'"
  ).run();
  
  const passphrase = "horse-staple-battery-correct";
  const reg = await app.request("/api/register", { method: "POST", body: JSON.stringify({ password: passphrase }), headers: { "Content-Type": "application/json" } }, testEnv);
  expect(reg.status).toBe(200);

  const login = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: passphrase }), headers: { "Content-Type": "application/json" } }, testEnv);
  expect(login.status).toBe(200);
});

test("public defaults keep registration disabled until admin enables it", async () => {
  expect(SETTING_DEFAULTS.registration_enabled).toBe("false");
});

test("public config exposes alias quota buffer flag", async () => {
  const app = createApp();

  const res = await app.request("/api/config", {}, testEnv);

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ alias_quota_buffer_enabled: true });
});

test("seeded per-alias rate limit matches fallback default", async () => {
  const row = await (env.DB as D1Database).prepare(
    "SELECT value FROM settings WHERE key = 'rate_limit_per_alias'"
  ).first<{ value: string }>();

  expect(row?.value).toBe(SETTING_DEFAULTS.rate_limit_per_alias);
});
