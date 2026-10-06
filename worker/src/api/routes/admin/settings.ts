import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "../../app";
import {
  ENCRYPTED_SETTING_KEYS,
  FRESH_AUTH_SETTING_KEYS,
  MAIL_SETTING_KEYS,
  MASKED_SETTING_KEYS,
  SETTING_DEFINITIONS,
  type SettingDefinition,
  type SettingKey,
} from "../../../config";
import { encryptDestination } from "../../../lib/crypto";
import { getAllSettings, getEnvWithOverride } from "../../../lib/settings";
import { maskSecret, normalizeDomain } from "./helpers";
import { freshAuthRequired, hasFreshAuth } from "../../auth-helpers";

const settingsPatchSchema = z.record(z.string(), z.union([z.string(), z.null()]));
const mailSettings = new Set<string>(MAIL_SETTING_KEYS);
const freshAuthSettings = new Set<string>(FRESH_AUTH_SETTING_KEYS);
const definitionFor = (key: SettingKey): SettingDefinition => SETTING_DEFINITIONS[key];
const runtimeStatusSchema = z.object({
  available: z.literal(true),
  receiving: z.enum(["ses", "builtin", "gateway"]),
  outbound: z.enum(["ses", "smtp", "direct"]),
  hostname: z.string(),
  queue: z.object({ inbound: z.number().int().nonnegative(), outbound: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), oldestPendingAt: z.number().nullable() }),
  scanners: z.object({ spam: z.boolean(), virus: z.boolean() }),
  dkim: z.array(z.object({ domain: z.string(), name: z.string(), value: z.string() })),
});
const envValue = (env: AppEnv["Bindings"], key: SettingKey): string => {
  const name = definitionFor(key).env;
  return name ? (env as unknown as Record<string, string | undefined>)[name] ?? "" : "";
};

export function registerAdminSettingsRoutes(r: Hono<AppEnv>) {
  r.get("/mail-runtime", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!c.env.MAIL_RUNTIME) return c.json({ available: false });
    try {
      const response = await c.env.MAIL_RUNTIME.fetch("http://mail.runtime/status");
      if (!response.ok) throw new Error("Runtime unavailable");
      // Explicit allowlist strips runtime-only fields at every level.
      return c.json(runtimeStatusSchema.parse(await response.json()));
    } catch {
      return c.json({ error: "Mail runtime status unavailable. Retry after checking Docker.", retryable: true }, 503);
    }
  });

  // ── Environment Variables (read-only) ──────────────────────────────────────
  r.get("/env", async (c) => {
    const env = c.env;

    // Non-secret vars: expose full value
    const vars: Record<string, { value: string; secret: false }> = {
      ENVIRONMENT: { value: env.ENVIRONMENT || "", secret: false },
      SES_REGION: { value: env.SES_REGION || "", secret: false },
      S3_INBOUND_BUCKET: { value: env.S3_INBOUND_BUCKET || "", secret: false },
    };

    // Secrets: only expose configured status + masked preview
    const secretKeys = [
      "SES_ACCESS_KEY_ID",
      "SES_SECRET_ACCESS_KEY",
      "SESSION_SECRET",
      "AUTH_PASSWORD_HASH",
      "AUTH_PASSWORD_SALT",
      "DESTINATION_ENCRYPTION_KEY",
      "SNS_ALLOWED_TOPIC_ARN",
      "SNS_INBOUND_TOPIC_ARN",
    ] as const;

    const secrets: Record<string, { configured: boolean; preview?: string }> = {};
    for (const key of secretKeys) {
      const val = (env as any)[key] as string | undefined;
      const configured = !!val && val.length > 0;
      secrets[key] = { configured };
      // Show masked preview for AWS/ARN-related keys only (less sensitive to preview)
      if (configured && (key.startsWith("SES_") || key.startsWith("SNS_"))) {
        secrets[key].preview = maskSecret(val!);
      }
    }

    return c.json({ vars, secrets });
  });

  // ── Runtime Settings (DB-backed, editable) ─────────────────────────────────
  r.get("/settings", async (c) => {
    const settings = await getAllSettings(c.env.DB, c.env);
    // Mask sensitive secrets so they don't leak to the frontend UI
    for (const key of MAIL_SETTING_KEYS) {
      if (MASKED_SETTING_KEYS.has(key)) continue;
      const overridden = (settings[key]?.updated_at ?? 0) > 0;
      const inherited = envValue(c.env, key);
      settings[key] = {
        value: overridden ? settings[key]?.value ?? "" : inherited || settings[key]?.value || "",
        updated_at: settings[key]?.updated_at ?? 0,
        source: overridden ? "override" : inherited ? "environment" : "default",
      } as any;
    }
    for (const key of MASKED_SETTING_KEYS) {
      const envConfigured = !!envValue(c.env, key);
      const overridden = (settings[key]?.updated_at ?? 0) > 0;
      const configured = overridden ? !!settings[key]?.value : envConfigured;
      settings[key] = {
        value: configured ? "•••••• configured" : "",
        updated_at: settings[key]?.updated_at ?? 0,
        source: overridden ? "override" : envConfigured ? "environment" : "default",
      } as any;
    }
    return c.json({ settings });
  });

  r.patch("/settings", zValidator("json", settingsPatchSchema, (result, c) => {
    if (!result.success) return c.json({ error: "Invalid settings payload" }, 400);
  }), async (c) => {
    const body = c.req.valid("json");
    const db = c.env.DB;
    const now = Date.now();

    const errors: string[] = [];
    const updates: { key: string; value: string }[] = [];
    const resets: string[] = [];

    if (Object.keys(body).some((key) => freshAuthSettings.has(key)) && !(await hasFreshAuth(c))) {
      return freshAuthRequired(c);
    }

    for (const [key, value] of Object.entries(body)) {
      if (!Object.hasOwn(SETTING_DEFINITIONS, key)) {
        errors.push(`Unknown setting: ${key}`);
        continue;
      }
      if (value === null) {
        resets.push(key);
        continue;
      }

      // Ignore masked secrets that weren't changed by the user
      const settingKey = key as SettingKey;
      if (MASKED_SETTING_KEYS.has(settingKey) && value.includes("••••••")) {
        continue;
      }
      const validationError = definitionFor(settingKey).validate?.(value);
      if (validationError) {
        errors.push(`${key}: ${validationError}`);
        continue;
      }

      if (key === "main_global_domain") {
        const normalizedDomain = normalizeDomain(value);
        if (!normalizedDomain) {
          errors.push(`${key}: invalid domain`);
          continue;
        }
        const domain = await db.prepare("SELECT id FROM domains WHERE domain = ? AND is_global = 1 AND active = 1 AND verified_at IS NOT NULL")
          .bind(normalizedDomain).first<{ id: number }>();
        if (!domain) {
          errors.push(`${key}: must be an active verified global domain`);
          continue;
        }
        updates.push({ key, value: normalizedDomain });
        continue;
      }

      updates.push({ key, value });
    }

    const proposed: Record<string, string> = {};
    for (const key of MAIL_SETTING_KEYS) {
      const supplied = body[key];
      if (supplied === null) proposed[key] = envValue(c.env, key);
      else if (typeof supplied === "string" && !supplied.includes("••••••")) proposed[key] = supplied;
      else proposed[key] = await getEnvWithOverride(db, c.env, key);
    }
    const mailConfigurationChanged = Object.keys(body).some((key) => mailSettings.has(key));
    if (mailConfigurationChanged && (proposed.mail_outbound_provider || "ses") === "smtp") {
      if (Object.hasOwn(body, "mail_outbound_provider") && !c.env.SMTP_TRANSPORT) {
        errors.push("Custom SMTP requires the Docker SMTP_TRANSPORT binding");
      }
      if (!proposed.smtp_outbound_host || !proposed.smtp_outbound_port || !proposed.smtp_outbound_tls) errors.push("Custom SMTP requires host, port, and TLS mode");
      if (!!proposed.smtp_outbound_username !== !!proposed.smtp_outbound_password) errors.push("SMTP outbound username and password must be configured together");
      if (proposed.smtp_outbound_tls === "trusted-cleartext" && proposed.smtp_outbound_port !== "25") errors.push("Trusted cleartext SMTP is restricted to port 25");
    }
    const receiving = proposed.mail_inbound_provider || (proposed.smtp_inbound_enabled === "true" ? "gateway" : "ses");
    if (mailConfigurationChanged && (receiving === "builtin" || proposed.mail_outbound_provider === "direct")) {
      if (!c.env.MAIL_RUNTIME) errors.push("Built-in receiving and direct sending require the Docker-only MAIL_RUNTIME binding");
      if (!proposed.mail_hostname || SETTING_DEFINITIONS.mail_hostname.validate?.(proposed.mail_hostname)) errors.push("Built-in receiving and direct sending require a canonical mail_hostname");
      if (proposed.mail_outbound_provider === "direct" && !c.env.SMTP_TRANSPORT) errors.push("Direct sending requires the Docker SMTP_TRANSPORT binding");
    }
    if (mailConfigurationChanged && receiving === "gateway") {
      for (const key of ["smtp_inbound_host", "smtp_inbound_port", "smtp_inbound_tls", "smtp_inbound_username", "smtp_inbound_password", "smtp_inbound_gateway_id"]) {
        if (!proposed[key]) errors.push(`SMTP receiving requires ${key}`);
      }
      const local = ["127.0.0.1", "::1", "localhost"].includes(proposed.smtp_inbound_host ?? "");
      if (!local && (!c.env.SMTP_INBOUND_TLS_CERT || !c.env.SMTP_INBOUND_TLS_KEY)) {
        errors.push("Nonlocal SMTP receiving requires deployment-managed TLS certificate and key paths");
      }
    }

    if (errors.length > 0) {
      return c.json({ error: errors.join("; ") }, 400);
    }

    for (let { key, value } of updates) {
      if (value && ENCRYPTED_SETTING_KEYS.has(key as SettingKey)) {
        value = await encryptDestination(value, c.env.DESTINATION_ENCRYPTION_KEY);
      }
      await db.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(key, value, now).run();
    }

    for (const key of resets) await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();

    return c.json({ ok: true, updated: updates.length, reset: resets.length, restart_required: [...updates, ...resets.map((key) => ({ key, value: "" }))].some(({ key }) => mailSettings.has(key)) });
  });
}
