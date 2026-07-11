// Events retention + the durable contacts store that makes it safe.
//
// The reply first-contact gate used to scan `events` for old `forward` rows,
// which blocked any retention prune. It now reads the durable `contacts` table,
// so events can be pruned without revoking reply access.
import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import * as q from "../src/db/queries";
import { pruneOldEvents } from "../src/lib/purge";
import { resetDb } from "./helpers";

const DB = () => env.DB as D1Database;
const DAY = 24 * 3_600_000;

async function setSetting(key: string, value: string) {
  await DB().prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value, Date.now()).run();
}

beforeEach(async () => {
  await resetDb(DB());
  // resetDb leaves `settings` untouched; clear it so a setting written by one
  // test (e.g. events_retention_days = -1) can't leak into the next.
  await DB().prepare("DELETE FROM settings").run();
  await q.createDomain(DB(), "hidemyemail.dev", "real@me.com");
  await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
});

test("pruneOldEvents deletes events older than retention, keeps recent", async () => {
  const now = Date.now();
  await q.insertEvent(DB(), { alias_id: 1, type: "forward", external_sender: "a@x.com", ts: now - 100 * DAY });
  await q.insertEvent(DB(), { alias_id: 1, type: "forward", external_sender: "b@x.com", ts: now - 1 * DAY });

  const deleted = await pruneOldEvents(DB(), now); // default retention 90 days
  expect(deleted).toBe(1);

  const remaining = await DB().prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
  expect(remaining?.n).toBe(1);
});

test("pruneOldEvents with retention -1 is a no-op", async () => {
  const now = Date.now();
  await setSetting("events_retention_days", "-1");
  await q.insertEvent(DB(), { alias_id: 1, type: "forward", external_sender: "a@x.com", ts: now - 1000 * DAY });

  const deleted = await pruneOldEvents(DB(), now);
  expect(deleted).toBe(0);
  const remaining = await DB().prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
  expect(remaining?.n).toBe(1);
});

test("reply gate survives event prune: contacts is durable", async () => {
  const now = Date.now();
  // A real forward writes both an event and a contact.
  await q.insertEvent(DB(), { alias_id: 1, type: "forward", external_sender: "boss@store.com", ts: now - 200 * DAY });
  await q.recordContact(DB(), 1, "boss@store.com", now - 200 * DAY);

  // Prune wipes the old forward event...
  await pruneOldEvents(DB(), now);
  const ev = await DB().prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
  expect(ev?.n).toBe(0);

  // ...but the first-contact gate still authorises a reply.
  expect(await q.hasPriorInbound(DB(), 1, "boss@store.com")).toBe(true);
});

test("recordContact is idempotent and case-insensitive", async () => {
  const now = Date.now();
  await q.recordContact(DB(), 1, "Boss@Store.com", now);
  await q.recordContact(DB(), 1, "boss@store.com", now + 1000);

  const rows = await DB().prepare("SELECT COUNT(*) AS n FROM contacts WHERE alias_id = 1").first<{ n: number }>();
  expect(rows?.n).toBe(1);
  expect(await q.hasPriorInbound(DB(), 1, "BOSS@STORE.COM")).toBe(true);
});
