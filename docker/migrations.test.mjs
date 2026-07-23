import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";
import { applyMigrations } from "./migrations.mjs";

test("a failed multi-statement migration rolls back and can be retried", async (t) => {
  const migrationsDir = await mkdtemp(path.join(os.tmpdir(), "hidemyemail-migrations-"));
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2026-05-01",
    d1Databases: { DB: "migration-test" },
  });
  t.after(async () => {
    await mf.dispose();
    await rm(migrationsDir, { recursive: true, force: true });
  });

  const migration = path.join(migrationsDir, "0001_atomic.sql");
  await writeFile(migration, [
    "CREATE TABLE rolled_back (id INTEGER PRIMARY KEY);",
    "INSERT INTO table_that_does_not_exist (id) VALUES (1);",
  ].join("\n"));

  await mf.ready;
  const db = await mf.getD1Database("DB");
  await assert.rejects(applyMigrations(db, migrationsDir));
  const tablesAfterFailure = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rolled_back'",
  ).all();
  assert.deepEqual(tablesAfterFailure.results, []);
  const trackedAfterFailure = await db.prepare(
    "SELECT name FROM d1_migrations WHERE name = '0001_atomic.sql'",
  ).all();
  assert.deepEqual(trackedAfterFailure.results, []);

  await writeFile(migration, await readFile(migration, "utf8").then((sql) =>
    sql.replace("INSERT INTO table_that_does_not_exist (id) VALUES (1);", "INSERT INTO rolled_back (id) VALUES (1);"),
  ));
  await applyMigrations(db, migrationsDir);

  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM rolled_back").first()).count, 1);
  assert.equal((await db.prepare(
    "SELECT COUNT(*) AS count FROM d1_migrations WHERE name = '0001_atomic.sql'",
  ).first()).count, 1);
});

test("Docker startup accepts no APP_ORIGIN and migrates before listening", async () => {
  const server = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  const requiredConfig = server.slice(
    server.indexOf("const REQUIRED_CONFIG"),
    server.indexOf("const missing"),
  );
  assert.doesNotMatch(requiredConfig, /APP_ORIGIN/);
  assert.match(server, /APP_ORIGIN:\s*env\.APP_ORIGIN\s*\?\?\s*["']{2}/);
  assert.ok(
    server.indexOf("await applyMigrations") < server.indexOf("server.listen"),
    "pending migrations must finish before the HTTP socket listens",
  );
});
