import { expect, test, vi } from "vitest";
import { decryptDestination, encryptDestination } from "../src/lib/crypto";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

test("decryptDestination still supports legacy plaintext email rows", async () => {
  await expect(decryptDestination("legacy@example.com", KEY)).resolves.toBe("legacy@example.com");
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
  await expect(decryptDestination(encrypted, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=")).rejects.toThrow("Unable to decrypt stored value");
});
