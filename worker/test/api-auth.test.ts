import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { hashPassword } from "../src/lib/auth";

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

test("register and login with new passphrase", async () => {
  const app = createApp();
  // Clear rate limits just in case
  await (env.DB as D1Database).prepare("DELETE FROM rate_limits").run();
  
  const passphrase = "horse-staple-battery-correct";
  const reg = await app.request("/api/register", { method: "POST", body: JSON.stringify({ password: passphrase }), headers: { "Content-Type": "application/json" } }, testEnv);
  expect(reg.status).toBe(200);

  const login = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: passphrase }), headers: { "Content-Type": "application/json" } }, testEnv);
  expect(login.status).toBe(200);
});
