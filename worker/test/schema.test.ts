import { env } from "cloudflare:test";
import { expect, test } from "vitest";

test("schema: tables exist and are queryable", async () => {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM aliases").first<{ n: number }>();
  expect(r?.n).toBe(0);
});
