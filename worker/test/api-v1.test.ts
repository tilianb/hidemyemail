import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { signSession, signFreshAuth } from "../src/lib/auth";
import { encryptDestination, hashDestination, decryptDestination } from "../src/lib/crypto";
import { resetDb } from "./helpers";

// addy.io-compatible /api/v1 surface: API-key auth, alias generation
// (the Bitwarden username-generator flow), and key management.

let testEnv: any;
let sessionCookie: string;   // plain session — NOT fresh
let freshCookie: string;     // session + fresh-auth

const db = () => env.DB as D1Database;

beforeAll(async () => {
  testEnv = { ...env, SESSION_SECRET: "sek" };
  const session = await signSession("sek", 1, 3600);
  sessionCookie = "__Host-session=" + session;
  freshCookie = sessionCookie + "; __Host-fresh-auth=" + (await signFreshAuth("sek", 1, 600));
});

beforeEach(async () => {
  await resetDb(db());
  await db().prepare("DELETE FROM destinations").run();
  await db().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('main_global_domain','hidemyemail.dev',0) ON CONFLICT(key) DO UPDATE SET value='hidemyemail.dev'").run();
  await db().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('max_total_aliases','10',0) ON CONFLICT(key) DO UPDATE SET value='10'").run();
  await db().prepare(
    "INSERT INTO domains (id, user_id, is_global, domain, allow_custom_aliases, allow_subdomain_aliases, active, verified_at, created_at) VALUES (10, 1, 1, 'hidemyemail.dev', 0, 1, 1, 123, 123)"
  ).run();
});

async function addDefaultDestination(email = "real@me.com") {
  const enc = await encryptDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY);
  const hash = await hashDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY);
  await db().prepare(
    "INSERT INTO destinations (user_id, email, email_hash, token, verified_at, created_at, is_default) VALUES (1, ?, ?, ?, 123, 123, 1)"
  ).bind(enc, hash, crypto.randomUUID()).run();
}

async function createKey(app = createApp(), name = "Bitwarden"): Promise<string> {
  const res = await app.request("/api/settings/api-keys", {
    method: "POST",
    headers: { cookie: freshCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }, testEnv);
  expect(res.status).toBe(200);
  const body = await res.json<{ token: string }>();
  return body.token;
}

test("key management: create is fresh-auth gated, list masks token, revoke kills it", async () => {
  const app = createApp();

  // A long-lived session alone must not be able to mint a durable credential.
  const stale = await app.request("/api/settings/api-keys", {
    method: "POST",
    headers: { cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "nope" }),
  }, testEnv);
  expect(stale.status).toBe(401);

  const token = await createKey(app);
  expect(token.startsWith("hme_")).toBe(true);

  const list = await app.request("/api/settings/api-keys", { headers: { cookie: sessionCookie } }, testEnv);
  expect(list.status).toBe(200);
  const keys = await list.json<{ id: number; name: string; token_prefix: string }[]>();
  expect(keys.length).toBe(1);
  expect(keys[0]!.name).toBe("Bitwarden");
  expect(keys[0]!.token_prefix).toBe(token.slice(0, 8));
  expect(JSON.stringify(keys)).not.toContain(token);

  // Key works against v1…
  const details = await app.request("/api/v1/api-token-details", {
    headers: { Authorization: `Bearer ${token}` },
  }, testEnv);
  expect(details.status).toBe(200);
  expect((await details.json<{ name: string }>()).name).toBe("Bitwarden");

  // …until revoked (also fresh-auth gated).
  const staleDel = await app.request(`/api/settings/api-keys/${keys[0]!.id}`, {
    method: "DELETE", headers: { cookie: sessionCookie },
  }, testEnv);
  expect(staleDel.status).toBe(401);
  const del = await app.request(`/api/settings/api-keys/${keys[0]!.id}`, {
    method: "DELETE", headers: { cookie: freshCookie },
  }, testEnv);
  expect(del.status).toBe(200);

  const after = await app.request("/api/v1/api-token-details", {
    headers: { Authorization: `Bearer ${token}` },
  }, testEnv);
  expect(after.status).toBe(401);
});

test("v1 requires a valid bearer key; session cookies don't work", async () => {
  const app = createApp();
  expect((await app.request("/api/v1/aliases", {}, testEnv)).status).toBe(401);
  expect((await app.request("/api/v1/aliases", { headers: { Authorization: "Bearer hme_bogus" } }, testEnv)).status).toBe(401);
  expect((await app.request("/api/v1/aliases", { headers: { cookie: freshCookie } }, testEnv)).status).toBe(401);
});

test("Bitwarden flow: POST /api/v1/aliases with domain+description creates a random alias", async () => {
  const app = createApp();
  await addDefaultDestination();
  const token = await createKey(app);
  const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const res = await app.request("/api/v1/aliases", {
    method: "POST", headers: h,
    body: JSON.stringify({ domain: "hidemyemail.dev", description: "Website: example.com. Generated by Bitwarden." }),
  }, testEnv);
  expect(res.status).toBe(201);
  const { data } = await res.json<{ data: { email: string; active: boolean; description: string; local_part: string; domain: string } }>();
  expect(data.email).toBe(`${data.local_part}@hidemyemail.dev`);
  expect(data.email.endsWith("@hidemyemail.dev")).toBe(true);
  expect(data.active).toBe(true);
  expect(data.description).toContain("Bitwarden");

  // Forwarding wiring: destination is the default, source records 'api'.
  const row = await db().prepare("SELECT destination, source, label FROM aliases WHERE full_address = ?")
    .bind(data.email).first<{ destination: string; source: string; label: string }>();
  expect(row!.source).toBe("api");
  expect(await decryptDestination(row!.destination, testEnv.DESTINATION_ENCRYPTION_KEY)).toBe("real@me.com");
});

test("POST /api/v1/aliases without a domain uses the main global domain", async () => {
  const app = createApp();
  await addDefaultDestination();
  const token = await createKey(app);

  const res = await app.request("/api/v1/aliases", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  }, testEnv);
  expect(res.status).toBe(201);
  const { data } = await res.json<{ data: { email: string } }>();
  expect(data.email.endsWith("@hidemyemail.dev")).toBe(true);
});

test("POST /api/v1/aliases fails cleanly without a default destination", async () => {
  const app = createApp();
  const token = await createKey(app);
  const res = await app.request("/api/v1/aliases", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ domain: "hidemyemail.dev" }),
  }, testEnv);
  expect(res.status).toBe(422);
  expect((await res.json<{ message: string }>()).message).toContain("destination");
});

test("format handling: uuid works, custom respects allow_custom_aliases, unknown format rejected", async () => {
  const app = createApp();
  await addDefaultDestination();
  const token = await createKey(app);
  const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const uuid = await app.request("/api/v1/aliases", {
    method: "POST", headers: h, body: JSON.stringify({ format: "uuid" }),
  }, testEnv);
  expect(uuid.status).toBe(201);
  const uuidBody = await uuid.json<{ data: { local_part: string } }>();
  expect(uuidBody.data.local_part).toMatch(/^[0-9a-f-]{36}$/);

  // Global domain seeded with allow_custom_aliases = 0.
  const custom = await app.request("/api/v1/aliases", {
    method: "POST", headers: h, body: JSON.stringify({ format: "custom", local_part: "shop" }),
  }, testEnv);
  expect(custom.status).toBe(403);

  const words = await app.request("/api/v1/aliases", {
    method: "POST", headers: h, body: JSON.stringify({ format: "random_words" }),
  }, testEnv);
  expect(words.status).toBe(422);
});

test("custom format works on the user's own (subdomain) domain without a default destination", async () => {
  const app = createApp();
  const token = await createKey(app);
  await db().prepare(
    "INSERT INTO domains (id, user_id, is_global, domain, allow_custom_aliases, active, created_at) VALUES (11, 1, 0, 'me.hidemyemail.dev', 1, 1, 123)"
  ).run();

  const res = await app.request("/api/v1/aliases", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ domain: "me.hidemyemail.dev", format: "custom", local_part: "shop" }),
  }, testEnv);
  expect(res.status).toBe(201);
  expect((await res.json<{ data: { email: string } }>()).data.email).toBe("shop@me.hidemyemail.dev");
});

test("another user's domain and unknown domains are rejected", async () => {
  const app = createApp();
  await addDefaultDestination();
  const token = await createKey(app);
  const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  await db().prepare("INSERT INTO users (id, passphrase_hash, created_at) VALUES (2, 'other', 123)").run();
  await db().prepare(
    "INSERT INTO domains (id, user_id, is_global, domain, active, created_at) VALUES (12, 2, 0, 'other.hidemyemail.dev', 1, 123)"
  ).run();

  const foreign = await app.request("/api/v1/aliases", {
    method: "POST", headers: h, body: JSON.stringify({ domain: "other.hidemyemail.dev" }),
  }, testEnv);
  expect(foreign.status).toBe(422);

  const unknown = await app.request("/api/v1/aliases", {
    method: "POST", headers: h, body: JSON.stringify({ domain: "nope.example" }),
  }, testEnv);
  expect(unknown.status).toBe(422);

  await db().prepare("DELETE FROM domains WHERE id = 12").run();
  await db().prepare("DELETE FROM users WHERE id = 2").run();
});

test("alias quota is enforced", async () => {
  const app = createApp();
  await addDefaultDestination();
  const token = await createKey(app);
  await db().prepare("UPDATE settings SET value = '1' WHERE key = 'max_total_aliases'").run();
  const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  expect((await app.request("/api/v1/aliases", { method: "POST", headers: h, body: "{}" }, testEnv)).status).toBe(201);
  const second = await app.request("/api/v1/aliases", { method: "POST", headers: h, body: "{}" }, testEnv);
  expect(second.status).toBe(403);
});

test("list, get, deactivate/activate, delete round-trip; other users' aliases invisible", async () => {
  const app = createApp();
  await addDefaultDestination();
  const token = await createKey(app);
  const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const created = await app.request("/api/v1/aliases", { method: "POST", headers: h, body: "{}" }, testEnv);
  const { data } = await created.json<{ data: { id: string } }>();
  const id = data.id;

  const list = await app.request("/api/v1/aliases", { headers: h }, testEnv);
  expect((await list.json<{ data: unknown[] }>()).data.length).toBe(1);

  const got = await app.request(`/api/v1/aliases/${id}`, { headers: h }, testEnv);
  expect(got.status).toBe(200);

  // Deactivate → active false; activate → true again.
  const off = await app.request(`/api/v1/active-aliases/${id}`, { method: "DELETE", headers: h }, testEnv);
  expect(off.status).toBe(204);
  let row = await db().prepare("SELECT active FROM aliases WHERE id = ?").bind(id).first<{ active: number }>();
  expect(row!.active).toBe(0);

  const on = await app.request("/api/v1/active-aliases", { method: "POST", headers: h, body: JSON.stringify({ id }) }, testEnv);
  expect(on.status).toBe(200);
  expect((await on.json<{ data: { active: boolean } }>()).data.active).toBe(true);

  // Another user's alias is invisible to this key.
  await db().prepare("INSERT INTO users (id, passphrase_hash, created_at) VALUES (3, 'someone', 123)").run();
  await db().prepare(
    "INSERT INTO aliases (id, domain_id, user_id, local_part, full_address, active, source, created_at) VALUES (9999, 10, 3, 'theirs', 'theirs@hidemyemail.dev', 1, 'dashboard', 123)"
  ).run();
  expect((await app.request("/api/v1/aliases/9999", { headers: h }, testEnv)).status).toBe(404);
  expect((await app.request("/api/v1/aliases/9999", { method: "DELETE", headers: h }, testEnv)).status).toBe(404);
  await db().prepare("DELETE FROM aliases WHERE id = 9999").run();
  await db().prepare("DELETE FROM users WHERE id = 3").run();

  const del = await app.request(`/api/v1/aliases/${id}`, { method: "DELETE", headers: h }, testEnv);
  expect(del.status).toBe(204);
  const list2 = await app.request("/api/v1/aliases", { headers: h }, testEnv);
  expect((await list2.json<{ data: unknown[] }>()).data.length).toBe(0);
});

test("domain-options lists usable domains with the main domain as default", async () => {
  const app = createApp();
  const token = await createKey(app);
  await db().prepare(
    "INSERT INTO domains (id, user_id, is_global, domain, active, verified_at, created_at) VALUES (13, 1, 1, 'unverified.example', 1, NULL, 123)"
  ).run();
  await db().prepare(
    "INSERT INTO domains (id, user_id, is_global, domain, active, created_at) VALUES (14, 1, 0, 'mine.hidemyemail.dev', 1, 123)"
  ).run();

  const res = await app.request("/api/v1/domain-options", {
    headers: { Authorization: `Bearer ${token}` },
  }, testEnv);
  expect(res.status).toBe(200);
  const body = await res.json<{ data: string[]; defaultAliasDomain: string; defaultAliasFormat: string }>();
  expect(body.data).toContain("hidemyemail.dev");
  expect(body.data).toContain("mine.hidemyemail.dev");
  expect(body.data).not.toContain("unverified.example");
  expect(body.defaultAliasDomain).toBe("hidemyemail.dev");
  expect(body.defaultAliasFormat).toBe("random_characters");
});

test("disabled account's API key stops authenticating", async () => {
  const app = createApp();
  const token = await createKey(app);
  await db().prepare("UPDATE users SET active = 0 WHERE id = 1").run();
  const res = await app.request("/api/v1/api-token-details", {
    headers: { Authorization: `Bearer ${token}` },
  }, testEnv);
  expect(res.status).toBe(401);
  await db().prepare("UPDATE users SET active = 1 WHERE id = 1").run();
});
