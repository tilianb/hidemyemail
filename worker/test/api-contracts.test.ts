import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { signSession } from "../src/lib/auth";

let cookie: string;
beforeAll(async () => { cookie = `__Host-session=${await signSession("contracts", 1, 3600)}`; });

test.each([
  ["POST", "/api/aliases", { domain_id: 1, local_part: {} }],
  ["PATCH", "/api/aliases/1", { destination: 17 }],
  ["PATCH", "/api/aliases/1", { label: { nested: "value" } }],
  ["POST", "/api/destinations", { email: 17 }],
  ["POST", "/api/destinations", null],
])("%s %s rejects wrong JSON types before domain logic", async (method, path, body) => {
  const response = await createApp().request(path as string, {
    method: method as string, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  }, { ...env, SESSION_SECRET: "contracts" });
  expect(response.status).toBe(400);
  expect(await response.json()).toHaveProperty("error");
});
