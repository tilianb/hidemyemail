import { expect, test } from "vitest";
import { env } from "cloudflare:test";
import { signPasskeyAuthChallenge, updatePasskeySignCount, verifyPasskeyAuthChallenge, signPasskeyRegChallenge, verifyPasskeyRegChallenge } from "../src/lib/auth";
import { toBase64url, fromBase64url, getRpFromOrigin } from "../src/lib/webauthn";

// ── base64url helpers ──────────────────────────────────────────────────────

test("toBase64url / fromBase64url round-trip", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encoded = toBase64url(bytes);
  expect(encoded).not.toContain("+");
  expect(encoded).not.toContain("/");
  expect(encoded).not.toContain("=");
  const decoded = fromBase64url(encoded);
  expect(decoded).toEqual(bytes);
});

test("toBase64url produces URL-safe characters only", () => {
  for (let i = 0; i < 20; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(16 + i));
    const encoded = toBase64url(bytes);
    expect(encoded).toMatch(/^[A-Za-z0-9\-_]*$/);
  }
});

// ── getRpFromOrigin ────────────────────────────────────────────────────────

test("getRpFromOrigin extracts hostname correctly", () => {
  const { rpID, expectedOrigin } = getRpFromOrigin("https://hidemyemail.dev");
  expect(rpID).toBe("hidemyemail.dev");
  expect(expectedOrigin).toBe("https://hidemyemail.dev");
});

test("getRpFromOrigin handles preview URLs", () => {
  const { rpID } = getRpFromOrigin("https://hidemyemail-preview.tburg.workers.dev");
  expect(rpID).toBe("hidemyemail-preview.tburg.workers.dev");
});

test("getRpFromOrigin requires a configured origin", () => {
  expect(() => getRpFromOrigin(null)).toThrow();
});

test("getRpFromOrigin handles localhost", () => {
  const { rpID } = getRpFromOrigin("http://localhost:5173");
  expect(rpID).toBe("localhost");
});

test("getRpFromOrigin rejects insecure production and non-origin URLs", () => {
  expect(() => getRpFromOrigin("http://example.com")).toThrow();
  expect(() => getRpFromOrigin("https://example.com/path")).toThrow();
});

test("passkey sign counter updates are monotonic when assertions finish out of order", async () => {
  const db = env.DB as D1Database;
  await db.prepare("DELETE FROM passkey_credentials WHERE id = ?").bind("counter-test").run();
  await db.prepare(
    "INSERT INTO passkey_credentials (id, user_id, public_key, sign_count, created_at) VALUES (?, 1, ?, 0, ?)"
  ).bind("counter-test", "key", Date.now()).run();

  await updatePasskeySignCount(db, "counter-test", 12);
  await updatePasskeySignCount(db, "counter-test", 7);

  const row = await db.prepare("SELECT sign_count FROM passkey_credentials WHERE id = ?")
    .bind("counter-test").first<{ sign_count: number }>();
  expect(row?.sign_count).toBe(12);
});

// ── Passkey auth challenge ─────────────────────────────────────────────────

test("passkey auth challenge sign/verify round-trip", async () => {
  const secret = "test-secret";
  const challenge = toBase64url(crypto.getRandomValues(new Uint8Array(16)));
  const token = await signPasskeyAuthChallenge(secret, challenge);
  expect(token).toMatch(/^pauth\.\d+\.[A-Za-z0-9\-_]+\.[a-f0-9]+$/);
  expect(await verifyPasskeyAuthChallenge(secret, token)).toBe(challenge);
});

test("passkey auth challenge rejects wrong secret", async () => {
  const token = await signPasskeyAuthChallenge("secret", "abc123");
  expect(await verifyPasskeyAuthChallenge("wrong", token)).toBeNull();
});

test("passkey auth challenge rejects bad prefix", async () => {
  expect(await verifyPasskeyAuthChallenge("s", "preg.1.9999999999.abc.deadbeef")).toBeNull();
});

// ── Passkey reg challenge ──────────────────────────────────────────────────

test("passkey reg challenge sign/verify round-trip", async () => {
  const secret = "test-secret";
  const challenge = toBase64url(crypto.getRandomValues(new Uint8Array(16)));
  const token = await signPasskeyRegChallenge(secret, 42, challenge);
  expect(token).toMatch(/^preg\.\d+\.\d+\.[A-Za-z0-9\-_]+\.[a-f0-9]+$/);
  const result = await verifyPasskeyRegChallenge(secret, token);
  expect(result?.userId).toBe(42);
  expect(result?.challenge).toBe(challenge);
});

test("passkey reg challenge rejects wrong secret", async () => {
  const token = await signPasskeyRegChallenge("secret", 1, "abc");
  expect(await verifyPasskeyRegChallenge("wrong", token)).toBeNull();
});

test("passkey reg challenge rejects wrong prefix", async () => {
  expect(await verifyPasskeyRegChallenge("s", "pauth.9999999999.abc.deadbeef")).toBeNull();
});
