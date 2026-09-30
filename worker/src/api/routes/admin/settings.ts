import type { Hono } from "hono";
import type { AppEnv } from "../../app";
import { VALID_SETTING_KEYS } from "../../../config";
import { encryptDestination } from "../../../lib/crypto";
import { getAllSettings, getEnvWithOverride } from "../../../lib/settings";
import { maskSecret, normalizeDomain } from "./helpers";
import { freshAuthRequired, hasFreshAuth } from "../../auth-helpers";

const MAIL_SETTINGS = new Set([
  "ses_region", "ses_access_key_id", "ses_secret_access_key",
  "mail_outbound_provider", "smtp_outbound_host", "smtp_outbound_port", "smtp_outbound_tls",
  "smtp_outbound_username", "smtp_outbound_password", "smtp_inbound_enabled", "smtp_inbound_host",
  "smtp_inbound_port", "smtp_inbound_tls", "smtp_inbound_username", "smtp_inbound_password",
  "smtp_inbound_gateway_id", "smtp_inbound_trusted_peers", "smtp_inbound_max_bytes",
]);
const MAIL_SECRETS = new Set(["smtp_outbound_username", "smtp_outbound_password", "smtp_inbound_username", "smtp_inbound_password"]);
const ENCRYPTED_SECRETS = new Set(["ses_secret_access_key", ...MAIL_SECRETS]);
const MASKED_MAIL_SETTINGS = new Set(["ses_access_key_id", "ses_secret_access_key", ...MAIL_SECRETS]);

export function registerAdminSettingsRoutes(r: Hono<AppEnv>) {
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
    for (const key of MAIL_SETTINGS) {
      if (MASKED_MAIL_SETTINGS.has(key)) continue;
      const overridden = (settings[key]?.updated_at ?? 0) > 0;
      const envValue = (c.env as any)[key.toUpperCase()] as string | undefined;
      settings[key] = {
        value: overridden ? settings[key]?.value ?? "" : envValue || settings[key]?.value || "",
        updated_at: settings[key]?.updated_at ?? 0,
        source: overridden ? "override" : envValue ? "environment" : "default",
      } as any;
    }
    for (const key of MASKED_MAIL_SETTINGS) {
      const envConfigured = !!(c.env as any)[key.toUpperCase()];
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

  r.patch("/settings", async (c) => {
    const body: Record<string, string | null> = await c.req.json<Record<string, string | null>>()
      .catch((): Record<string, string | null> => ({}));
    const db = c.env.DB;
    const now = Date.now();

    const errors: string[] = [];
    const updates: { key: string; value: string }[] = [];
    const resets: string[] = [];

    if (Object.keys(body).some((key) => MAIL_SETTINGS.has(key)) && !(await hasFreshAuth(c))) {
      return freshAuthRequired(c);
    }

    for (const [key, value] of Object.entries(body)) {
      if (!VALID_SETTING_KEYS.includes(key)) {
        errors.push(`Unknown setting: ${key}`);
        continue;
      }
      if (value === null) {
        resets.push(key);
        continue;
      }

      // Ignore masked secrets that weren't changed by the user
      if (MASKED_MAIL_SETTINGS.has(key) && value.includes("••••••")) {
        continue;
      }

      if (key === "mail_outbound_provider" && !["", "ses", "smtp"].includes(value)) errors.push(`${key}: must be ses or smtp`);
      if ((key === "smtp_outbound_tls" && !["", "implicit", "starttls", "trusted-cleartext"].includes(value))
        || (key === "smtp_inbound_tls" && !["", "implicit", "starttls"].includes(value))) errors.push(`${key}: invalid TLS mode`);
      if (key === "smtp_inbound_enabled" && !["", "true", "false"].includes(value)) errors.push(`${key}: must be true or false`);
      if (["smtp_outbound_port", "smtp_inbound_port"].includes(key) && value !== "") {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`${key}: must be a port from 1 to 65535`);
      }
      if (key === "smtp_inbound_trusted_peers" && value && value.split(",").some((peer) => !/^[0-9a-f:.]+$/i.test(peer.trim()))) {
        errors.push(`${key}: use comma-separated exact IP addresses`);
      }
      if (["smtp_outbound_host", "smtp_inbound_host", "smtp_outbound_username", "smtp_inbound_username", "smtp_inbound_gateway_id"].includes(key)
        && /[\r\n]/.test(value)) errors.push(`${key}: must not contain line breaks`);
      if (key === "smtp_inbound_gateway_id" && value && !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) errors.push(`${key}: invalid gateway id`);
      if (key === "smtp_inbound_max_bytes" && value !== "") {
        const bytes = Number(value);
        if (!Number.isInteger(bytes) || bytes < 1024) errors.push(`${key}: must be at least 1024`);
      }

      if (key === "rate_limit_per_alias" || key === "rate_limit_reply_per_alias" || key === "rate_limit_global" || key === "reply_distinct_recipient_cap") {
        const n = parseInt(value, 10);
        if (isNaN(n) || n < -1) {
          errors.push(`${key}: must be a number greater than or equal to -1`);
          continue;
        }
      }

      if (key === "soft_bounce_threshold") {
        const n = parseInt(value, 10);
        if (isNaN(n) || n < 0) {
          errors.push(`${key}: must be a number greater than or equal to 0`);
          continue;
        }
      }

      if (key === "spam_verdict_action" || key === "virus_verdict_action") {
        if (value !== "forward" && value !== "flag" && value !== "drop") {
          errors.push(`${key}: must be "forward", "flag", or "drop"`);
          continue;
        }
      }

      if (key === "unsubscribe_header_mode") {
        if (value !== "always" && value !== "bulk_only" && value !== "never") {
          errors.push(`${key}: must be "always", "bulk_only", or "never"`);
          continue;
        }
      }

      if (key === "max_total_aliases" || key === "max_subdomains") {
        const n = parseInt(value, 10);
        if (isNaN(n) || n < -1) {
          errors.push(`${key}: must be a number greater than or equal to -1`);
          continue;
        }
      }

      if (key === "max_inbound_bytes") {
        const n = parseInt(value, 10);
        if (isNaN(n) || n < 1024) {
          errors.push(`${key}: must be at least 1024 (1KB)`);
          continue;
        }
      }

      if (key === "catch_all_auto_create" || key === "registration_enabled" || key === "alias_quota_buffer_enabled") {
        if (value !== "true" && value !== "false") {
          errors.push(`${key}: must be "true" or "false"`);
          continue;
        }
      }

      if (key === "forwarded_from_format") {
        const allowed = new Set([
          "name_address_parens",
          "name_address_parens_at",
          "name_address_dash",
          "name_address_dash_at",
          "name_only",
          "address_only",
          "address_only_at",
          "via_hidemyemail",
        ]);
        if (!allowed.has(value)) {
          errors.push(`${key}: invalid format`);
          continue;
        }
      }

      if (key === "cors_allowed_domains") {
        if (!value || value.trim().length === 0) {
          errors.push(`${key}: cannot be empty`);
          continue;
        }
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
    for (const key of MAIL_SETTINGS) {
      const supplied = body[key];
      if (supplied === null) proposed[key] = (c.env as any)[key.toUpperCase()] || "";
      else if (typeof supplied === "string" && !supplied.includes("••••••")) proposed[key] = supplied;
      else proposed[key] = await getEnvWithOverride(db, c.env, key);
    }
    if ((proposed.mail_outbound_provider || "ses") === "smtp") {
      if (!proposed.smtp_outbound_host || !proposed.smtp_outbound_port || !proposed.smtp_outbound_tls) errors.push("Custom SMTP requires host, port, and TLS mode");
      if (!!proposed.smtp_outbound_username !== !!proposed.smtp_outbound_password) errors.push("SMTP outbound username and password must be configured together");
      if (proposed.smtp_outbound_tls === "trusted-cleartext" && proposed.smtp_outbound_port !== "25") errors.push("Trusted cleartext SMTP is restricted to port 25");
    }
    if (proposed.smtp_inbound_enabled === "true") {
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
      if (value && ENCRYPTED_SECRETS.has(key)) {
        value = await encryptDestination(value, c.env.DESTINATION_ENCRYPTION_KEY);
      }
      await db.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(key, value, now).run();
    }

    for (const key of resets) await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();

    return c.json({ ok: true, updated: updates.length, reset: resets.length, restart_required: [...updates, ...resets.map((key) => ({ key, value: "" }))].some(({ key }) => MAIL_SETTINGS.has(key)) });
  });
}
