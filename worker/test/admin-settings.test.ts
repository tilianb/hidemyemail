import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { signSession } from "../src/lib/auth";
import { resetDb } from "./helpers";
import { getEnvWithOverride } from "../src/lib/settings";
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
let testEnv: any;

beforeAll(async () => {
  testEnv = { ...env, SESSION_SECRET: "settings-schema-secret" };
  cookie = `__Host-session=${await signSession(testEnv.SESSION_SECRET, 1, 3600)}`;
});

beforeEach(async () => resetDb(env.DB as D1Database));

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
