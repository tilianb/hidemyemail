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
  await (env.DB as D1Database).prepare("UPDATE settings SET value = 'true' WHERE key = 'registration_enabled'").run();
});

const J = { "Content-Type": "application/json" };
const TOKEN = { "Content-Type": "application/json", "X-Auth-Mode": "token" };

// Register a fresh user in native token mode; returns its bearer + fresh-auth
// tokens, recovery codes, and userId.
async function register(app: ReturnType<typeof createApp>, passphrase: string) {
  const res = await app.request("/api/register", { method: "POST", body: JSON.stringify({ password: passphrase }), headers: TOKEN }, testEnv);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  return { token: body.token as string, fresh: body.fresh_auth as string, codes: body.recovery_codes as string[], userId: body.userId as number };
}

test("register returns 10 readable recovery codes with at least 128 bits of entropy", async () => {
  const app = createApp();
  const { codes } = await register(app, "horse-staple-battery-one");
  expect(Array.isArray(codes)).toBe(true);
  expect(codes.length).toBe(10);
  for (const c of codes) expect(c).toMatch(/^(?:[A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
});

test("set username, it shows in stats display, and is case-insensitively unique", async () => {
  const app = createApp();
  const a = await register(app, "horse-staple-battery-two");
  const b = await register(app, "horse-staple-battery-three");

  // Set username on user A.
  const set = await app.request("/api/account/username", {
    method: "PATCH", body: JSON.stringify({ username: "NeoTrinity" }),
    headers: { ...J, Authorization: `Bearer ${a.token}` },
  }, testEnv);
  expect(set.status).toBe(200);
  expect((await set.json() as any).username).toBe("NeoTrinity");

  // Display now uses the username instead of "User #N".
  const stats = await app.request("/api/stats", { headers: { Authorization: `Bearer ${a.token}` } }, testEnv);
  expect((await stats.json() as any).userName).toBe("NeoTrinity");

  // User B can't take the same handle in a different case.
  const dup = await app.request("/api/account/username", {
    method: "PATCH", body: JSON.stringify({ username: "neotrinity" }),
    headers: { ...J, Authorization: `Bearer ${b.token}` },
  }, testEnv);
  expect(dup.status).toBe(409);
});

test("username validation rejects bad shapes and reserved words", async () => {
  const app = createApp();
  const a = await register(app, "horse-staple-battery-four");
  const bad = ["ab", "-leading", "trailing-", "has space", "white@space", "admin", "Support"];
  for (const u of bad) {
    const res = await app.request("/api/account/username", {
      method: "PATCH", body: JSON.stringify({ username: u }),
      headers: { ...J, Authorization: `Bearer ${a.token}` },
    }, testEnv);
    expect(res.status, `expected 400 for ${u}`).toBe(400);
  }
});

test("clearing username falls back to User #N display", async () => {
  const app = createApp();
  const a = await register(app, "horse-staple-battery-five");
  await app.request("/api/account/username", { method: "PATCH", body: JSON.stringify({ username: "clearme1" }), headers: { ...J, Authorization: `Bearer ${a.token}` } }, testEnv);
  const clear = await app.request("/api/account/username", { method: "PATCH", body: JSON.stringify({ username: null }), headers: { ...J, Authorization: `Bearer ${a.token}` } }, testEnv);
  expect(clear.status).toBe(200);
  const stats = await app.request("/api/stats", { headers: { Authorization: `Bearer ${a.token}` } }, testEnv);
  expect((await stats.json() as any).userName).toBe(`User #${a.userId}`);
});

test("recover with username + recovery code resets passphrase and consumes the code", async () => {
  const app = createApp();
  const a = await register(app, "horse-staple-battery-six");
  await app.request("/api/account/username", { method: "PATCH", body: JSON.stringify({ username: "recoverme" }), headers: { ...J, Authorization: `Bearer ${a.token}` } }, testEnv);

  const code = a.codes[0]!;

  // Wrong code → generic 400.
  const wrong = await app.request("/api/recover/code", { method: "POST", body: JSON.stringify({ username: "recoverme", code: "ZZZZ-ZZZZ" }), headers: TOKEN }, testEnv);
  expect(wrong.status).toBe(400);

  // Correct code → new passphrase, one code consumed (9 remain).
  const ok = await app.request("/api/recover/code", { method: "POST", body: JSON.stringify({ username: "RecoverMe", code }), headers: TOKEN }, testEnv);
  expect(ok.status).toBe(200);
  const body = await ok.json() as any;
  expect(typeof body.passphrase).toBe("string");
  expect(body.codes_remaining).toBe(9);

  // The new passphrase logs in.
  const login = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: body.passphrase }), headers: J }, testEnv);
  expect(login.status).toBe(200);

  // The used code can't be replayed.
  const replay = await app.request("/api/recover/code", { method: "POST", body: JSON.stringify({ username: "recoverme", code }), headers: TOKEN }, testEnv);
  expect(replay.status).toBe(400);
});

test("recovery invalidates old session and fresh-auth credentials", async () => {
  const app = createApp();
  const a = await register(app, "horse-staple-battery-invalidate");
  await app.request("/api/account/username", { method: "PATCH", body: JSON.stringify({ username: "invalidate-me" }), headers: { ...J, Authorization: `Bearer ${a.token}` } }, testEnv);

  const recovered = await app.request("/api/recover/code", { method: "POST", body: JSON.stringify({ username: "invalidate-me", code: a.codes[0] }), headers: TOKEN }, testEnv);
  expect(recovered.status).toBe(200);

  const oldSession = await app.request("/api/stats", { headers: { Authorization: `Bearer ${a.token}` } }, testEnv);
  expect(oldSession.status).toBe(401);
  const oldFresh = await app.request("/api/account/recovery-codes", { method: "POST", headers: { Authorization: `Bearer ${a.token}`, "X-Fresh-Auth": a.fresh } }, testEnv);
  expect(oldFresh.status).toBe(401);
});

test("concurrent recovery-code redemption has exactly one winner", async () => {
  const app = createApp();
  const a = await register(app, "horse-staple-battery-race");
  await app.request("/api/account/username", { method: "PATCH", body: JSON.stringify({ username: "race-recover" }), headers: { ...J, Authorization: `Bearer ${a.token}` } }, testEnv);
  const request = () => app.request("/api/recover/code", { method: "POST", body: JSON.stringify({ username: "race-recover", code: a.codes[0] }), headers: TOKEN }, testEnv);

  const responses = await Promise.all([request(), request()]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
});

test("recover/code on unknown username returns the same generic error", async () => {
  const app = createApp();
  const res = await app.request("/api/recover/code", { method: "POST", body: JSON.stringify({ username: "nobody-here", code: "AAAA-BBBB" }), headers: TOKEN }, testEnv);
  expect(res.status).toBe(400);
  expect((await res.json() as any).error).toBe("Invalid username or recovery code");
});

test("regenerating recovery codes requires fresh auth and rotates the set", async () => {
  const app = createApp();
  const a = await register(app, "horse-staple-battery-seven");

  // Stale bearer (no fresh-auth header) is refused.
  const stale = await app.request("/api/account/recovery-codes", { method: "POST", headers: { Authorization: `Bearer ${a.token}` } }, testEnv);
  expect(stale.status).toBe(401);

  // With fresh auth, a new set of 10 is minted.
  const fresh = await app.request("/api/account/recovery-codes", { method: "POST", headers: { Authorization: `Bearer ${a.token}`, "X-Fresh-Auth": a.fresh } }, testEnv);
  expect(fresh.status).toBe(200);
  const newCodes = (await fresh.json() as any).codes as string[];
  expect(newCodes.length).toBe(10);

  // Old codes are now invalid; new ones work.
  await app.request("/api/account/username", { method: "PATCH", body: JSON.stringify({ username: "rotateuser" }), headers: { ...J, Authorization: `Bearer ${a.token}` } }, testEnv);
  const oldFails = await app.request("/api/recover/code", { method: "POST", body: JSON.stringify({ username: "rotateuser", code: a.codes[0] }), headers: TOKEN }, testEnv);
  expect(oldFails.status).toBe(400);
  const newWorks = await app.request("/api/recover/code", { method: "POST", body: JSON.stringify({ username: "rotateuser", code: newCodes[0] }), headers: TOKEN }, testEnv);
  expect(newWorks.status).toBe(200);
});

test("GET /account/recovery-codes reports remaining count without leaking codes", async () => {
  const app = createApp();
  const a = await register(app, "horse-staple-battery-eight");
  const res = await app.request("/api/account/recovery-codes", { headers: { Authorization: `Bearer ${a.token}` } }, testEnv);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.remaining).toBe(10);
  expect(body.codes).toBeUndefined();
});
