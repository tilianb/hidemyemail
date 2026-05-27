import { Hono } from "hono";
import type { AppEnv } from "../app";
import { getAllSettings, getEnvWithOverride, getMainGlobalDomain } from "../../lib/settings";
import { encryptDestination } from "../../lib/crypto";
import { VALID_SETTING_KEYS, SETTING_DEFAULTS } from "../../config";

/** Mask a secret: show first 3 + "•••" + last 3, or just "•••" if too short */
function maskSecret(val: string): string {
  if (val.length <= 8) return "•••";
  return `${val.slice(0, 3)}•••${val.slice(-3)}`;
}

function normalizeDomain(input: string): string | null {
  const domain = input.trim().toLowerCase();
  if (!domain || domain.length > 253 || !domain.includes(".")) return null;
  if (/[\s\r\n/:]/.test(domain)) return null;
  const labels = domain.split(".");
  if (labels.some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-") || !/^[a-z0-9-]+$/.test(label))) {
    return null;
  }
  return domain;
}

export function adminRoutes() {
  const r = new Hono<AppEnv>();

  // Middleware to ensure user is admin
  r.use("*", async (c, next) => {
    const userId = c.get("userId");
    if (userId !== 1) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });

  // System-wide stats
  r.get("/stats", async (c) => {
    const db = c.env.DB;
    const since = Date.now() - 24 * 3600_000;
    
    const users = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    const aliases = await db.prepare("SELECT COUNT(*) AS n FROM aliases").first<{ n: number }>();
    const active = await db.prepare("SELECT COUNT(*) AS n FROM aliases WHERE active=1").first<{ n: number }>();
    
    const byType = await db.prepare(
      "SELECT type, COUNT(*) AS n FROM events WHERE ts>=? GROUP BY type"
    ).bind(since).all<{ type: string; n: number }>();
    
    const last24h: Record<string, number> = { forward: 0, reply: 0, block: 0, reject: 0, error: 0 };
    for (const row of byType.results ?? []) last24h[row.type] = row.n;
    
    return c.json({ 
      totals: { 
        users: users?.n ?? 0,
        aliases: aliases?.n ?? 0, 
        active: active?.n ?? 0 
      }, 
      last24h 
    });
  });

  // List users
  r.get("/users", async (c) => {
    const db = c.env.DB;
    const users = await db.prepare(`
      SELECT 
        u.id, 
        u.created_at,
        u.active,
        u.forwarding,
        u.name,
        (SELECT COUNT(*) FROM aliases a WHERE a.user_id = u.id) as alias_count
      FROM users u
      ORDER BY u.id ASC
    `).all();
    
    return c.json({ users: users.results ?? [] });
  });

  // Update user
  r.patch("/users/:id", async (c) => {
    const db = c.env.DB;
    const id = parseInt(c.req.param("id"));
    if (isNaN(id) || id === 1) return c.json({ error: "invalid id" }, 400);

    const { active, forwarding, name } = await c.req.json<{ active?: number, forwarding?: number, name?: string }>().catch(() => ({} as any));
    
    const updates: string[] = [];
    const values: any[] = [];
    if (active !== undefined) { updates.push("active = ?"); values.push(active ? 1 : 0); }
    if (forwarding !== undefined) { updates.push("forwarding = ?"); values.push(forwarding ? 1 : 0); }
    if (name !== undefined) { updates.push("name = ?"); values.push(name || null); }

    if (updates.length > 0) {
      values.push(id);
      await db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
    }
    
    return c.json({ ok: true });
  });

  // Generate Recovery Token
  r.post("/users/:id/recovery", async (c) => {
    const db = c.env.DB;
    const id = parseInt(c.req.param("id"));
    if (isNaN(id) || id === 1) return c.json({ error: "invalid id" }, 400);

    const { sendEmail } = await c.req.json<{ sendEmail?: boolean }>().catch(() => ({} as any));

    const token = crypto.randomUUID();
    const expiresAt = Date.now() + 24 * 3600 * 1000; // 24 hours

    await db.prepare("UPDATE users SET recovery_token = ?, recovery_expires_at = ? WHERE id = ?").bind(token, expiresAt, id).run();

    if (sendEmail) {
      const { decryptDestination } = await import("../../lib/crypto");
      const { sendRaw } = await import("../../lib/ses");
      const { buildRecoveryEmail } = await import("../../lib/emails");
      
      const dest = await db.prepare("SELECT email FROM destinations WHERE user_id = ? AND is_default = 1").bind(id).first<{ email: string }>();
      if (!dest) return c.json({ error: "user has no default destination email" }, 400);

      const email = await decryptDestination(dest.email, c.env.DESTINATION_ENCRYPTION_KEY);
      const url = `${new URL(c.req.url).origin}/recover?token=${token}`;
      // rawBase64 will be built in the sendRaw block with mainGlobalDomain

      const sesAccessKeyId = await getEnvWithOverride(db, c.env, "ses_access_key_id");
      const sesSecretAccessKey = await getEnvWithOverride(db, c.env, "ses_secret_access_key");
      const sesRegion = await getEnvWithOverride(db, c.env, "ses_region");

      if (sesAccessKeyId && sesSecretAccessKey && sesRegion) {
        const mainGlobalDomain = await getMainGlobalDomain(db, c.env);
        await sendRaw({
          accessKeyId: sesAccessKeyId,
          secretAccessKey: sesSecretAccessKey,
          region: sesRegion
        }, {
          from: `HideMyEmail <noreply@${mainGlobalDomain}>`,
          to: email,
          rawBase64: buildRecoveryEmail(email, url, mainGlobalDomain)
        });
      }
      return c.json({ ok: true });
    }

    return c.json({ token });
  });

  // Delete user (cascade delete is assumed in DB schema or logic)
  r.delete("/users/:id", async (c) => {
    const db = c.env.DB;
    const id = parseInt(c.req.param("id"));
    if (isNaN(id) || id === 1) return c.json({ error: "invalid id" }, 400);

    // D1 does not currently support foreign key ON DELETE CASCADE completely in all modes,
    // but the project mentioned "Cascaded deletion of related records... is implemented".
    // We should delete user records in order, or if they have cascades set up, just delete the user.
    // The safest is to delete aliases first, destinations, domains, blocks, then user.
    
    // Deleting a user requires deleting their aliases, reverse_map, events, blocks, destinations, domains.
    // We will do a full manual cascade just in case.
    const aliases = await db.prepare("SELECT id FROM aliases WHERE user_id = ?").bind(id).all<{ id: number }>();
    for (const alias of aliases.results ?? []) {
      await db.prepare("DELETE FROM events WHERE alias_id = ?").bind(alias.id).run();
      await db.prepare("DELETE FROM reverse_map WHERE alias_id = ?").bind(alias.id).run();
      await db.prepare("DELETE FROM blocks WHERE alias_id = ?").bind(alias.id).run();
    }
    await db.prepare("DELETE FROM aliases WHERE user_id = ?").bind(id).run();
    await db.prepare("DELETE FROM blocks WHERE user_id = ?").bind(id).run();
    await db.prepare("DELETE FROM destinations WHERE user_id = ?").bind(id).run();
    await db.prepare("DELETE FROM domains WHERE user_id = ?").bind(id).run();
    await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();

    return c.json({ ok: true });
  });

  // Create global domain
  r.post("/domains", async (c) => {
    const { domain } = await c.req.json<{ domain: string }>().catch(() => ({ domain: "" }));
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain) return c.json({ error: "invalid domain" }, 400);
    
    const db = c.env.DB;
    try {
      const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      await db.prepare(
        "INSERT INTO domains (user_id, is_global, domain, active, created_at, verification_token, verified_at) VALUES (1, 1, ?, 0, ?, ?, NULL)"
      ).bind(normalizedDomain, Date.now(), token).run();
      return c.json({ ok: true });
    } catch (e: any) {
      if (e.message && e.message.includes("UNIQUE constraint failed")) {
        return c.json({ error: "domain already exists" }, 409);
      }
      return c.json({ error: "internal error" }, 500);
    }
  });

  // Update global domain (e.g. toggle allow_custom_aliases, active)
  r.patch("/domains/:id", async (c) => {
    const db = c.env.DB;
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400);

    const { allow_custom_aliases, active } = await c.req.json<{ allow_custom_aliases?: number, active?: number }>().catch(() => ({}));
    const domainRow = await db.prepare("SELECT domain FROM domains WHERE id = ? AND is_global = 1").bind(id).first<{ domain: string }>();
    if (!domainRow) return c.json({ error: "domain not found" }, 404);
    if (allow_custom_aliases !== undefined) {
      await db.prepare("UPDATE domains SET allow_custom_aliases = ? WHERE id = ? AND is_global = 1")
        .bind(allow_custom_aliases ? 1 : 0, id).run();
    }
    if (active !== undefined) {
      if (!active) {
        const mainGlobalDomain = await getMainGlobalDomain(db, c.env);
        if (domainRow.domain === mainGlobalDomain) return c.json({ error: "cannot deactivate main global domain" }, 400);
      }
      await db.prepare("UPDATE domains SET active = ? WHERE id = ? AND is_global = 1")
        .bind(active ? 1 : 0, id).run();
    }
    return c.json({ ok: true });
  });

  // Verify global domain via DNS DoH
  r.post("/domains/:id/verify", async (c) => {
    const db = c.env.DB;
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400);

    const row = await db.prepare("SELECT domain, verification_token, verified_at FROM domains WHERE id = ? AND is_global = 1").bind(id).first<{ domain: string; verification_token: string | null; verified_at: number | null }>();
    if (!row) return c.json({ error: "domain not found" }, 404);
    if (row.verified_at) return c.json({ ok: true, verified: true });
    if (!row.verification_token) return c.json({ error: "no verification token" }, 400);

    const tokenRecord = `hidemyemail-verify=${row.verification_token}`;
    const checkDomain = `_hidemyemail.${row.domain}`;
    
    try {
      const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(checkDomain)}&type=TXT`, {
        headers: { "accept": "application/dns-json" }
      });
      if (!res.ok) throw new Error("DNS query failed");
      const dnsData = await res.json() as { Status: number; Answer?: { type: number; data: string; }[] };
      
      let verified = false;
      if (dnsData.Status === 0 && dnsData.Answer) {
        for (const answer of dnsData.Answer) {
          // TXT records are wrapped in quotes in DoH JSON output
          if (answer.type === 16 && answer.data.replace(/"/g, "") === tokenRecord) {
            verified = true;
            break;
          }
        }
      }

      if (verified) {
        await db.prepare("UPDATE domains SET verified_at = ?, active = 1 WHERE id = ?").bind(Date.now(), id).run();
        return c.json({ ok: true, verified: true });
      } else {
        return c.json({ ok: true, verified: false, error: "DNS record not found" });
      }
    } catch (e: any) {
      return c.json({ error: "DNS lookup failed" }, 500);
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

      // Validate value types
      if (key === "rate_limit_per_alias" || key === "rate_limit_global") {
        const n = parseInt(value, 10);
        if (isNaN(n) || n < 1 || n > 100000) {
          errors.push(`${key}: must be a number between 1 and 100,000`);
          continue;
        }
      }

      if (key === "max_inbound_bytes") {
        const n = parseInt(value, 10);
        if (isNaN(n) || n < 1024 || n > 100 * 1024 * 1024) {
          errors.push(`${key}: must be between 1KB and 100MB`);
          continue;
        }
      }

      if (key === "catch_all_auto_create" || key === "registration_enabled") {
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

  return r;
}
