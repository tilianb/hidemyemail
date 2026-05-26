import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import * as q from "../src/db/queries";
import { resetDb } from "./helpers";

const DB = () => env.DB as D1Database;
beforeEach(async () => { await resetDb(DB()); });

test("domain + alias auto-create is idempotent", async () => {
  const d = await q.createDomain(DB(), "hidemyemail.dev", "real@me.com");
  const a1 = await q.autoCreateAlias(DB(), d, "shop", "shop@hidemyemail.dev");
  const a2 = await q.autoCreateAlias(DB(), d, "shop", "shop@hidemyemail.dev");
  expect(a1!.id).toBe(a2!.id);
  expect(a1!.source).toBe("auto");
});

test("reverse upsert returns stable token per (alias,sender)", async () => {
  const d = await q.createDomain(DB(), "hidemyemail.dev", "real@me.com");
  const a = await q.autoCreateAlias(DB(), d, "shop", "shop@hidemyemail.dev");
  const r1 = await q.upsertReverse(DB(), a!.id, "boss@store.com", "tok123");
  const r2 = await q.upsertReverse(DB(), a!.id, "boss@store.com", "DIFFERENT");
  expect(r2.token).toBe(r1.token);
  const found = await q.getReverseByToken(DB(), r1.token);
  expect(found?.external_sender).toBe("boss@store.com");
});

test("countEventsSince counts only recent rows for alias", async () => {
  const d = await q.createDomain(DB(), "hidemyemail.dev", "real@me.com");
  const a = await q.autoCreateAlias(DB(), d, "shop", "shop@hidemyemail.dev");
  const now = Date.now();
  await q.insertEvent(DB(), { alias_id: a!.id, type: "forward", ts: now });
  await q.insertEvent(DB(), { alias_id: a!.id, type: "forward", ts: now - 7200_000 });
  expect(await q.countEventsSince(DB(), a!.id, now - 3600_000)).toBe(1);
});

test("ownerDestinations unions domain defaults and alias overrides", async () => {
  const d = await q.createDomain(DB(), "hidemyemail.dev", "real@me.com");
  const a = await q.autoCreateAlias(DB(), d, "x", "x@hidemyemail.dev");
  await DB().prepare("UPDATE aliases SET destination = ? WHERE id = ?").bind("work@me.com", a!.id).run();
  const set = await q.ownerDestinations(DB(), 1, env.DESTINATION_ENCRYPTION_KEY as string || "sek");
  expect(set.has("real@me.com")).toBe(true);
  expect(set.has("work@me.com")).toBe(true);
});
