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

test("deleted subdomain remains reserved for its original owner", async () => {
  const app = createApp();
  const domainId = await seed();
  const otherCookie = "__Host-session=" + (await signSession("sek", 93, 3600));
  await DB().prepare("INSERT OR IGNORE INTO users (id, passphrase_hash, active, forwarding, created_at) VALUES (93, 'DOMAIN_RESERVATION_USER', 1, 1, 123)").run();

  expect((await app.request(`/api/domains/${domainId}`, { method: "DELETE", headers: { cookie } }, testEnv)).status).toBe(200);

  const create = (sessionCookie: string) => app.request("/api/domains", {
    method: "POST",
    headers: { cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ domain: "shop", default_destination: "global" }),
  }, testEnv);

  expect((await create(otherCookie)).status).toBe(409);
  expect((await create(cookie)).status).toBe(200);
});

test.each([
  ["malformed JSON", "{"],
  ["null payload", "null"],
  ["array payload", JSON.stringify(["shop"])],
  ["scalar payload", JSON.stringify("shop")],
])("POST /domains rejects %s before external or claim work", async (_description, body) => {
  const fetchMock = vi.mocked(globalThis.fetch);
  fetchMock.mockClear();

  const res = await createApp().request("/api/domains", {
    method: "POST",
    headers: h(),
    body,
  }, testEnv);

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "Invalid request body" });
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await DB().prepare("SELECT COUNT(*) AS count FROM domains").first<{ count: number }>())!.count).toBe(0);
  expect((await DB().prepare("SELECT COUNT(*) AS count FROM identifier_reservations").first<{ count: number }>())!.count).toBe(0);
});

test.each([
  ["non-string domain", { domain: 42, default_destination: "global" }, "Invalid domain"],
  ["non-string default_destination", { domain: "shop", default_destination: 42 }, "Invalid default_destination"],
  ["string base_domain_id", { domain: "shop", default_destination: "global", base_domain_id: "1" }, "Invalid base_domain_id"],
  ["non-finite base_domain_id", { domain: "shop", default_destination: "global", base_domain_id: null }, "Invalid base_domain_id"],
  ["fractional base_domain_id", { domain: "shop", default_destination: "global", base_domain_id: 1.5 }, "Invalid base_domain_id"],
  ["zero base_domain_id", { domain: "shop", default_destination: "global", base_domain_id: 0 }, "Invalid base_domain_id"],
  ["negative base_domain_id", { domain: "shop", default_destination: "global", base_domain_id: -1 }, "Invalid base_domain_id"],
])("POST /domains rejects %s before external or claim work", async (_description, payload, error) => {
  const fetchMock = vi.mocked(globalThis.fetch);
  fetchMock.mockClear();

  const res = await createApp().request("/api/domains", {
    method: "POST",
    headers: h(),
    body: JSON.stringify(payload),
  }, testEnv);

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error });
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await DB().prepare("SELECT COUNT(*) AS count FROM domains").first<{ count: number }>())!.count).toBe(0);
  expect((await DB().prepare("SELECT COUNT(*) AS count FROM identifier_reservations").first<{ count: number }>())!.count).toBe(0);
});

test("blocked subdomain labels are normalized and rejected before external or database writes", async () => {
  const app = createApp();
  const blockedEnv = { ...testEnv, BLOCKED_SUBDOMAINS: " admin, API " };
  const fetchMock = vi.mocked(globalThis.fetch);
  fetchMock.mockClear();

  const res = await app.request("/api/domains", {
    method: "POST",
    headers: h(),
    body: JSON.stringify({ domain: "  ApI  ", default_destination: "global" }),
  }, blockedEnv);

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "Subdomain is not available" });
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await DB().prepare("SELECT COUNT(*) AS count FROM domains").first<{ count: number }>())!.count).toBe(0);
  expect((await DB().prepare("SELECT COUNT(*) AS count FROM identifier_reservations").first<{ count: number }>())!.count).toBe(0);
});

test.each([
  "api,,admin",
  "api,",
  ".api",
  "*.api",
  "api.*",
  "api_name",
  "api name",
  "-api",
  "api-",
  "a".repeat(64),
])("malformed blocked-subdomain config %j fails closed before external or database writes", async (blockedConfig) => {
  const app = createApp();
  const fetchMock = vi.mocked(globalThis.fetch);
  fetchMock.mockClear();

  const res = await app.request("/api/domains", {
    method: "POST",
    headers: h(),
    body: JSON.stringify({ domain: "shop", default_destination: "global" }),
  }, { ...testEnv, BLOCKED_SUBDOMAINS: blockedConfig });

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "Subdomain is not available" });
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await DB().prepare("SELECT COUNT(*) AS count FROM domains").first<{ count: number }>())!.count).toBe(0);
  expect((await DB().prepare("SELECT COUNT(*) AS count FROM identifier_reservations").first<{ count: number }>())!.count).toBe(0);
});

test("blocked labels use exact matching and blank config adds no restrictions", async () => {
  await DB().prepare("UPDATE settings SET value = 'hidemyemail.dev' WHERE key = 'main_global_domain'").run();
  await DB().prepare(
    "INSERT INTO domains (user_id, is_global, domain, allow_subdomain_aliases, active, verified_at, created_at) VALUES (1, 1, 'hidemyemail.dev', 1, 1, 123, ?)"
  ).bind(Date.now()).run();
  const app = createApp();

  for (const [domain, blockedConfig] of [["myapi", "api"], ["api2", "api"], ["other", "   "]] as const) {
    const res = await app.request("/api/domains", {
      method: "POST",
      headers: h(),
      body: JSON.stringify({ domain, default_destination: "global" }),
    }, { ...testEnv, BLOCKED_SUBDOMAINS: blockedConfig });
    expect(res.status).toBe(200);
  }
});

test("blocked-label cache follows binding changes across valid and malformed values", async () => {
  await DB().prepare("UPDATE settings SET value = 'hidemyemail.dev' WHERE key = 'main_global_domain'").run();
  await DB().prepare(
    "INSERT INTO domains (user_id, is_global, domain, allow_subdomain_aliases, active, verified_at, created_at) VALUES (1, 1, 'hidemyemail.dev', 1, 1, 123, ?)"
  ).bind(Date.now()).run();
  const app = createApp();
  const create = (domain: string, blocked: unknown) => app.request("/api/domains", {
    method: "POST",
    headers: h(),
    body: JSON.stringify({ domain, default_destination: "global" }),
  }, { ...testEnv, BLOCKED_SUBDOMAINS: blocked });

  expect((await create("api", "api")).status).toBe(409);
  expect((await create("api", "admin")).status).toBe(200);
  expect((await create("broken", "api,,admin")).status).toBe(409);
  expect((await create("fixed", "admin")).status).toBe(200);
  expect((await create("runtime", 123)).status).toBe(409);
});

test.each(["api.name", "api_name", "api name", "-api", "api-"])("invalid requested label %j is not silently cleaned", async (domain) => {
  const app = createApp();
  const res = await app.request("/api/domains", {
    method: "POST",
    headers: h(),
    body: JSON.stringify({ domain, default_destination: "global" }),
  }, testEnv);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "Invalid prefix" });
});

test("existing blocked subdomains remain visible, editable, and deletable", async () => {
  const app = createApp();
  const id = await seed();
  const blockedEnv = { ...testEnv, BLOCKED_SUBDOMAINS: "shop" };

  const list = await app.request("/api/domains", { headers: { cookie } }, blockedEnv);
  expect((await list.json<any[]>()).some((domain) => domain.id === id)).toBe(true);

  const update = await app.request(`/api/domains/${id}`, {
    method: "PATCH",
    headers: h(),
    body: JSON.stringify({ default_destination: "work@me.com" }),
  }, blockedEnv);
  expect(update.status).toBe(200);

  const remove = await app.request(`/api/domains/${id}`, {
    method: "DELETE",
    headers: { cookie },
  }, blockedEnv);
  expect(remove.status).toBe(200);
  expect(await DB().prepare("SELECT id FROM domains WHERE id = ?").bind(id).first()).toBeNull();
});
