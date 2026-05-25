import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { signSession } from "../src/lib/auth";
import { resetDb } from "./helpers";

let testEnv: any; let cookie: string;
beforeAll(async () => { testEnv = { ...env, SESSION_SECRET: "sek" }; cookie = "session=" + (await signSession("sek", 1, 3600)); });
beforeEach(async () => { await resetDb(env.DB as D1Database); });

test("create domain, create + list + patch + delete alias", async () => {
  const app = createApp();
  const h = { cookie, "Content-Type": "application/json" };

  const cd = await app.request("/api/domains", { method: "POST", headers: h, body: JSON.stringify({ domain: "hidemyemail.dev", default_destination: "real@me.com" }) }, testEnv);
  expect(cd.status).toBe(200);
  const { id: domainId } = await cd.json<{ id: number }>();

  const ca = await app.request("/api/aliases", { method: "POST", headers: h, body: JSON.stringify({ domain_id: domainId, local_part: "shop", label: "shopping" }) }, testEnv);
  expect(ca.status).toBe(200);
  const alias = await ca.json<{ id: number; full_address: string; source: string }>();
  expect(alias.full_address).toBe("shop@hidemyemail.dev");
  expect(alias.source).toBe("dashboard");

  const list = await app.request("/api/aliases", { headers: { cookie } }, testEnv);
  expect((await list.json<any[]>()).length).toBe(1);

  const patch = await app.request(`/api/aliases/${alias.id}`, { method: "PATCH", headers: h, body: JSON.stringify({ active: 0, destination: "work@me.com" }) }, testEnv);
  expect(patch.status).toBe(200);

  // Insert referencing records to ensure foreign key constraint deletion works (reverse_map, blocks, events)
  await (env.DB as D1Database).prepare("INSERT INTO reverse_map (token, alias_id, external_sender, created_at) VALUES ('tok123', ?, 'sender@store.com', ?)")
    .bind(alias.id, Date.now()).run();
  await (env.DB as D1Database).prepare("INSERT INTO blocks (alias_id, pattern, created_at) VALUES (?, 'spammer@spam.com', ?)")
    .bind(alias.id, Date.now()).run();
  await (env.DB as D1Database).prepare("INSERT INTO events (alias_id, type, external_sender, subject, bytes, ts) VALUES (?, 'forward', 'sender@store.com', 'Hi', 100, ?)")
    .bind(alias.id, Date.now()).run();

  const del = await app.request(`/api/aliases/${alias.id}`, { method: "DELETE", headers: { cookie } }, testEnv);
  expect(del.status).toBe(200);
  const list2 = await app.request("/api/aliases", { headers: { cookie } }, testEnv);
  expect((await list2.json<any[]>()).length).toBe(0);

  // Also verify that the referencing rows are deleted from the database
  const rev = await (env.DB as D1Database).prepare("SELECT COUNT(*) as count FROM reverse_map WHERE alias_id=?").bind(alias.id).first<{ count: number }>();
  expect(rev?.count).toBe(0);
  const blk = await (env.DB as D1Database).prepare("SELECT COUNT(*) as count FROM blocks WHERE alias_id=?").bind(alias.id).first<{ count: number }>();
  expect(blk?.count).toBe(0);
  const evt = await (env.DB as D1Database).prepare("SELECT COUNT(*) as count FROM events WHERE alias_id=?").bind(alias.id).first<{ count: number }>();
  expect(evt?.count).toBe(0);
});
