import { expect, test, vi } from "vitest";
import { decryptDestination, encryptDestination, hashDestination } from "../src/lib/crypto";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const WRONG_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const KEY_16_BYTES = "AAAAAAAAAAAAAAAAAAAAAA==";
const KEY_31_BYTES = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const KEY_33_BYTES = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const INVALID_KEYS = [
  undefined,
  "",
  "not-base64!",
  `${KEY}junk`,
  "YQ==",
  KEY_16_BYTES,
  KEY_31_BYTES,
  KEY_33_BYTES,
] as unknown as string[];

test.each(INVALID_KEYS)("hashDestination rejects invalid key configuration %#", async (key) => {
  await expect(hashDestination("plain@example.com", key)).rejects.toThrow(
    new Error("Invalid encryption key configuration"),
  );
});

test.each(INVALID_KEYS)("encryptDestination rejects invalid key configuration %#", async (key) => {
  await expect(encryptDestination("plain@example.com", key)).rejects.toThrow(
    new Error("Invalid encryption key configuration"),
  );
});

test("rejects noncanonical Base64 keys even when they decode to 32 bytes", async () => {
  const noncanonical = `${KEY.slice(0, -1)}\n=`;
  await expect(encryptDestination("plain@example.com", noncanonical)).rejects.toThrow(
    new Error("Invalid encryption key configuration"),
  );
});

test("decryptDestination still supports legacy plaintext email rows", async () => {
  await expect(decryptDestination("legacy@example.com", KEY)).resolves.toBe("legacy@example.com");
});

test.each(INVALID_KEYS)("legacy plaintext requires valid key configuration %#", async (key) => {
  await expect(decryptDestination("legacy@example.com", key)).rejects.toThrow(
    new Error("Invalid encryption key configuration"),
  );
});

test("decryptDestination does not log legacy plaintext values", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    await expect(decryptDestination("sensitive@example.com", KEY)).resolves.toBe("sensitive@example.com");
    expect(warn).toHaveBeenCalledWith("Using legacy plaintext destination row");
    expect(warn).not.toHaveBeenCalledWith(expect.any(String), "sensitive@example.com");
  } finally {
    warn.mockRestore();
  }
});

test("decryptDestination fails closed for non-email ciphertext with wrong key", async () => {
  const encrypted = await encryptDestination("user@example.com", KEY);
  await expect(decryptDestination(encrypted, WRONG_KEY)).rejects.toThrow("Unable to decrypt stored value");
});
