import { env } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "../src/api/app";
import { signSession } from "../src/lib/auth";
import { encryptDestination, hashDestination } from "../src/lib/crypto";
import { resetDb } from "./helpers";

let testEnv: any; let cookie: string;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  testEnv = { ...env, SESSION_SECRET: "sek" };
  cookie = "__Host-session=" + (await signSession("sek", 1, 3600));
  // POST /domains DNS-checks MX; stub fetch so tests don't hit real DNS.
  globalThis.fetch = vi.fn(async () => new Response("", { status: 503 })) as any;
});
afterAll(() => { globalThis.fetch = realFetch; });

const DB = () => env.DB as D1Database;
const h = () => ({ cookie, "Content-Type": "application/json" });

// Create the main global domain + two verified destinations, then a personal subdomain.
async function seed(): Promise<number> {
  await DB().prepare("UPDATE settings SET value = 'hidemyemail.dev' WHERE key = 'main_global_domain'").run();
  await DB().prepare(
    "INSERT INTO domains (user_id, is_global, domain, allow_subdomain_aliases, active, verified_at, created_at) VALUES (1, 1, 'hidemyemail.dev', 1, 1, 123, ?)"
  ).bind(Date.now()).run();
  for (const e of ["real@me.com", "work@me.com"]) {
    const enc = await encryptDestination(e, testEnv.DESTINATION_ENCRYPTION_KEY);
    const hash = await hashDestination(e, testEnv.DESTINATION_ENCRYPTION_KEY);
    await DB().prepare("INSERT INTO destinations (user_id, email, email_hash, token, verified_at, created_at) VALUES (1, ?, ?, ?, 123, 123)")
      .bind(enc, hash, `tok-${e}`).run();
  }
  const app = createApp();
  const cd = await app.request("/api/domains", { method: "POST", headers: h(), body: JSON.stringify({ domain: "shop", default_destination: "real@me.com" }) }, testEnv);
  expect(cd.status).toBe(200);
  return (await cd.json<{ id: number }>()).id;
}

beforeEach(async () => {
  await resetDb(DB());
  await DB().prepare("DELETE FROM destinations").run();
});

test("PATCH /domains/:id updates default destination without recreating the subdomain", async () => {
  const app = createApp();
  const id = await seed();

  const res = await app.request(`/api/domains/${id}`, { method: "PATCH", headers: h(), body: JSON.stringify({ default_destination: "work@me.com" }) }, testEnv);
  expect(res.status).toBe(200);

  const doms = await (await app.request("/api/domains", { headers: { cookie } }, testEnv)).json<any[]>();
  const sub = doms.find(d => d.id === id);
  expect(sub.default_destination).toBe("work@me.com");
});

test("PATCH to Global Default is accepted", async () => {
  const app = createApp();
  const id = await seed();
  const res = await app.request(`/api/domains/${id}`, { method: "PATCH", headers: h(), body: JSON.stringify({ default_destination: "global" }) }, testEnv);
  expect(res.status).toBe(200);
  const doms = await (await app.request("/api/domains", { headers: { cookie } }, testEnv)).json<any[]>();
  expect(doms.find(d => d.id === id).default_destination).toBe("global");
});

test("PATCH to an unverified/foreign destination is rejected", async () => {
  const app = createApp();
  const id = await seed();
  const res = await app.request(`/api/domains/${id}`, { method: "PATCH", headers: h(), body: JSON.stringify({ default_destination: "stranger@evil.com" }) }, testEnv);
  expect(res.status).toBe(400);
});

test("PATCH on a global domain is rejected (managed via admin)", async () => {
  const app = createApp();
  await seed();
  const gid = (await DB().prepare("SELECT id FROM domains WHERE domain = 'hidemyemail.dev'").first<{ id: number }>())!.id;
  const res = await app.request(`/api/domains/${gid}`, { method: "PATCH", headers: h(), body: JSON.stringify({ default_destination: "work@me.com" }) }, testEnv);
  expect(res.status).toBe(400);
});

test("PATCH on another user's domain → 404 (no IDOR)", async () => {
  const app = createApp();
  const id = await seed();
  await DB().prepare("INSERT OR IGNORE INTO users (id, passphrase_hash, active, forwarding, created_at) VALUES (2, 'USER2', 1, 1, ?)").bind(Date.now()).run();
  const otherCookie = "__Host-session=" + (await signSession("sek", 2, 3600));
  const res = await app.request(`/api/domains/${id}`, { method: "PATCH", headers: { cookie: otherCookie, "Content-Type": "application/json" }, body: JSON.stringify({ default_destination: "work@me.com" }) }, testEnv);
  expect(res.status).toBe(404);
});
