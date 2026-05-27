import { expect, test } from "vitest";
import { hashPassword, verifyPassword, signFreshAuth, signSession, verifyFreshAuth, verifySession } from "../src/lib/auth";

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

test("legacy v1 session tokens are rejected", async () => {
  const secret = "topsecret";
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = `v1.${exp}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  expect(await verifySession(secret, `${payload}.${sig}`)).toBe(null);
});

test("fresh auth token is user-bound and short-lived", async () => {
  const secret = "topsecret";
  const tok = await signFreshAuth(secret, 42, 300);
  expect(await verifyFreshAuth(secret, tok, 42)).toBe(true);
  expect(await verifyFreshAuth(secret, tok, 43)).toBe(false);
  const expired = await signFreshAuth(secret, 42, -1);
  expect(await verifyFreshAuth(secret, expired, 42)).toBe(false);
});
