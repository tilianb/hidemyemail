import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { signSession } from "../src/lib/auth";
import { resetDb } from "./helpers";

let testEnv: any; let cookie: string;
beforeAll(async () => { testEnv = { ...env, SESSION_SECRET: "sek" }; cookie = "session=" + (await signSession("sek", 3600)); });
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

  const del = await app.request(`/api/aliases/${alias.id}`, { method: "DELETE", headers: { cookie } }, testEnv);
  expect(del.status).toBe(200);
  const list2 = await app.request("/api/aliases", { headers: { cookie } }, testEnv);
  expect((await list2.json<any[]>()).length).toBe(0);
});
