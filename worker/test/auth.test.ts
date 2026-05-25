import { expect, test } from "vitest";
import { hashPassword, verifyPassword, signSession, verifySession } from "../src/lib/auth";

test("password hash + verify", async () => {
  const { saltHex, hashHex } = await hashPassword("hunter2");
  expect(await verifyPassword("hunter2", saltHex, hashHex)).toBe(true);
  expect(await verifyPassword("wrong", saltHex, hashHex)).toBe(false);
});

test("session sign/verify round-trip and expiry", async () => {
  const secret = "topsecret";
  const tok = await signSession(secret, 1, 3600);
  expect(await verifySession(secret, tok)).toBe(1);
  expect(await verifySession("other", tok)).toBe(null);
  const expired = await signSession(secret, 1, -1);
  expect(await verifySession(secret, expired)).toBe(null);
});
