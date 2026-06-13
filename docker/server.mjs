// Miniflare host for hidemyemail.dev self-host containers.
//
// Loads the pre-bundled worker (built by `wrangler deploy --dry-run`) and wires
// up D1 + Assets bindings against local SQLite + dashboard static files. All
// secrets come from process.env so they can be supplied via docker-compose,
// `--env-file`, or your secrets manager of choice.

import { readdir, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Miniflare } from "miniflare";

const env = process.env;

// ─── Required config ────────────────────────────────────────────────────────
const REQUIRED_SECRETS = [
  "SESSION_SECRET",
  "AUTH_PASSWORD_HASH",
  "AUTH_PASSWORD_SALT",
  "DESTINATION_ENCRYPTION_KEY",
  "SES_ACCESS_KEY_ID",
  "SES_SECRET_ACCESS_KEY",
];
const missing = REQUIRED_SECRETS.filter((k) => !env[k]);
if (missing.length) {
  console.error(`[hidemyemail] Missing required env vars: ${missing.join(", ")}`);
  console.error(`[hidemyemail] See docker/.env.example for the full list.`);
  process.exit(1);
}

const DATA_DIR = env.DATA_DIR ?? "/data";
const ASSETS_DIR = env.ASSETS_DIR ?? "/app/public";
const WORKER_SCRIPT = env.WORKER_SCRIPT ?? "/app/worker-dist/index.js";
const MIGRATIONS_DIR = env.MIGRATIONS_DIR ?? "/app/migrations";
const PORT = Number(env.PORT ?? 8787);
const HOST = env.HOST ?? "0.0.0.0";

const D1_PERSIST_DIR = path.join(DATA_DIR, "d1");
await mkdir(D1_PERSIST_DIR, { recursive: true });

// Load worker bundle into memory and strip the inline sourceMappingURL
// comment before handing it to workerd. The bundle ships with
// `//# sourceMappingURL=index.js.map`; if workerd can see that comment AND
// the sibling `.map` file (either through scriptPath or modulesRoot), it
// resolves the map and aborts at boot with
// `can't use ".." to break out of starting directory` because the map's
// `sources` entries walk above the bundle directory.
//
// Passing the cleaned source via `script` + a synthetic `scriptPath` that
// has no `.map` sibling means workerd never finds the map and never aborts.
const workerScriptRaw = await readFile(WORKER_SCRIPT, "utf8");
const workerScript = workerScriptRaw.replace(/^\/\/# sourceMappingURL=.*$/m, "");

// ─── Boot Miniflare ─────────────────────────────────────────────────────────
const mf = new Miniflare({
  // Mirrors wrangler.jsonc — keep compatibility settings aligned with prod.
  script: workerScript,
  // Use a synthetic identity that isn't a real path so workerd can't locate
  // the bundle's `.map` file from it. Miniflare only uses this string as a
  // module name when `script` is provided.
  scriptPath: "worker.mjs",
  modules: true,
  compatibilityDate: env.COMPATIBILITY_DATE ?? "2026-05-01",
  compatibilityFlags: ["nodejs_compat"],

  host: HOST,
  port: PORT,

  // D1 — file-backed SQLite under DATA_DIR/d1
  d1Databases: { DB: "hidemyemail-db" },
  d1Persist: D1_PERSIST_DIR,

  // Static SPA (dashboard/dist) — Workers Assets routing parity.
  // run_worker_first: ["/api/*"] from wrangler.jsonc becomes:
  //   has_user_worker + static_routing.user_worker
  assets: {
    directory: ASSETS_DIR,
    binding: "ASSETS",
    routerConfig: {
      has_user_worker: true,
      static_routing: { user_worker: ["/api/*"] },
    },
    assetConfig: {
      not_found_handling: "single-page-application",
      html_handling: "auto-trailing-slash",
    },
  },

  // Plain vars (non-secret, mirror wrangler.jsonc top-level vars block)
  bindings: {
    ENVIRONMENT: env.ENVIRONMENT ?? "self-hosted",
    SES_REGION: env.SES_REGION ?? "ap-southeast-2",
    S3_INBOUND_BUCKET: env.S3_INBOUND_BUCKET ?? "hidemyemail-inbound-raw",
    SNS_INBOUND_TOPIC_ARN: env.SNS_INBOUND_TOPIC_ARN ?? "",
    SNS_ALLOWED_TOPIC_ARN: env.SNS_ALLOWED_TOPIC_ARN ?? "",
    // Secrets — Miniflare treats `bindings` and secrets the same way; the
    // worker reads them off `env`. Keep them in this map so the Env interface
    // sees the full surface.
    SES_ACCESS_KEY_ID: env.SES_ACCESS_KEY_ID,
    SES_SECRET_ACCESS_KEY: env.SES_SECRET_ACCESS_KEY,
    SESSION_SECRET: env.SESSION_SECRET,
    AUTH_PASSWORD_HASH: env.AUTH_PASSWORD_HASH,
    AUTH_PASSWORD_SALT: env.AUTH_PASSWORD_SALT,
    DESTINATION_ENCRYPTION_KEY: env.DESTINATION_ENCRYPTION_KEY,
    SNS_SECRET: env.SNS_SECRET ?? "",
  },
});

await mf.ready;

// ─── Migrations ─────────────────────────────────────────────────────────────
// Apply on every boot. Each migration is idempotent SQL; D1 stores no
// migration state of its own here, so we wrap in CREATE-IF-NOT-EXISTS via a
// hand-rolled tracking table that mirrors wrangler's d1_migrations table.
await applyMigrations();

// ─── Scheduled purge ────────────────────────────────────────────────────────
// Invoke the worker's scheduled handler on an interval so the same
// purgeDeletedAccounts logic runs in the self-hosted container.
// Default: every 6 hours. Override with PURGE_INTERVAL_MS env var.
const PURGE_INTERVAL_MS = Number(env.PURGE_INTERVAL_MS ?? 6 * 3600_000);

async function runScheduled() {
  try {
    const worker = await mf.getWorker();
    await worker.scheduled();
  } catch (err) {
    console.error("[hidemyemail] scheduled purge failed", err);
  }
}

setInterval(runScheduled, PURGE_INTERVAL_MS);

console.log(`[hidemyemail] Listening on http://${HOST}:${PORT}`);
console.log(`[hidemyemail] D1 persisted to ${D1_PERSIST_DIR}`);
console.log(`[hidemyemail] Static assets from ${ASSETS_DIR}`);

// ─── Shutdown ───────────────────────────────────────────────────────────────
const shutdown = async (signal) => {
  console.log(`[hidemyemail] Received ${signal}, shutting down…`);
  try {
    await mf.dispose();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Helpers ────────────────────────────────────────────────────────────────
async function applyMigrations() {
  const db = await mf.getD1Database("DB");
  await db.exec(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  );
  const applied = new Set(
    (await db.prepare("SELECT name FROM d1_migrations").all()).results.map(
      (r) => r.name
    )
  );

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    console.log(`[hidemyemail] Applying migration ${file}`);

    // D1's exec() runs statements separated by newlines; our migrations use
    // semicolons. Split conservatively: respect string literals so the SPF/DMARC
    // INSERTs (which may contain ";") aren't mangled. The migrations in this
    // repo are simple DDL so a naive split is safe today, but keep this guard
    // so future contributors don't get bitten.
    const statements = splitSqlStatements(sql);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      await db.prepare(trimmed).run();
    }

    await db
      .prepare("INSERT INTO d1_migrations (name) VALUES (?)")
      .bind(file)
      .run();
  }
}

function splitSqlStatements(sql) {
  const out = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === ";" && !inSingle && !inDouble) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}
