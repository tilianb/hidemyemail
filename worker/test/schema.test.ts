import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { reserveIdentifierAndRun } from "../src/db/reservations";

test("schema: tables exist and are queryable", async () => {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM aliases").first<{ n: number }>();
  expect(r?.n).toBe(0);
});

test("failed entity inserts roll back identifier claims", async () => {
  const db = env.DB as D1Database;
  await expect(reserveIdentifierAndRun(db, "alias", "failed@example.com", 1, db.prepare(
    "INSERT INTO aliases (domain_id, user_id, local_part, full_address, source, created_at) VALUES (99999, 1, 'failed', 'failed@example.com', 'dashboard', 123)"
  ))).rejects.toThrow();
  expect(await db.prepare(
    "SELECT user_id FROM identifier_reservations WHERE kind = 'alias' AND value = 'failed@example.com'"
  ).first()).toBeNull();

  await db.prepare(
    "INSERT INTO domains (id, user_id, is_global, domain, active, created_at) VALUES (99998, 1, 1, 'collision.example', 1, 123)"
  ).run();
  await expect(reserveIdentifierAndRun(db, "subdomain", "collision.example", 1, db.prepare(
    "INSERT INTO domains (id, user_id, is_global, domain, active, created_at) VALUES (99997, 1, 0, 'collision.example', 1, 123)"
  ))).rejects.toThrow();
  expect(await db.prepare(
    "SELECT user_id FROM identifier_reservations WHERE kind = 'subdomain' AND value = 'collision.example'"
  ).first()).toBeNull();
});
