/**
 * Web-session → native-app login handoff (PKCE-style):
 *   app opens /app-auth?challenge=SHA256(verifier)
 *   → dashboard submits a top-level POST to /api/app-auth/authorize
 *   → Worker redirects directly to hidemyemail://auth?code=...
 *   → app POSTs /api/app-auth/exchange { code, verifier } → bearer token.
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { hashPassword, sha256Base64url } from "../src/lib/auth";

let testEnv: any;
beforeAll(async () => {
  const { saltHex, hashHex } = await hashPassword("hunter2");
  testEnv = { ...env, SESSION_SECRET: "sek", AUTH_PASSWORD_SALT: saltHex, AUTH_PASSWORD_HASH: hashHex };
});

beforeEach(async () => {
  await (env.DB as D1Database).prepare("DELETE FROM rate_limits").run();
});

const VERIFIER = "test-verifier-test-verifier-test-verifier-12";

// Returns BOTH login cookies (session + fresh-auth): /app-auth/authorize is
// fresh-auth gated, so the dashboard sends the full cookie jar.
async function loginCookie(app: ReturnType<typeof createApp>): Promise<string> {
  const ok = await app.request("/api/login", {
    method: "POST",
    body: JSON.stringify({ password: "hunter2" }),
    headers: { "Content-Type": "application/json" },
  }, testEnv);
  expect(ok.status).toBe(200);
  // workerd's Headers type lacks getSetCookie(); both cookies use Max-Age
  // (never Expires), so name=value pairs are safely comma/semicolon-free.
  const header = ok.headers.get("set-cookie")!;
  return [...header.matchAll(/__Host-[\w-]+=[^;,]+/g)].map((m) => m[0]).join("; ");
}

async function authorize(app: ReturnType<typeof createApp>, cookie: string, challenge: string) {
  return app.request("/api/app-auth/authorize", {
    method: "POST",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ challenge }),
  }, testEnv);
}

function codeFromRedirect(response: Response): string {
  const location = response.headers.get("location");
  expect(location).toMatch(/^hidemyemail:\/\/auth\?code=/);
  return new URL(location!).searchParams.get("code")!;
}

test("authorization redirects to the fixed app callback without exposing code in a body", async () => {
  const app = createApp();
  const cookie = await loginCookie(app);
  const challenge = await sha256Base64url(VERIFIER);

  const codeRes = await authorize(app, cookie, challenge);
  expect(codeRes.status).toBe(303);
  expect(codeRes.headers.get("content-type") ?? "").not.toContain("application/json");
  expect(await codeRes.text()).toBe("");
  const code = codeFromRedirect(codeRes);
  expect(code.startsWith("appauth2.")).toBe(true);

  const exchange = await app.request("/api/app-auth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Mode": "token" },
    body: JSON.stringify({ code, verifier: VERIFIER }),
  }, testEnv);
  expect(exchange.status).toBe(200);
  const { token, fresh_auth } = await exchange.json() as { token: string; fresh_auth: string };
  // The exchange follows an interactive web login moments earlier, so it also
  // hands the app a fresh-auth token for the sensitive-action gate.
  expect(typeof fresh_auth).toBe("string");

  const authed = await app.request("/api/stats", {
    headers: { Authorization: `Bearer ${token}` },
  }, testEnv);
  expect(authed.status).toBe(200);
});

test("GET and the old JSON code API are not available", async () => {
  const app = createApp();
  const cookie = await loginCookie(app);
  const challenge = await sha256Base64url(VERIFIER);

  const get = await app.request(`/api/app-auth/authorize?challenge=${challenge}`, { headers: { cookie } }, testEnv);
  expect(get.status).toBe(404);

  const oldApi = await app.request("/api/app-auth/code", {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ challenge }),
  }, testEnv);
  expect(oldApi.status).toBe(404);
});

test("handoff code can be exchanged only once", async () => {
  const app = createApp();
  const cookie = await loginCookie(app);
  const challenge = await sha256Base64url(VERIFIER);
  const code = codeFromRedirect(await authorize(app, cookie, challenge));
  const exchange = () => app.request("/api/app-auth/exchange", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, verifier: VERIFIER }),
  }, testEnv);

  const responses = await Promise.all([exchange(), exchange()]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
});

test("exchange rejects a handoff code minted before auth version advances", async () => {
  const app = createApp();
  await (env.DB as D1Database).prepare("UPDATE users SET auth_version = 0 WHERE id = 1").run();
  const cookie = await loginCookie(app);
  const challenge = await sha256Base64url(VERIFIER);
  const code = codeFromRedirect(await authorize(app, cookie, challenge));

  await (env.DB as D1Database).prepare("UPDATE users SET auth_version = auth_version + 1 WHERE id = 1").run();
  const exchange = await app.request("/api/app-auth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Mode": "token" },
    body: JSON.stringify({ code, verifier: VERIFIER }),
  }, testEnv);

  expect(exchange.status).toBe(401);
  const body = await exchange.json() as Record<string, unknown>;
  expect(body.token).toBeUndefined();
  expect(body.fresh_auth).toBeUndefined();
});

test("code requires a session", async () => {
  const app = createApp();
  const res = await authorize(app, "", await sha256Base64url(VERIFIER));
  expect(res.status).toBe(401);
});

test("session-only authorization reauthenticates without losing the challenge, then fresh authorization reaches the app", async () => {
  const app = createApp();
  const cookie = await loginCookie(app);
  const sessionOnly = cookie.split("; ").find((c) => c.startsWith("__Host-session="))!;
  const challenge = await sha256Base64url(VERIFIER);

  const reauth = await authorize(app, sessionOnly, challenge);
  expect(reauth.status).toBe(303);
  expect(reauth.headers.get("location")).toBe(`/app-auth?challenge=${encodeURIComponent(challenge)}`);
  const clearedCookies = reauth.headers.get("set-cookie") ?? "";
  expect(clearedCookies).toContain("__Host-session=;");
  expect(clearedCookies).toContain("__Host-fresh-auth=;");
  expect(clearedCookies).not.toContain("code=");

  const authorized = await authorize(app, cookie, challenge);
  expect(authorized.status).toBe(303);
  codeFromRedirect(authorized);
});

test("exchange refuses browser requests (Origin present)", async () => {
  const app = createApp();
  const cookie = await loginCookie(app);
  const challenge = await sha256Base64url(VERIFIER);

  const code = codeFromRedirect(await authorize(app, cookie, challenge));

  // Same-origin JS holds code + verifier, but the browser pins Origin onto
  // the POST — the exchange must refuse to convert it into a bearer token.
  const exchange = await app.request("/api/app-auth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.hidemyemail.dev" },
    body: JSON.stringify({ code, verifier: VERIFIER }),
  }, testEnv);
  expect(exchange.status).toBe(403);
});

test("code rejects a malformed challenge", async () => {
  const app = createApp();
  const sessionOnly = (await loginCookie(app)).split("; ").find((c) => c.startsWith("__Host-session="))!;
  const res = await authorize(app, sessionOnly, "definitely.not/base64url!");
  expect(res.status).toBe(400);
  expect(res.headers.get("location")).toBeNull();
});

test("exchange rejects the wrong verifier (stolen code is useless)", async () => {
  const app = createApp();
  const cookie = await loginCookie(app);
  const challenge = await sha256Base64url(VERIFIER);

  const code = codeFromRedirect(await authorize(app, cookie, challenge));

  const exchange = await app.request("/api/app-auth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, verifier: "some-other-verifier-entirely-0000000000000" }),
  }, testEnv);
  expect(exchange.status).toBe(401);
});

test("exchange rejects a tampered code", async () => {
  const app = createApp();
  const cookie = await loginCookie(app);
  const challenge = await sha256Base64url(VERIFIER);

  const code = codeFromRedirect(await authorize(app, cookie, challenge));

  // Flip the embedded user id from 1 to 2 — the HMAC must catch it.
  const tampered = code.replace("appauth2.1.", "appauth2.2.");
  expect(tampered).not.toBe(code);

  const exchange = await app.request("/api/app-auth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: tampered, verifier: VERIFIER }),
  }, testEnv);
  expect(exchange.status).toBe(401);
});

test("failed exchanges are rate limited per IP", async () => {
  const app = createApp();
  for (let i = 0; i < 10; i++) {
    await app.request("/api/app-auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "9.9.9.9" },
      body: JSON.stringify({ code: "appauth.1.99.x.deadbeef", verifier: "v" }),
    }, testEnv);
  }
  const blocked = await app.request("/api/app-auth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": "9.9.9.9" },
    body: JSON.stringify({ code: "appauth.1.99.x.deadbeef", verifier: "v" }),
  }, testEnv);
  expect(blocked.status).toBe(429);
});
