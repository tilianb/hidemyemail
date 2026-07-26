// Miniflare host for hidemyemail.dev self-host containers.
//
// Loads the pre-bundled worker (built by `wrangler deploy --dry-run`) and wires
// up D1 + Assets bindings against local SQLite + dashboard static files. All
// secrets come from process.env so they can be supplied via docker-compose,
// `--env-file`, or your secrets manager of choice.

import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { Miniflare } from "miniflare";
import { trustedProxySet, workerHeaders } from "./client-ip.mjs";
import { applyMigrations } from "./migrations.mjs";

const env = process.env;

// ─── Required config ────────────────────────────────────────────────────────
const REQUIRED_CONFIG = [
  "SESSION_SECRET",
  "AUTH_PASSWORD_HASH",
  "AUTH_PASSWORD_SALT",
  "DESTINATION_ENCRYPTION_KEY",
  "SES_ACCESS_KEY_ID",
  "SES_SECRET_ACCESS_KEY",
];
const missing = REQUIRED_CONFIG.filter((k) => !env[k]);
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
const TRUSTED_PROXIES = trustedProxySet(env.TRUSTED_PROXY_IPS);

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
    APP_ORIGIN: env.APP_ORIGIN ?? "",
    SES_REGION: env.SES_REGION ?? "ap-southeast-2",
    S3_INBOUND_BUCKET: env.S3_INBOUND_BUCKET ?? "hidemyemail-inbound-raw",
    SNS_INBOUND_TOPIC_ARN: env.SNS_INBOUND_TOPIC_ARN ?? "",
    SNS_ALLOWED_TOPIC_ARN: env.SNS_ALLOWED_TOPIC_ARN ?? "",
    // iOS push (optional) — APNs token auth. Empty values leave push disabled
    // (apnsConfig() returns null), so registration still works but nothing is
    // sent. APPLE_APP_ID supplies team/bundle when the dedicated vars are unset.
    APPLE_APP_ID: env.APPLE_APP_ID ?? "",
    APNS_KEY_ID: env.APNS_KEY_ID ?? "",
    APNS_TEAM_ID: env.APNS_TEAM_ID ?? "",
    APNS_BUNDLE_ID: env.APNS_BUNDLE_ID ?? "",
    APNS_HOST: env.APNS_HOST ?? "",
    // Android push (optional) — FCM HTTP v1. Empty leaves Android push disabled
    // (fcmConfig() returns null). FCM_PROJECT_ID defaults to the service
    // account's project_id when unset.
    FCM_PROJECT_ID: env.FCM_PROJECT_ID ?? "",
    // Secrets — Miniflare treats `bindings` and secrets the same way; the
    // worker reads them off `env`. Keep them in this map so the Env interface
    // sees the full surface.
    SES_ACCESS_KEY_ID: env.SES_ACCESS_KEY_ID,
    SES_SECRET_ACCESS_KEY: env.SES_SECRET_ACCESS_KEY,
    SESSION_SECRET: env.SESSION_SECRET,
    AUTH_PASSWORD_HASH: env.AUTH_PASSWORD_HASH,
    AUTH_PASSWORD_SALT: env.AUTH_PASSWORD_SALT,
    DESTINATION_ENCRYPTION_KEY: env.DESTINATION_ENCRYPTION_KEY,
    ACTION_SECRET: env.ACTION_SECRET ?? "",
    APNS_AUTH_KEY: env.APNS_AUTH_KEY ?? "",
    FCM_SERVICE_ACCOUNT: env.FCM_SERVICE_ACCOUNT ?? "",
  },
});

await mf.ready;

// Apply all pending migrations before accepting traffic. Each migration's SQL
// and tracking row run in one D1 batch, so a failed migration can be retried.
const db = await mf.getD1Database("DB");
await applyMigrations(db, MIGRATIONS_DIR);

// Terminate HTTP outside workerd so the socket peer is authoritative. Caller
// forwarding headers are stripped before every request enters the Worker.
const server = createServer(async (request, response) => {
  try {
    const headers = workerHeaders(
      new Headers(request.headers),
      request.socket.remoteAddress,
      TRUSTED_PROXIES,
    );
    const origin = `http://${request.headers.host ?? `localhost:${PORT}`}`;
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : request;
    const workerResponse = await mf.dispatchFetch(new URL(request.url ?? "/", origin), {
      method: request.method,
      headers,
      body,
      duplex: body ? "half" : undefined,
    });
    const responseHeaders = Object.fromEntries(workerResponse.headers);
    const cookies = workerResponse.headers.getSetCookie();
    if (cookies.length) responseHeaders["set-cookie"] = cookies;
    response.writeHead(workerResponse.status, responseHeaders);
    response.end(Buffer.from(await workerResponse.arrayBuffer()));
  } catch (err) {
    console.error("[hidemyemail] request rejected", err);
    response.writeHead(400).end("Bad Request");
  }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, HOST, resolve);
});

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

// Run once at startup so a container restarted more often than the interval
// still purges tombstoned accounts, then keep to the schedule.
void runScheduled();
setInterval(runScheduled, PURGE_INTERVAL_MS);

console.log(`[hidemyemail] Listening on http://${HOST}:${PORT}`);
console.log(`[hidemyemail] D1 persisted to ${D1_PERSIST_DIR}`);
console.log(`[hidemyemail] Static assets from ${ASSETS_DIR}`);

// ─── Shutdown ───────────────────────────────────────────────────────────────
const shutdown = async (signal) => {
  console.log(`[hidemyemail] Received ${signal}, shutting down…`);
  try {
    await new Promise((resolve) => server.close(resolve));
    await mf.dispose();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
