import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { signSession } from "../src/lib/auth";
import * as q from "../src/db/queries";
import { resetDb } from "./helpers";

let testEnv: any; let cookie: string;
beforeAll(async () => { testEnv = { ...env, SESSION_SECRET: "sek" }; cookie = "session=" + (await signSession("sek", 1, 3600)); });
beforeEach(async () => { await resetDb(env.DB as D1Database); });

test("stats returns totals and 24h breakdown", async () => {
  const app = createApp();
  const d = await q.createDomain(env.DB as D1Database, "hidemyemail.dev", "real@me.com");
  const a = await q.autoCreateAlias(env.DB as D1Database, d, "shop", "shop@hidemyemail.dev");
  await q.insertEvent(env.DB as D1Database, { alias_id: a.id, type: "forward", ts: Date.now() });
  const res = await app.request("/api/stats", { headers: { cookie } }, testEnv);
  const stats = await res.json<any>();
  expect(stats.totals.aliases).toBe(1);
  expect(stats.last24h.forward).toBe(1);
});

test("create + delete block rule", async () => {
  const app = createApp();
  const h = { cookie, "Content-Type": "application/json" };
  const create = await app.request("/api/blocks", { method: "POST", headers: h, body: JSON.stringify({ pattern: "*@spam.com" }) }, testEnv);
  expect(create.status).toBe(200);
  const { id } = await create.json<{ id: number }>();
  const del = await app.request(`/api/blocks/${id}`, { method: "DELETE", headers: { cookie } }, testEnv);
  expect(del.status).toBe(200);
});
