import { env } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/api/app";
import { signSession } from "../src/lib/auth";
import { resetDb } from "./helpers";

let testEnv: any; let cookie: string;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  testEnv = { ...env, SESSION_SECRET: "sek" };
  cookie = "__Host-session=" + (await signSession("sek", 1, 3600));
  // POST /domains DNS-checks the candidate subdomain's MX before allowing
  // creation. Tests should not hit real DNS — stub fetch to return a non-ok
  // response so the gate falls back to allow (the route already does this for
  // transient lookup failures).
  globalThis.fetch = vi.fn(async () => new Response("", { status: 503 })) as any;
});
afterAll(() => { globalThis.fetch = realFetch; });
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
  // The POST /domains route requires the main global domain to exist with
  // allow_subdomain_aliases = 1 before any subdomain may be created.
  await (env.DB as D1Database).prepare(
    "INSERT INTO domains (user_id, is_global, domain, allow_subdomain_aliases, active, verified_at, created_at) VALUES (1, 1, 'hidemyemail.dev', 1, 1, 123, ?)"
  ).bind(Date.now()).run();
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

test("user can create subdomain under any enabled global domain", async () => {
  const app = createApp();
  const db = env.DB as D1Database;
  const h = { cookie, "Content-Type": "application/json" };

  await db.prepare("UPDATE settings SET value = 'primary.example' WHERE key = 'main_global_domain'").run();
  await db.prepare("INSERT INTO domains (id, user_id, is_global, domain, allow_subdomain_aliases, active, verified_at, created_at) VALUES (30, 1, 1, 'primary.example', 1, 1, 123, 123)").run();
  await db.prepare("INSERT INTO domains (id, user_id, is_global, domain, allow_subdomain_aliases, active, verified_at, created_at) VALUES (31, 1, 1, 'second.example', 1, 1, 123, 123)").run();

  const res = await app.request("/api/domains", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ domain: "shop", base_domain_id: 31, default_destination: "global" }),
  }, testEnv);

  expect(res.status).toBe(200);
  const created = await res.json<{ domain: string }>();
  expect(created.domain).toBe("shop.second.example");
});

test("user cannot create subdomain under disabled global domain", async () => {
  const app = createApp();
  const db = env.DB as D1Database;
  const h = { cookie, "Content-Type": "application/json" };

  await db.prepare("UPDATE settings SET value = 'primary.example' WHERE key = 'main_global_domain'").run();
  await db.prepare("INSERT INTO domains (id, user_id, is_global, domain, allow_subdomain_aliases, active, verified_at, created_at) VALUES (30, 1, 1, 'primary.example', 1, 1, 123, 123)").run();
  await db.prepare("INSERT INTO domains (id, user_id, is_global, domain, allow_subdomain_aliases, active, verified_at, created_at) VALUES (31, 1, 1, 'second.example', 0, 1, 123, 123)").run();

  const res = await app.request("/api/domains", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ domain: "shop", base_domain_id: 31, default_destination: "global" }),
  }, testEnv);

  expect(res.status).toBe(403);
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

test("admin verify does not require wildcard MX when subdomain aliases are disabled", async () => {
  const app = createApp();
  const db = env.DB as D1Database;
  const h = { cookie, "Content-Type": "application/json" };

  await db.prepare(
    "INSERT INTO domains (id, user_id, is_global, domain, allow_subdomain_aliases, active, verification_token, created_at) VALUES (40, 1, 1, 'hide.example', 0, 1, 'tok123', 123)"
  ).run();

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const name = url.searchParams.get("name");
    const type = url.searchParams.get("type");
    if (name === "_hidemyemail.hide.example" && type === "TXT") {
      return Response.json({ Status: 0, Answer: [{ type: 16, data: "hidemyemail-verify=tok123" }] });
    }
    if (name === "hide.example" && type === "MX") {
      return Response.json({ Status: 0, Answer: [{ type: 15, data: "10 inbound-smtp.us-east-1.amazonaws.com." }] });
    }
    if (name === "hide.example" && type === "TXT") {
      return Response.json({ Status: 0, Answer: [{ type: 16, data: "v=spf1 include:amazonses.com ~all" }] });
    }
    if (name === "_hidemyemail-probe.hide.example" && type === "MX") {
      return Response.json({ Status: 0, Answer: [] });
    }
    return Response.json({ Status: 3 });
  }) as any;

  const res = await app.request("/api/admin/domains/40/verify", { method: "POST", headers: h }, testEnv);

  expect(res.status).toBe(200);
  const body = await res.json<{ verified: boolean; results: { wildcard_mx: boolean } }>();
  expect(body.verified).toBe(true);
  expect(body.results.wildcard_mx).toBe(true);
});
