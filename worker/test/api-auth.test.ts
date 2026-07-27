import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { hashPassword, signMfaChallenge, signPasskeyMfaChallenge, verifyPasskeyMfaChallenge } from "../src/lib/auth";
import { SETTING_DEFAULTS } from "../src/config";

let testEnv: any;

async function signLegacyToken(prefix: "v2" | "fresh", userId: number, ttlSeconds: number): Promise<string> {
  const payload = `${prefix}.${userId}.${Math.floor(Date.now() / 1000) + ttlSeconds}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("sek"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${payload}.${sig}`;
}
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
  expect(token.split(".")[0]).toBe("v3");

  // Guarded route accepts the bearer token without any cookie.
  const authed = await app.request("/api/stats", { headers: { Authorization: `Bearer ${token}` } }, testEnv);
  expect(authed.status).toBe(200);

  // A bogus bearer token is rejected.
  const bad = await app.request("/api/stats", { headers: { Authorization: "Bearer not.a.real.token" } }, testEnv);
  expect(bad.status).toBe(401);
});

test("native bearer flow: fresh_auth token unlocks fresh-auth-gated routes", async () => {
  const app = createApp();
  await (env.DB as D1Database).prepare("DELETE FROM rate_limits").run();

  // Web mode must not leak the fresh-auth token into the body (cookie only).
  const webLogin = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "hunter2" }), headers: { "Content-Type": "application/json" } }, testEnv);
  expect((await webLogin.json() as any).fresh_auth).toBeUndefined();

  const login = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "hunter2" }), headers: { "Content-Type": "application/json", "X-Auth-Mode": "token" } }, testEnv);
  const body = await login.json() as any;
  const token = body.token as string;
  const freshAuth = body.fresh_auth as string;
  expect(typeof freshAuth).toBe("string");

  // Bearer token alone must not reach a fresh-auth-gated route…
  const stale = await app.request("/api/account/export", { headers: { Authorization: `Bearer ${token}` } }, testEnv);
  expect(stale.status).toBe(401);
  expect(((await stale.json()) as any).error).toBe("Fresh authentication required");

  // …but the X-Fresh-Auth header from the login response does.
  const fresh = await app.request("/api/account/export", { headers: { Authorization: `Bearer ${token}`, "X-Fresh-Auth": freshAuth } }, testEnv);
  expect(fresh.status).toBe(200);

  // A forged header is rejected.
  const forged = await app.request("/api/account/export", { headers: { Authorization: `Bearer ${token}`, "X-Fresh-Auth": "not.a.real.token" } }, testEnv);
  expect(forged.status).toBe(401);
});

test("legacy v2 session and fresh credentials work only while auth version is zero", async () => {
  const app = createApp();
  await (env.DB as D1Database).prepare("UPDATE users SET auth_version = 0 WHERE id = 1").run();
  const token = await signLegacyToken("v2", 1, 3600);
  const fresh = await signLegacyToken("fresh", 1, 300);

  const accepted = await app.request("/api/account/export", {
    headers: { Authorization: `Bearer ${token}`, "X-Fresh-Auth": fresh },
  }, testEnv);
  expect(accepted.status).toBe(200);

  await (env.DB as D1Database).prepare("UPDATE users SET auth_version = 1 WHERE id = 1").run();
  const rejected = await app.request("/api/account/export", {
    headers: { Authorization: `Bearer ${token}`, "X-Fresh-Auth": fresh },
  }, testEnv);
  expect(rejected.status).toBe(401);
});

test("token mode is refused when a browser Origin is present (XSS guard)", async () => {
  const app = createApp();
  await (env.DB as D1Database).prepare("DELETE FROM rate_limits").run();

  // A browser always pins the Origin header on POST; page JS can't strip it.
  // Even with X-Auth-Mode: token, the token must not be echoed in that case,
  // so an XSS can't escalate a cookie session into an exfiltratable token.
  const res = await app.request("/api/login", {
    method: "POST",
    body: JSON.stringify({ password: "hunter2" }),
    headers: { "Content-Type": "application/json", "X-Auth-Mode": "token", Origin: "https://app.hidemyemail.dev" },
  }, testEnv);
  expect(res.status).toBe(200);
  expect((await res.json() as any).token).toBeUndefined();
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

  const user = await (env.DB as D1Database).prepare(
    "SELECT passphrase_verifier FROM users WHERE id = ?"
  ).bind((await reg.clone().json() as { userId: number }).userId).first<{ passphrase_verifier: string | null }>();
  expect(user?.passphrase_verifier).toMatch(/^v1\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
});

test("public defaults keep registration disabled until admin enables it", async () => {
  expect(SETTING_DEFAULTS.registration_enabled).toBe("false");
});

test("public config exposes user-facing settings", async () => {
  const app = createApp();
  await (env.DB as D1Database).prepare(
    "UPDATE settings SET value = 'false' WHERE key = 'registration_enabled'"
  ).run();

  const res = await app.request("/api/config", {}, testEnv);

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    registration_enabled: false,
    alias_quota_buffer_enabled: true,
    catch_all_auto_create: true,
    inline_actions_default_enabled: false,
  });
});

test("seeded per-alias rate limit matches fallback default", async () => {
  const row = await (env.DB as D1Database).prepare(
    "SELECT value FROM settings WHERE key = 'rate_limit_per_alias'"
  ).first<{ value: string }>();

  expect(row?.value).toBe(SETTING_DEFAULTS.rate_limit_per_alias);
});

test("native passkey challenge echoes the challenge token; web does not", async () => {
  const app = createApp();
  const appEnv = { ...testEnv, APP_ORIGIN: "https://app.hidemyemail.dev" };

  // Native: X-Auth-Mode token + no Origin → token in body so the cookieless
  // client can return it on verify.
  const native = await app.request("/api/passkey/challenge", {
    method: "POST",
    headers: { "X-Auth-Mode": "token" },
  }, appEnv);
  expect(native.status).toBe(200);
  const nbody = await native.json() as any;
  expect(typeof nbody.challenge).toBe("string");
  expect(typeof nbody.passkey_token).toBe("string");

  // Web: Origin present → no token leaked into the body.
  const web = await app.request("/api/passkey/challenge", {
    method: "POST",
    headers: { Origin: "https://app.hidemyemail.dev" },
  }, appEnv);
  expect(web.status).toBe(200);
  expect((await web.json() as any).passkey_token).toBeUndefined();
});

test("passkey challenge uses the configured custom-domain RP ID", async () => {
  const res = await createApp().request("/api/passkey/challenge", { method: "POST" }, {
    ...testEnv,
    APP_ORIGIN: "https://mail.example.net",
  });
  expect(res.status).toBe(200);
  expect((await res.json() as any).rpId).toBe("mail.example.net");
});

test("passkey challenge fails with a controlled configuration error when APP_ORIGIN is missing or invalid", async () => {
  const app = createApp();
  for (const appOrigin of [undefined, "http://mail.example.net", "not a URL"]) {
    const requestEnv = { ...testEnv, APP_ORIGIN: appOrigin };
    const res = await app.request("/api/passkey/challenge", { method: "POST" }, requestEnv);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Passkey authentication is not configured" });
  }
});

test("account-bound passkey MFA challenge restricts credentials and rejects missing passkeys", async () => {
  const app = createApp();
  const db = env.DB as D1Database;
  const requestEnv = { ...testEnv, APP_ORIGIN: "https://app.hidemyemail.dev" };
  await db.prepare("UPDATE users SET active = 1, deleted_at = NULL, auth_version = 4 WHERE id = 1").run();
  await db.prepare("DELETE FROM mfa WHERE user_id = 1").run();
  await db.prepare("DELETE FROM passkey_credentials WHERE user_id = 1").run();
  await db.prepare("INSERT INTO mfa (user_id, totp_secret, totp_enabled, totp_backup_codes) VALUES (1, 'secret', 1, '[]')").run();
  const mfaToken = await signMfaChallenge("sek", 1, 4);
  const cookie = `__Host-mfa-challenge=${mfaToken}`;

  const missing = await app.request("/api/passkey/challenge", {
    method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ mfa: true }),
  }, requestEnv);
  expect(missing.status).toBe(409);
  expect(await missing.json()).toEqual({ error: "No passkeys registered for this account" });

  await db.prepare("INSERT INTO passkey_credentials (id, user_id, public_key, sign_count, transports, created_at) VALUES (?, 1, 'key', 0, ?, ?)")
    .bind("mfa-credential", JSON.stringify(["internal"]), Date.now()).run();
  const challenge = await app.request("/api/passkey/challenge", {
    method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ mfa: true }),
  }, requestEnv);
  expect(challenge.status).toBe(200);
  const body = await challenge.json() as any;
  expect(body.allowCredentials).toEqual([{ id: "mfa-credential", type: "public-key", transports: ["internal"] }]);
  expect(body.passkey_token).toBeUndefined();
  const passkeyCookie = challenge.headers.get("set-cookie")!;
  const signed = decodeURIComponent(passkeyCookie.match(/__Host-passkey-challenge=([^;]+)/)![1]!);
  expect(await verifyPasskeyMfaChallenge("sek", signed)).toMatchObject({ userId: 1, authVersion: 4, challenge: body.challenge });
});

test("bound passkey challenge rejects stale auth version and issues native token", async () => {
  const app = createApp();
  const db = env.DB as D1Database;
  const requestEnv = { ...testEnv, APP_ORIGIN: "https://app.hidemyemail.dev" };
  await db.prepare("UPDATE users SET active = 1, deleted_at = NULL, auth_version = 8 WHERE id = 1").run();
  await db.prepare("DELETE FROM mfa WHERE user_id = 1").run();
  await db.prepare("DELETE FROM passkey_credentials WHERE user_id = 1").run();
  await db.prepare("INSERT INTO mfa (user_id, totp_secret, totp_enabled, totp_backup_codes) VALUES (1, 'secret', 1, '[]')").run();
  await db.prepare("INSERT INTO passkey_credentials (id, user_id, public_key, sign_count, created_at) VALUES ('native-mfa-credential', 1, 'key', 0, ?)").bind(Date.now()).run();

  const staleToken = await signMfaChallenge("sek", 1, 7);
  const stale = await app.request("/api/passkey/challenge", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Auth-Mode": "token" },
    body: JSON.stringify({ mfa: true, mfa_token: staleToken }),
  }, requestEnv);
  expect(stale.status).toBe(401);

  const currentToken = await signMfaChallenge("sek", 1, 8);
  const native = await app.request("/api/passkey/challenge", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Auth-Mode": "token" },
    body: JSON.stringify({ mfa: true, mfa_token: currentToken }),
  }, requestEnv);
  expect(native.status).toBe(200);
  const body = await native.json() as any;
  expect(body.allowCredentials.map((credential: any) => credential.id)).toEqual(["native-mfa-credential"]);
  expect(await verifyPasskeyMfaChallenge("sek", body.passkey_token)).toMatchObject({ userId: 1, authVersion: 8 });
});

test("bound passkey verification rejects another account's credential before admission", async () => {
  const app = createApp();
  const db = env.DB as D1Database;
  await db.prepare("UPDATE users SET active = 1, deleted_at = NULL, auth_version = 3 WHERE id = 1").run();
  const other = await db.prepare(
    "INSERT INTO users (passphrase_hash, active, auth_version, created_at) VALUES (?, 1, 3, ?)"
  ).bind(`other-passkey-user-${crypto.randomUUID()}`, Date.now()).run();
  const otherId = Number(other.meta.last_row_id);
  await db.prepare(
    "INSERT INTO passkey_credentials (id, user_id, public_key, sign_count, created_at) VALUES ('other-account-credential', ?, 'key', 0, ?)"
  ).bind(otherId, Date.now()).run();
  const token = await signPasskeyMfaChallenge("sek", 1, 3, "challenge");

  const response = await app.request("/api/passkey/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Mode": "token" },
    body: JSON.stringify({ id: "other-account-credential", passkey_token: token }),
  }, { ...testEnv, APP_ORIGIN: "https://app.hidemyemail.dev" });

  expect(response.status).toBe(401);
  const body = await response.json() as Record<string, unknown>;
  expect(body.token).toBeUndefined();
  expect(body.fresh_auth).toBeUndefined();
});

test("apple-app-site-association: 404 until APPLE_APP_ID is configured", async () => {
  const app = createApp();

  const envWithoutApple = { ...testEnv };
  delete envWithoutApple.APPLE_APP_ID;

  const missing = await app.request("/.well-known/apple-app-site-association", {}, envWithoutApple);
  expect(missing.status).toBe(404);

  const configured = await app.request(
    "/.well-known/apple-app-site-association",
    {},
    { ...testEnv, APPLE_APP_ID: "ABCDE12345.dev.hidemyemail.app" }
  );
  expect(configured.status).toBe(200);
  expect(await configured.json()).toEqual({
    webcredentials: { apps: ["ABCDE12345.dev.hidemyemail.app"] },
  });
});
