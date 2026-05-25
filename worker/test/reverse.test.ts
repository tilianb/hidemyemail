import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { newToken, reverseAddress, parseReverse, getOrCreateReverse } from "../src/lib/reverse";
import * as q from "../src/db/queries";
import { resetDb } from "./helpers";

const DB = () => env.DB as D1Database;
beforeEach(async () => { await resetDb(DB()); });

test("token is 24-char base32", () => {
  const t = newToken(24);
  expect(t).toMatch(/^[a-z2-7]{24}$/);
  expect(newToken(24)).not.toBe(t);
});

test("reverseAddress and parseReverse round-trip", () => {
  const token = "abcdefghijklmnopqrstuvwx"; // 24-char base32
  expect(reverseAddress("shop", token, "hidemyemail.dev")).toBe(`shop+${token}@hidemyemail.dev`);
  expect(parseReverse(`shop+${token}`)).toBe(token);
  expect(parseReverse("shop")).toBeNull();
  expect(parseReverse("r.abcd")).toBeNull(); // old format no longer recognised
});

test("getOrCreateReverse is stable per (alias,sender)", async () => {
  const d = await q.createDomain(DB(), "hidemyemail.dev", "real@me.com");
  const a = await q.autoCreateAlias(DB(), d, "shop", "shop@hidemyemail.dev");
  const r1 = await getOrCreateReverse(DB(), a.id, "boss@store.com");
  const r2 = await getOrCreateReverse(DB(), a.id, "boss@store.com");
  expect(r2.token).toBe(r1.token);
});
