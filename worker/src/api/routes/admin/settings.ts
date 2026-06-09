import type { Hono } from "hono";
import type { AppEnv } from "../../app";
import { VALID_SETTING_KEYS } from "../../../config";
import { encryptDestination } from "../../../lib/crypto";
import { getAllSettings } from "../../../lib/settings";
import { maskSecret, normalizeDomain } from "./helpers";

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
    if (settings.ses_secret_access_key?.value) {
      settings.ses_secret_access_key.value = maskSecret(settings.ses_secret_access_key.value);
    }
    return c.json({ settings });
  });

  r.patch("/settings", async (c) => {
    const body = await c.req.json<Record<string, string>>().catch(() => ({}));
    const db = c.env.DB;
    const now = Date.now();

    const errors: string[] = [];
    const updates: { key: string; value: string }[] = [];

    for (const [key, value] of Object.entries(body)) {
      if (!VALID_SETTING_KEYS.includes(key)) {
        errors.push(`Unknown setting: ${key}`);
        continue;
      }

      // Ignore masked secrets that weren't changed by the user
      if (key === "ses_secret_access_key" && value.includes("••••••")) {
        continue;
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

    if (errors.length > 0) {
      return c.json({ error: errors.join("; ") }, 400);
    }

    for (let { key, value } of updates) {
      if (value && key === "ses_secret_access_key") {
        value = await encryptDestination(value, c.env.DESTINATION_ENCRYPTION_KEY);
      }
      await db.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(key, value, now).run();
    }

    return c.json({ ok: true, updated: updates.length });
  });
}
