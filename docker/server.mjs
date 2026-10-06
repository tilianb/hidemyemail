// Miniflare host for hidemyemail.dev self-host containers.
//
// Loads the pre-bundled worker (built by `wrangler deploy --dry-run`) and wires
// up D1 + Assets bindings against local SQLite + dashboard static files. All
// secrets come from process.env so they can be supplied via docker-compose,
// `--env-file`, or your secrets manager of choice.

import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { Miniflare } from "miniflare";
import { WORKER_FIRST_ROUTES } from "./assets-routing.mjs";
import { trustedProxySet, workerHeaders } from "./client-ip.mjs";
import { applyMigrations } from "./migrations.mjs";
import { createSmtpTransportHandler } from "./smtp-transport.mjs";
import { createSmtpIngress } from "./smtp-ingress.mjs";
import { createBuiltinIngress } from "./builtin-ingress.mjs";
import { createMailQueue } from "./mail-queue.mjs";
import { createDirectMail } from "./direct-mail.mjs";
import { scanMail, clamScan } from "./mail-scanner.mjs";

const env = process.env;

// ─── Required config ────────────────────────────────────────────────────────
const REQUIRED_CONFIG = [
  "SESSION_SECRET",
  "AUTH_PASSWORD_HASH",
  "AUTH_PASSWORD_SALT",
  "DESTINATION_ENCRYPTION_KEY",
];
const ENV_MAIL_OUTBOUND_PROVIDER = (env.MAIL_OUTBOUND_PROVIDER ?? "ses").toLowerCase();
if (!["ses", "smtp", "direct"].includes(ENV_MAIL_OUTBOUND_PROVIDER)) {
  console.error("[hidemyemail] MAIL_OUTBOUND_PROVIDER must be ses, smtp, or direct");
  process.exit(1);
}
const missing = REQUIRED_CONFIG.filter((k) => !env[k]);
if (missing.length) {
  console.error(`[hidemyemail] Missing required env vars: ${missing.join(", ")}`);
  console.error(`[hidemyemail] See docker/.env.example for the full list.`);
  process.exit(1);
}
try {
  const encryptionKey = Buffer.from(env.DESTINATION_ENCRYPTION_KEY, "base64");
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(env.DESTINATION_ENCRYPTION_KEY)
    || encryptionKey.length !== 32
    || encryptionKey.toString("base64") !== env.DESTINATION_ENCRYPTION_KEY
  ) throw new Error();
} catch {
  console.error("[hidemyemail] Invalid encryption key configuration");
  process.exit(1);
}

const DATA_DIR = env.DATA_DIR ?? "/data";
const ASSETS_DIR = env.ASSETS_DIR ?? "/app/public";
const WORKER_SCRIPT = env.WORKER_SCRIPT ?? "/app/worker-dist/index.js";
const MIGRATIONS_DIR = env.MIGRATIONS_DIR ?? "/app/migrations";
const PORT = Number(env.PORT ?? 8787);
const HOST = env.HOST ?? "0.0.0.0";
const TRUSTED_PROXIES = trustedProxySet(env.TRUSTED_PROXY_IPS);
const SMTP_INGRESS_SECRET = randomBytes(32).toString("hex");
let smtpTransportHandler = async () => new Response("SMTP transport is not active", { status: 503 });
let mailRuntimeHandler = async () => Response.json({ available: false });

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
  serviceBindings: {
    SMTP_TRANSPORT: (request) => smtpTransportHandler(request),
    MAIL_RUNTIME: (request) => mailRuntimeHandler(request),
  },

  // Static SPA (dashboard/dist) — Workers Assets routing parity.
  // run_worker_first from wrangler.jsonc becomes:
  //   has_user_worker + static_routing.user_worker
  assets: {
    directory: ASSETS_DIR,
    binding: "ASSETS",
    routerConfig: {
      has_user_worker: true,
      static_routing: { user_worker: WORKER_FIRST_ROUTES },
    },
    assetConfig: {
      not_found_handling: "single-page-application",
      html_handling: "auto-trailing-slash",
    },
  },

  // Plain vars (non-secret, mirror wrangler.jsonc top-level vars block)
  bindings: {
    ENVIRONMENT: env.ENVIRONMENT ?? "self-hosted",
    MAIL_OUTBOUND_PROVIDER: ENV_MAIL_OUTBOUND_PROVIDER,
    MAIL_INBOUND_PROVIDER: env.MAIL_INBOUND_PROVIDER ?? "",
    MAIL_HOSTNAME: env.MAIL_HOSTNAME ?? "",
    INBOUND_MX_HOST: env.INBOUND_MX_HOST ?? "",
    OUTBOUND_SPF_INCLUDE: env.OUTBOUND_SPF_INCLUDE ?? "",
    SMTP_OUTBOUND_HOST: env.SMTP_OUTBOUND_HOST ?? "",
    SMTP_OUTBOUND_PORT: env.SMTP_OUTBOUND_PORT ?? "",
    SMTP_OUTBOUND_TLS: env.SMTP_OUTBOUND_TLS ?? "",
    SMTP_OUTBOUND_USERNAME: env.SMTP_OUTBOUND_USERNAME ?? "",
    SMTP_INBOUND_ENABLED: env.SMTP_INBOUND_ENABLED ?? "",
    SMTP_INBOUND_HOST: env.SMTP_INBOUND_HOST ?? "",
    SMTP_INBOUND_PORT: env.SMTP_INBOUND_PORT ?? "",
    SMTP_INBOUND_TLS: env.SMTP_INBOUND_TLS ?? "",
    SMTP_INBOUND_USERNAME: env.SMTP_INBOUND_USERNAME ?? "",
    SMTP_INBOUND_GATEWAY_ID: env.SMTP_INBOUND_GATEWAY_ID ?? "",
    SMTP_INBOUND_TRUSTED_PEERS: env.SMTP_INBOUND_TRUSTED_PEERS ?? "",
    SMTP_INBOUND_MAX_BYTES: env.SMTP_INBOUND_MAX_BYTES ?? "",
    BLOCKED_SUBDOMAINS: env.BLOCKED_SUBDOMAINS ?? "",
    APP_ORIGIN: env.APP_ORIGIN ?? "",
    ANDROID_APP_ORIGINS: env.ANDROID_APP_ORIGINS ?? "",
    SES_REGION: env.SES_REGION ?? "ap-southeast-2",
    S3_INBOUND_BUCKET: env.S3_INBOUND_BUCKET ?? "hidemyemail-inbound-raw",
    SNS_INBOUND_TOPIC_ARN: env.SNS_INBOUND_TOPIC_ARN ?? "",
    SNS_ALLOWED_TOPIC_ARN: env.SNS_ALLOWED_TOPIC_ARN ?? "",
    SMTP_INGRESS_SECRET,
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
    SES_ACCESS_KEY_ID: env.SES_ACCESS_KEY_ID ?? "",
    SES_SECRET_ACCESS_KEY: env.SES_SECRET_ACCESS_KEY ?? "",
    SMTP_OUTBOUND_PASSWORD: env.SMTP_OUTBOUND_PASSWORD ?? "",
    SMTP_INBOUND_PASSWORD: env.SMTP_INBOUND_PASSWORD ?? "",
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

const dispatchInternal = (operation, body) => mf.dispatchFetch(`http://internal/internal/${operation}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-hidemyemail-internal-secret": SMTP_INGRESS_SECRET },
  body: JSON.stringify(body),
});
const smtpConfigResponse = await dispatchInternal("smtp-config", {});
if (!smtpConfigResponse.ok) throw new Error("Unable to resolve SMTP configuration");
const effectiveSmtpEnv = { ...env, ...await smtpConfigResponse.json() };
const outboundProvider = effectiveSmtpEnv.MAIL_OUTBOUND_PROVIDER || "ses";
const inboundProvider = effectiveSmtpEnv.MAIL_INBOUND_PROVIDER
  || (effectiveSmtpEnv.SMTP_INBOUND_ENABLED === "true" ? "gateway" : "ses");
let queue;
let directMail;
if (inboundProvider === "builtin" || outboundProvider === "direct") {
  const domains = async () => {
    const response = await dispatchInternal("smtp-domains", {});
    if (!response.ok) throw new Error("Unable to resolve mail domains");
    return (await response.json()).domains;
  };
  if (outboundProvider === "direct") {
    directMail = await createDirectMail({
      directory: path.join(DATA_DIR, "mail-keys"), encryptionKey: env.DESTINATION_ENCRYPTION_KEY,
      hostname: effectiveSmtpEnv.MAIL_HOSTNAME, domains,
    });
  }
  queue = await createMailQueue({
    directory: path.join(DATA_DIR, "mail-queue"), encryptionKey: env.DESTINATION_ENCRYPTION_KEY,
    maxBytes: Number(env.MAIL_QUEUE_MAX_BYTES || 1024 ** 3),
    async process(kind, payload, id) {
      if (kind === "outbound") return directMail.deliver(payload);
      const raw = Buffer.from(payload.rawBase64, "base64");
      const auth = await scanMail(raw, payload, {
        rspamdUrl: env.RSPAMD_URL || "http://rspamd:11333/checkv2",
        hostname: effectiveSmtpEnv.MAIL_HOSTNAME,
        clam: message => clamScan(message, { host: env.CLAMAV_HOST || "clamav", port: Number(env.CLAMAV_PORT || 3310) }),
      });
      const response = await dispatchInternal("smtp-ingest", {
        gateway: `builtin-${effectiveSmtpEnv.MAIL_HOSTNAME}`, deliveryId: id,
        from: payload.from || `postmaster@${effectiveSmtpEnv.MAIL_HOSTNAME}`,
        to: payload.to, rawBase64: payload.rawBase64, auth,
      });
      if (!response.ok) throw Object.assign(new Error("Inbound processing failed"), { permanent: response.status < 500 });
    },
  });
  queue.start();
}
if (outboundProvider === "smtp") {
  smtpTransportHandler = createSmtpTransportHandler(effectiveSmtpEnv);
} else if (outboundProvider === "direct") {
  smtpTransportHandler = async request => {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    try {
      const prepared = await directMail.prepare(await request.json());
      const providerId = await queue.enqueue("outbound", prepared);
      return Response.json({ providerId }, { status: 202 });
    } catch (error) {
      if (error?.permanent) return new Response("Direct delivery rejected", { status: 400 });
      return new Response("Direct delivery queue unavailable", { status: 421 });
    }
  };
} else if (!effectiveSmtpEnv.SES_ACCESS_KEY_ID || !effectiveSmtpEnv.SES_SECRET_ACCESS_KEY) {
  throw new Error("SES outbound selected but SES credentials are not configured");
}
let smtpIngress;
if (inboundProvider === "gateway") smtpIngress = await createSmtpIngress(effectiveSmtpEnv, dispatchInternal);
if (inboundProvider === "builtin") {
  if (!effectiveSmtpEnv.MAIL_HOSTNAME) throw new Error("Built-in receiving requires MAIL_HOSTNAME");
  const builtinEnv = { ...effectiveSmtpEnv };
  if (builtinEnv.SMTP_INBOUND_TLS_CERT) {
    builtinEnv.SMTP_INBOUND_TLS_CERT_CONTENT = await readFile(builtinEnv.SMTP_INBOUND_TLS_CERT);
    builtinEnv.SMTP_INBOUND_TLS_KEY_CONTENT = await readFile(builtinEnv.SMTP_INBOUND_TLS_KEY);
  }
  smtpIngress = await createBuiltinIngress(builtinEnv, dispatchInternal, queue);
}
if (smtpIngress) {
  await new Promise((resolve, reject) => {
    smtpIngress.server.once("error", reject);
    smtpIngress.server.listen(smtpIngress.port, smtpIngress.host, resolve);
  });
}
mailRuntimeHandler = async request => {
  if (new URL(request.url).pathname !== "/status") return new Response("Not found", { status: 404 });
  const scanners = { spam: false, virus: false };
  if (inboundProvider === "builtin") {
    scanners.spam = await fetch(env.RSPAMD_URL?.replace(/\/checkv2$/, "/ping") || "http://rspamd:11333/ping", { signal: AbortSignal.timeout(2000) }).then(response => response.ok).catch(() => false);
    scanners.virus = await clamScan(Buffer.alloc(0), { host: env.CLAMAV_HOST || "clamav", port: Number(env.CLAMAV_PORT || 3310), timeout: 2000 }).then(() => true).catch(() => false);
  }
  return Response.json({
    available: true, receiving: inboundProvider, outbound: outboundProvider,
    hostname: effectiveSmtpEnv.MAIL_HOSTNAME || "", queue: queue ? await queue.status() : { inbound: 0, outbound: 0, failed: 0, oldestPendingAt: null },
    scanners, dkim: directMail ? await directMail.records() : [],
  });
};

// Terminate HTTP outside workerd so the socket peer is authoritative. Caller
// forwarding headers are stripped before every request enters the Worker.
const server = createServer(async (request, response) => {
  try {
    if ((request.url ?? "").startsWith("/internal/")) {
      response.writeHead(404).end("Not found");
      return;
    }
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
if (smtpIngress) console.log(`[hidemyemail] SMTP ingress listening on ${smtpIngress.host}:${smtpIngress.port}`);

// ─── Shutdown ───────────────────────────────────────────────────────────────
const shutdown = async (signal) => {
  console.log(`[hidemyemail] Received ${signal}, shutting down…`);
  try {
    await new Promise((resolve) => server.close(resolve));
    if (smtpIngress) await new Promise((resolve) => smtpIngress.server.close(resolve));
    if (queue) await queue.stop();
    await mf.dispose();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
