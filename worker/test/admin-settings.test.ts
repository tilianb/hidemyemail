import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { signFreshAuth, signSession } from "../src/lib/auth";
import { resetDb } from "./helpers";
import { getEnvWithOverride, getMailDnsTargets, mxRecordMatches, spfRecordHasMechanism, spfRecordIncludes } from "../src/lib/settings";
import {
  ENCRYPTED_SETTING_KEYS,
  FRESH_AUTH_SETTING_KEYS,
  MAIL_SETTING_KEYS,
  MASKED_SETTING_KEYS,
  SETTING_DEFAULTS,
  SETTING_DEFINITIONS,
  VALID_SETTING_KEYS,
} from "../src/config";

let cookie: string;
let freshCookie: string;
let testEnv: any;

beforeAll(async () => {
  testEnv = { ...env, SESSION_SECRET: "settings-schema-secret" };
  cookie = `__Host-session=${await signSession(testEnv.SESSION_SECRET, 1, 3600)}`;
  freshCookie = `${cookie}; __Host-fresh-auth=${await signFreshAuth(testEnv.SESSION_SECRET, 1, 300)}`;
});

beforeEach(async () => {
  await resetDb(env.DB as D1Database);
  await env.DB.prepare("DELETE FROM settings WHERE key IN ('mail_inbound_provider','mail_outbound_provider','mail_hostname')").run();
});

test.each(["builtin", "direct"])("requires Docker runtime and canonical hostname for %s", async (mode) => {
  const body = mode === "builtin" ? { mail_inbound_provider: mode } : { mail_outbound_provider: mode };
  const patch = (values: object, overrides = {}) => createApp().request("/api/admin/settings", {
    method: "PATCH", headers: { cookie: freshCookie, "content-type": "application/json" }, body: JSON.stringify(values),
  }, { ...testEnv, ...overrides });
  expect((await patch({ ...body, mail_hostname: "mail.example.com" })).status).toBe(400);
  const bindings = { MAIL_RUNTIME: {}, SMTP_TRANSPORT: {} };
  expect((await patch(body, bindings)).status).toBe(400);
  expect((await patch({ ...body, mail_hostname: "MAIL.example.com" }, bindings)).status).toBe(400);
  expect((await patch({ ...body, mail_hostname: "mail.example.com" }, bindings)).status).toBe(200);
});

test("runtime status reports unavailable, fences errors, and strips extra fields", async () => {
  const get = (overrides = {}) => createApp().request("/api/admin/mail-runtime", { headers: { cookie } }, { ...testEnv, ...overrides });
  expect(await (await get()).json()).toEqual({ available: false });
  expect((await get({ MAIL_RUNTIME: { fetch: async () => { throw new Error("private contents"); } } })).status).toBe(503);
  const status = { available: true, receiving: "builtin", outbound: "direct", hostname: "mail.example.com", queue: { inbound: 1, outbound: 2, failed: 3, oldestPendingAt: null }, scanners: { spam: true, virus: false }, dkim: [{ domain: "example.com", name: "mail._domainkey.example.com", value: "v=DKIM1; p=public" }] };
  const response = await get({ MAIL_RUNTIME: { fetch: async () => Response.json({ ...status, privateKey: "secret", recipients: ["private@example.com"] }) } });
  expect(await response.json()).toEqual(status);
});

test.each([
  ["malformed JSON", "{"],
  ["null", "null"],
  ["an array", "[]"],
  ["non-string values", JSON.stringify({ rate_limit_global: 42 })],
])("rejects settings payload containing %s", async (_label, body) => {
  const response = await createApp().request("/api/admin/settings", {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body,
  }, testEnv);

  expect(response.status).toBe(400);
});

test("DNS verification matches provider targets exactly", () => {
  expect(mxRecordMatches("10 mx.gateway.example.", "mx.gateway.example")).toBe(true);
  expect(mxRecordMatches("10 mx.gateway.example.evil.", "mx.gateway.example")).toBe(false);
  expect(spfRecordIncludes("v=spf1 include:spf.provider.example -all", "spf.provider.example")).toBe(true);
  expect(spfRecordIncludes("v=spf1 include:spf.provider.example.evil -all", "spf.provider.example")).toBe(false);
  expect(spfRecordHasMechanism("v=spf1 a:mail.example.com ~all", "a:mail.example.com")).toBe(true);
  expect(spfRecordHasMechanism("v=spf1 a:mail.example.com.evil ~all", "a:mail.example.com")).toBe(false);
});

test("built-in receiving and direct sending derive usable DNS records from the mail hostname", async () => {
  const db = env.DB as D1Database;
  for (const [key, value] of [
    ["mail_inbound_provider", "builtin"], ["mail_outbound_provider", "direct"],
    ["mail_hostname", "mail.example.com"], ["inbound_mx_host", "stale.gateway.example"],
    ["outbound_spf_include", "stale.provider.example"],
  ]) {
    await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=1")
      .bind(key, value).run();
  }
  expect(await getMailDnsTargets(db, testEnv)).toEqual({
    inboundMxHost: "mail.example.com",
    outboundSpfMechanism: "a:mail.example.com",
  });
});

test.each(["invented_setting", "constructor", "toString"])("reports unknown setting %s without writing it", async (key) => {
  const response = await createApp().request("/api/admin/settings", {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ [key]: "value" }),
  }, testEnv);

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: `Unknown setting: ${key}` });
  expect(await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first()).toBeNull();
});

test("derives defaults and security classifications from canonical definitions", () => {
  expect(Object.keys(SETTING_DEFAULTS)).toEqual(VALID_SETTING_KEYS);
  for (const key of VALID_SETTING_KEYS) {
    expect(SETTING_DEFAULTS[key]).toBe(SETTING_DEFINITIONS[key].default);
  }
  expect(MAIL_SETTING_KEYS).toContain("smtp_outbound_password");
  expect(ENCRYPTED_SETTING_KEYS).toEqual(new Set([
    "ses_secret_access_key", "smtp_outbound_username", "smtp_outbound_password",
    "smtp_inbound_username", "smtp_inbound_password",
  ]));
  expect(MASKED_SETTING_KEYS).toEqual(new Set([
    "ses_access_key_id", "ses_secret_access_key", "smtp_outbound_username", "smtp_outbound_password",
    "smtp_inbound_username", "smtp_inbound_password",
  ]));
  expect(FRESH_AUTH_SETTING_KEYS).toEqual(new Set(MAIL_SETTING_KEYS));
  expect(SETTING_DEFAULTS.smtp_outbound_host).toBe("");
  expect(SETTING_DEFAULTS.smtp_inbound_host).toBe("");
  expect(SETTING_DEFINITIONS.inbound_mx_host.env).toBe("INBOUND_MX_HOST");
  expect(SETTING_DEFINITIONS.outbound_spf_include.env).toBe("OUTBOUND_SPF_INCLUDE");
  expect(SETTING_DEFAULTS.inbound_mx_host).toBe("");
  expect(SETTING_DEFAULTS.outbound_spf_include).toBe("");
});

test.each([
  ["inbound_mx_host", "MX.EXAMPLE.COM"],
  ["inbound_mx_host", "mx.example.com."],
  ["inbound_mx_host", "evil..example.com"],
  ["outbound_spf_include", "include:spf.example.com"],
  ["outbound_spf_include", "https://spf.example.com"],
])("rejects non-canonical DNS setting %s=%s", async (key, value) => {
  const response = await createApp().request("/api/admin/settings", {
    method: "PATCH",
    headers: { cookie: freshCookie, "content-type": "application/json" },
    body: JSON.stringify({ [key]: value }),
  }, testEnv);

  expect(response.status).toBe(400);
});

test("treats updated_at zero as a seed and preserves legacy integer parsing", async () => {
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = 0",
  ).bind("smtp_outbound_port", "25").run();
  expect(await getEnvWithOverride(env.DB as D1Database, { SMTP_OUTBOUND_PORT: "587" }, "smtp_outbound_port"))
    .toBe("587");

  const response = await createApp().request("/api/admin/settings", {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ rate_limit_global: "10requests" }),
  }, testEnv);
  expect(response.status).toBe(200);
  expect(await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind("rate_limit_global").first<{ value: string }>())
    .toEqual({ value: "10requests" });
});
