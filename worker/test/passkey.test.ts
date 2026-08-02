import { expect, test } from "vitest";
import { env } from "cloudflare:test";
import { sha256Base64url, signPasskeyAuthChallenge, updatePasskeySignCount, verifyPasskeyAuthChallenge, signPasskeyMfaChallenge, verifyPasskeyMfaChallenge, signPasskeyRegChallenge, verifyPasskeyRegChallenge, signReauthPasskeyChallenge, verifyReauthPasskeyChallenge } from "../src/lib/auth";
import { consumeAuthArtifactHash, finalizePasskeyAssertion } from "../src/lib/auth-security";
import { toBase64url, fromBase64url, getRegistrationOrigins, getRpFromOrigin } from "../src/lib/webauthn";

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

test("browser passkey registration accepts only canonical APP_ORIGIN", () => {
  expect(getRegistrationOrigins("https://app.example.com", "android:apk-key-hash:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", false))
    .toBe("https://app.example.com");
});

test("native passkey registration also accepts configured Android origins", () => {
  const androidOrigin = "android:apk-key-hash:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  expect(getRegistrationOrigins("https://app.example.com", androidOrigin, true))
    .toEqual(["https://app.example.com", androidOrigin]);
});

test("passkey sign counter updates are monotonic when assertions finish out of order", async () => {
  const db = env.DB as D1Database;
  await db.prepare("DELETE FROM passkey_credentials WHERE id = ?").bind("counter-test").run();
  await db.prepare(
    "INSERT INTO passkey_credentials (id, user_id, public_key, sign_count, created_at) VALUES (?, 1, ?, 0, ?)"
  ).bind("counter-test", "key", Date.now()).run();

  expect(await updatePasskeySignCount(db, "counter-test", 0, 12)).toBe(true);
  expect(await updatePasskeySignCount(db, "counter-test", 0, 7)).toBe(false);

  const row = await db.prepare("SELECT sign_count FROM passkey_credentials WHERE id = ?")
    .bind("counter-test").first<{ sign_count: number }>();
  expect(row?.sign_count).toBe(12);
});

test("zero-counter passkey finalization succeeds once in D1", async () => {
  const db = env.DB as D1Database;
  await db.prepare("DELETE FROM passkey_credentials WHERE id = ?").bind("zero-counter-test").run();
  await db.prepare(
    "INSERT INTO passkey_credentials (id, user_id, public_key, sign_count, created_at) VALUES (?, 1, ?, 0, ?)"
  ).bind("zero-counter-test", "key", Date.now()).run();
  const token = `zero-counter-${crypto.randomUUID()}`;
  const expiresAt = Math.floor(Date.now() / 1000) + 300;

  expect(await finalizePasskeyAssertion(db, token, expiresAt, "zero-counter-test", 0, 0)).toBe(true);
  expect(await finalizePasskeyAssertion(db, token, expiresAt, "zero-counter-test", 0, 0)).toBe(false);
});

test("expired auth artifacts cannot be claimed", async () => {
  const hash = await sha256Base64url(`expired-${crypto.randomUUID()}`);
  expect(await consumeAuthArtifactHash(env.DB as D1Database, hash, Math.floor(Date.now() / 1000))).toBe(false);
  expect(await (env.DB as D1Database).prepare(
    "SELECT 1 FROM consumed_auth_artifacts WHERE artifact_hash = ?"
  ).bind(hash).first()).toBeNull();
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

test("account-bound passkey MFA challenge cannot downgrade or be tampered with", async () => {
  const parentArtifactHash = await sha256Base64url(`parent-${crypto.randomUUID()}`);
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const token = await signPasskeyMfaChallenge("secret", 42, 7, "abc123", parentArtifactHash, expiresAt);
  expect(token).toMatch(/^pauthmfa2\.42\.7\.\d+\.abc123\.[A-Za-z0-9_-]{43}\.[a-f0-9]+$/);
  expect(await verifyPasskeyMfaChallenge("secret", token)).toMatchObject({
    userId: 42, authVersion: 7, challenge: "abc123", parentArtifactHash,
  });
  expect(await verifyPasskeyAuthChallenge("secret", token)).toBeNull();
  expect(await verifyPasskeyMfaChallenge("secret", token.replace(".42.7.", ".43.7."))).toBeNull();
  expect(await verifyPasskeyMfaChallenge("secret", token.replace(parentArtifactHash, "A".repeat(43)))).toBeNull();
});

test("passkey MFA children compete for the same parent login artifact", async () => {
  const db = env.DB as D1Database;
  const parentArtifactHash = await sha256Base64url(`parent-${crypto.randomUUID()}`);
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const credentialId = `parent-race-${crypto.randomUUID()}`;
  await db.prepare(
    "INSERT INTO passkey_credentials (id, user_id, public_key, sign_count, created_at) VALUES (?, 1, 'key', 0, ?)"
  ).bind(credentialId, Date.now()).run();
  const children = await Promise.all([
    signPasskeyMfaChallenge("secret", 42, 7, "first", parentArtifactHash, expiresAt),
    signPasskeyMfaChallenge("secret", 42, 7, "second", parentArtifactHash, expiresAt),
  ]);
  const principals = await Promise.all(children.map((token) => verifyPasskeyMfaChallenge("secret", token)));
  const consumed = await Promise.all(principals.map((principal, index) => finalizePasskeyAssertion(
    db,
    children[index]!,
    principal!.expiresAt,
    credentialId,
    0,
    1,
    { artifactHash: principal!.parentArtifactHash, expiresAt: principal!.expiresAt },
  )));
  expect(consumed.sort()).toEqual([false, true]);

  const third = await signPasskeyMfaChallenge("secret", 42, 7, "third", parentArtifactHash, expiresAt);
  expect(await finalizePasskeyAssertion(
    db, third, expiresAt, credentialId, 1, 2, { artifactHash: parentArtifactHash, expiresAt },
  )).toBe(false);
  const credential = await db.prepare("SELECT sign_count FROM passkey_credentials WHERE id = ?")
    .bind(credentialId).first<{ sign_count: number }>();
  expect(credential?.sign_count).toBe(1);
});

test("fresh-auth passkey challenge binds account, auth version, and channel", async () => {
  const token = await signReauthPasskeyChallenge("secret", 42, 7, "native", "abc123");
  expect(await verifyReauthPasskeyChallenge("secret", token)).toMatchObject({
    userId: 42, authVersion: 7, channel: "native", challenge: "abc123",
  });
  expect(await verifyReauthPasskeyChallenge("secret", token.replace(".native.", ".web."))).toBeNull();
  expect(await verifyReauthPasskeyChallenge("secret", token.replace(".42.7.", ".43.7."))).toBeNull();
});

// ── Passkey reg challenge ──────────────────────────────────────────────────

test("passkey reg challenge sign/verify round-trip", async () => {
  const secret = "test-secret";
  const challenge = toBase64url(crypto.getRandomValues(new Uint8Array(16)));
  const token = await signPasskeyRegChallenge(secret, 42, challenge);
  expect(token).toMatch(/^preg2\.\d+\.\d+\.\d+\.[A-Za-z0-9\-_]+\.[a-f0-9]+$/);
  const result = await verifyPasskeyRegChallenge(secret, token);
  expect(result?.userId).toBe(42);
  expect(result?.authVersion).toBe(0);
  expect(result?.challenge).toBe(challenge);
});

test("passkey reg challenge rejects wrong secret", async () => {
  const token = await signPasskeyRegChallenge("secret", 1, "abc");
  expect(await verifyPasskeyRegChallenge("wrong", token)).toBeNull();
});

test("passkey reg challenge rejects wrong prefix", async () => {
  expect(await verifyPasskeyRegChallenge("s", "pauth.9999999999.abc.deadbeef")).toBeNull();
});
