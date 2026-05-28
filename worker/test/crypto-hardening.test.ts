import { expect, test } from "vitest";
import { decryptDestination, encryptDestination } from "../src/lib/crypto";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

test("decryptDestination still supports legacy plaintext email rows", async () => {
  await expect(decryptDestination("legacy@example.com", KEY)).resolves.toBe("legacy@example.com");
});

test("decryptDestination fails closed for non-email ciphertext with wrong key", async () => {
  const encrypted = await encryptDestination("user@example.com", KEY);
  await expect(decryptDestination(encrypted, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=")).rejects.toThrow("Unable to decrypt stored value");
});
