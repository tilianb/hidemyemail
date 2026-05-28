import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { signSession } from "../src/lib/auth";
import { resetDb } from "./helpers";

let testEnv: any; let cookie: string;
beforeAll(async () => { testEnv = { ...env, SESSION_SECRET: "sek" }; cookie = "__Host-session=" + (await signSession("sek", 1, 3600)); });
beforeEach(async () => { await resetDb(env.DB as D1Database); });

import { encryptDestination, hashDestination } from "../src/lib/crypto";

test("create domain, create + list + patch + delete alias", async () => {
  const app = createApp();
  const h = { cookie, "Content-Type": "application/json" };

  const encReal = await encryptDestination("real@me.com", testEnv.DESTINATION_ENCRYPTION_KEY);
  const hashReal = await hashDestination("real@me.com", testEnv.DESTINATION_ENCRYPTION_KEY);
  await (env.DB as D1Database).prepare(
    "UPDATE settings SET value = 'hidemyemail.dev' WHERE key = 'main_global_domain'"
  ).run();
  await (env.DB as D1Database).prepare("INSERT INTO destinations (user_id, email, email_hash, token, verified_at, created_at) VALUES (1, ?, ?, 'tok1', 123, 123)").bind(encReal, hashReal).run();

  const encWork = await encryptDestination("work@me.com", testEnv.DESTINATION_ENCRYPTION_KEY);
  const hashWork = await hashDestination("work@me.com", testEnv.DESTINATION_ENCRYPTION_KEY);
  await (env.DB as D1Database).prepare("INSERT INTO destinations (user_id, email, email_hash, token, verified_at, created_at) VALUES (1, ?, ?, 'tok2', 123, 123)").bind(encWork, hashWork).run();

  const cd = await app.request("/api/domains", { method: "POST", headers: h, body: JSON.stringify({ domain: "test-sub", default_destination: "real@me.com" }) }, testEnv);
  expect(cd.status).toBe(200);
  const { id: domainId } = await cd.json<{ id: number }>();

  const ca = await app.request("/api/aliases", { method: "POST", headers: h, body: JSON.stringify({ domain_id: domainId, local_part: "shop", label: "shopping" }) }, testEnv);
  expect(ca.status).toBe(200);
  const alias = await ca.json<{ id: number; full_address: string; source: string }>();
  expect(alias.full_address).toBe("shop@test-sub.hidemyemail.dev");
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

test("users only see and use active verified global domains", async () => {
  const app = createApp();
  const db = env.DB as D1Database;
  const userCookie = "__Host-session=" + (await signSession("sek", 2, 3600));
  const h = { cookie: userCookie, "Content-Type": "application/json" };

  await db.prepare("INSERT INTO users (id, passphrase_hash, active, forwarding, created_at) VALUES (2, 'USER2', 1, 1, ?)").bind(Date.now()).run();
  const encDest = await encryptDestination("user@me.com", testEnv.DESTINATION_ENCRYPTION_KEY);
  const hashDest = await hashDestination("user@me.com", testEnv.DESTINATION_ENCRYPTION_KEY);
  await db.prepare("INSERT INTO destinations (user_id, email, email_hash, token, verified_at, is_default, created_at) VALUES (2, ?, ?, 'tok-user', 123, 1, 123)").bind(encDest, hashDest).run();

  await db.prepare("INSERT INTO domains (id, user_id, is_global, domain, active, verified_at, created_at) VALUES (10, 1, 1, 'good.example', 1, 123, 123)").run();
  await db.prepare("INSERT INTO domains (id, user_id, is_global, domain, active, verified_at, created_at) VALUES (11, 1, 1, 'inactive.example', 0, 123, 123)").run();
  await db.prepare("INSERT INTO domains (id, user_id, is_global, domain, active, verified_at, created_at) VALUES (12, 1, 1, 'unverified.example', 1, NULL, 123)").run();
  await db.prepare("INSERT INTO domains (id, user_id, is_global, domain, active, verified_at, created_at) VALUES (13, 2, 0, 'mine.hidemyemail.dev', 1, NULL, 123)").run();

  const list = await app.request("/api/domains", { headers: { cookie: userCookie } }, testEnv);
  expect(list.status).toBe(200);
  const domains = await list.json<any[]>();
  expect(domains.map(d => d.domain)).toEqual(["good.example", "mine.hidemyemail.dev"]);

  const inactiveAlias = await app.request("/api/aliases", { method: "POST", headers: h, body: JSON.stringify({ domain_id: 11, local_part: "shop" }) }, testEnv);
  expect(inactiveAlias.status).toBe(400);

  const unverifiedAlias = await app.request("/api/aliases", { method: "POST", headers: h, body: JSON.stringify({ domain_id: 12, local_part: "shop" }) }, testEnv);
  expect(unverifiedAlias.status).toBe(400);

  const goodAlias = await app.request("/api/aliases", { method: "POST", headers: h, body: JSON.stringify({ domain_id: 10, local_part: "shop" }) }, testEnv);
  expect(goodAlias.status).toBe(200);
});

test("admin settings reject unsafe main global domain values", async () => {
  const app = createApp();
  const h = { cookie, "Content-Type": "application/json" };

  const res = await app.request("/api/admin/settings", { method: "PATCH", headers: h, body: JSON.stringify({ main_global_domain: "evil.com\r\nBcc: victim@example.com" }) }, testEnv);
  expect(res.status).toBe(400);
});

test("admin cannot delete the configured main global domain", async () => {
  const app = createApp();
  const db = env.DB as D1Database;
  const h = { cookie, "Content-Type": "application/json" };

  await db.prepare("INSERT INTO domains (id, user_id, is_global, domain, active, verified_at, created_at) VALUES (20, 1, 1, 'main.example', 1, 123, 123)").run();
  await app.request("/api/admin/settings", { method: "PATCH", headers: h, body: JSON.stringify({ main_global_domain: "main.example" }) }, testEnv);

  const res = await app.request("/api/domains/20", { method: "DELETE", headers: { cookie } }, testEnv);
  expect(res.status).toBe(400);

  const stillThere = await db.prepare("SELECT id FROM domains WHERE id = 20").first<{ id: number }>();
  expect(stillThere?.id).toBe(20);
});
