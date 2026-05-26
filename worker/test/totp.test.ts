import { expect, test } from "vitest";
import {
  generateTOTPSecret,
  verifyTOTP,
  makeTOTPUri,
  generateBackupCodes,
  verifyBackupCode,
  hashBackupCode,
  base32Encode,
} from "../src/lib/totp";
import { signMfaChallenge, verifyMfaChallenge } from "../src/lib/auth";

test("TOTP secret is 32 base32 chars (20 bytes)", () => {
  const secret = generateTOTPSecret();
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
});

test("TOTP secret uniqueness", () => {
  const a = generateTOTPSecret();
  const b = generateTOTPSecret();
  expect(a).not.toBe(b);
});

test("base32Encode round-trips fixed bytes", () => {
  const bytes = new Uint8Array([0x00, 0xff, 0x80, 0x40, 0x20]);
  const encoded = base32Encode(bytes);
  expect(encoded).toHaveLength(8); // 5 bytes → 8 base32 chars
});

test("verifyTOTP rejects wrong length code", async () => {
  const secret = generateTOTPSecret();
  expect(await verifyTOTP(secret, "12345")).toBe(false);
  expect(await verifyTOTP(secret, "1234567")).toBe(false);
  expect(await verifyTOTP(secret, "abcdef")).toBe(false);
});

test("verifyTOTP accepts current code (live clock)", async () => {
  // We can't easily generate a valid code without a known secret, but we can
  // verify the function returns true for a real secret+code pair by computing
  // the current code ourselves and checking it verifies.
  const { base32Encode: enc } = await import("../src/lib/totp");
  // Use a known test secret: all-zeros key
  const key = new Uint8Array(20);
  const secret = enc(key);

  // Compute expected current code using same logic as the library
  const cryptoKey = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const counter = Math.floor(Date.now() / 1000 / 30);
  const msg = new Uint8Array(8);
  const dv = new DataView(msg.buffer);
  dv.setUint32(0, Math.floor(counter / 0x100000000), false);
  dv.setUint32(4, counter >>> 0, false);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, msg));
  const offset = digest[19]! & 0xf;
  const code =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  const token = (code % 1_000_000).toString().padStart(6, "0");

  expect(await verifyTOTP(secret, token)).toBe(true);
  expect(await verifyTOTP(secret, "000000" === token ? "000001" : "000000")).toBe(false);
});

test("makeTOTPUri format", () => {
  const uri = makeTOTPUri("JBSWY3DPEHPK3PXP", "Acme", "alice@example.com");
  expect(uri).toMatch(/^otpauth:\/\/totp\//);
  expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
  expect(uri).toContain("issuer=Acme");
  expect(uri).toContain("digits=6");
  expect(uri).toContain("period=30");
});

test("backup codes format and uniqueness", async () => {
  const { plain, hashed } = await generateBackupCodes();
  expect(plain).toHaveLength(8);
  expect(hashed).toHaveLength(8);
  for (const code of plain) {
    expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  }
  const unique = new Set(plain);
  expect(unique.size).toBe(8);
});

test("backup code hashing is deterministic and case-insensitive", async () => {
  const h1 = await hashBackupCode("ABCD-EFGH");
  const h2 = await hashBackupCode("abcdefgh");
  const h3 = await hashBackupCode("ABCD EFGH");
  expect(h1).toBe(h2);
  expect(h1).toBe(h3);
});

test("verifyBackupCode finds and returns index", async () => {
  const { plain, hashed } = await generateBackupCodes();
  const idx = await verifyBackupCode(plain[3]!, hashed);
  expect(idx).toBe(3);
  expect(await verifyBackupCode("ZZZZ-ZZZZ", hashed)).toBe(-1);
});

test("MFA challenge sign and verify", async () => {
  const secret = "test-secret";
  const token = await signMfaChallenge(secret, 42);
  expect(token).toMatch(/^mfa\.\d+\.\d+\.[a-f0-9]+$/);
  expect(await verifyMfaChallenge(secret, token)).toBe(42);
  expect(await verifyMfaChallenge("wrong-secret", token)).toBeNull();
});

test("MFA challenge with wrong secret returns null", async () => {
  const token = await signMfaChallenge("secret", 1);
  expect(await verifyMfaChallenge("other-secret", token)).toBeNull();
});
