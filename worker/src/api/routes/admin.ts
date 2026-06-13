import { Hono } from "hono";
import type { AppEnv } from "../app";
import { getEnvWithOverride, getMainGlobalDomain } from "../../lib/settings";
import { sendRaw } from "../../lib/ses";
import { normalizeDomain, normalizeEmail } from "./admin/helpers";
import { registerAdminSettingsRoutes } from "./admin/settings";
import { registerAdminSuppressionRoutes } from "./admin/suppressions";

const TEST_EMAIL_TYPES = new Set(["recovery", "mfa", "notification", "demo_forward", "demo_oq"]);

export function adminRoutes() {
  const r = new Hono<AppEnv>();

  // Middleware to ensure user is admin
  r.use("*", async (c, next) => {
    const userId = c.get("userId");
    if (userId !== 1) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  });

  registerAdminSettingsRoutes(r);
  registerAdminSuppressionRoutes(r);

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
    if (isNaN(id) || id === 1) return c.json({ error: "Invalid id" }, 400);

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
    if (isNaN(id) || id === 1) return c.json({ error: "Invalid id" }, 400);

    const { sendEmail } = await c.req.json<{ sendEmail?: boolean }>().catch(() => ({} as any));

    const token = crypto.randomUUID();
    const expiresAt = Date.now() + 24 * 3600 * 1000; // 24 hours

    await db.prepare("UPDATE users SET recovery_token = ?, recovery_expires_at = ? WHERE id = ?").bind(token, expiresAt, id).run();

    if (sendEmail) {
      const { decryptDestination } = await import("../../lib/crypto");
      const { sendRaw } = await import("../../lib/ses");
      const { buildRecoveryEmail } = await import("../../lib/emails");
      
      const dest = await db.prepare("SELECT email FROM destinations WHERE user_id = ? AND is_default = 1").bind(id).first<{ email: string }>();
      if (!dest) return c.json({ error: "User has no default destination email" }, 400);

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

  // Delete user (full manual cascade via shared helper)
  r.delete("/users/:id", async (c) => {
    const db = c.env.DB;
    const id = parseInt(c.req.param("id"));
    if (isNaN(id) || id === 1) return c.json({ error: "Invalid id" }, 400);

    const { hardDeleteUser } = await import("../../lib/purge");
    await hardDeleteUser(db, id);

    return c.json({ ok: true });
  });

  // Create global domain
  r.post("/domains", async (c) => {
    const { domain } = await c.req.json<{ domain: string }>().catch(() => ({ domain: "" }));
    const normalizedDomain = normalizeDomain(domain);
    if (!normalizedDomain) return c.json({ error: "Invalid domain" }, 400);
    
    const db = c.env.DB;
    try {
      const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      await db.prepare(
        "INSERT INTO domains (user_id, is_global, domain, active, created_at, verification_token, verified_at) VALUES (1, 1, ?, 0, ?, ?, NULL)"
      ).bind(normalizedDomain, Date.now(), token).run();
      return c.json({ ok: true });
    } catch (e: any) {
      if (e.message && e.message.includes("UNIQUE constraint failed")) {
        return c.json({ error: "Domain already exists" }, 409);
      }
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // Update global domain (e.g. toggle allow_custom_aliases, active)
  r.patch("/domains/:id", async (c) => {
    const db = c.env.DB;
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

    const { allow_custom_aliases, allow_subdomain_aliases, active } = await c.req
      .json<{ allow_custom_aliases?: number, allow_subdomain_aliases?: number, active?: number }>()
      .catch((): { allow_custom_aliases?: number, allow_subdomain_aliases?: number, active?: number } => ({}));
    const domainRow = await db.prepare("SELECT domain FROM domains WHERE id = ? AND is_global = 1").bind(id).first<{ domain: string }>();
    if (!domainRow) return c.json({ error: "Domain not found" }, 404);
    if (allow_custom_aliases !== undefined) {
      await db.prepare("UPDATE domains SET allow_custom_aliases = ? WHERE id = ? AND is_global = 1")
        .bind(allow_custom_aliases ? 1 : 0, id).run();
    }
    if (allow_subdomain_aliases !== undefined) {
      await db.prepare("UPDATE domains SET allow_subdomain_aliases = ? WHERE id = ? AND is_global = 1")
        .bind(allow_subdomain_aliases ? 1 : 0, id).run();
    }
    if (active !== undefined) {
      if (!active) {
        const mainGlobalDomain = await getMainGlobalDomain(db, c.env);
        if (domainRow.domain === mainGlobalDomain) return c.json({ error: "Cannot deactivate main global domain" }, 400);
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
    if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

    const row = await db.prepare("SELECT domain, verification_token, verified_at, allow_subdomain_aliases FROM domains WHERE id = ? AND is_global = 1").bind(id).first<{ domain: string; verification_token: string | null; verified_at: number | null; allow_subdomain_aliases: number | null }>();
    if (!row) return c.json({ error: "Domain not found" }, 404);
    if (!row.verification_token) return c.json({ error: "No verification token" }, 400);

    const tokenRecord = `hidemyemail-verify=${row.verification_token}`;
    const checkDomain = `_hidemyemail.${row.domain}`;
    const sesRegion = await getEnvWithOverride(db, c.env, "ses_region") || "us-east-1";
    const expectedMx = `inbound-smtp.${sesRegion}.amazonaws.com`;
    
    try {
      const dohFetch = (url: string) =>
        fetch(url, { headers: { "accept": "application/dns-json" } })
          .then(r => r.ok ? r.json() as Promise<any> : null)
          .catch(() => null);

      // Probe subdomain to detect wildcard MX expansion for *.domain
      const wildcardProbe = `_hidemyemail-probe.${row.domain}`;
      const [dnsTxt, dnsMx, dnsSpf, dnsWildcardMx] = await Promise.all([
        dohFetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(checkDomain)}&type=TXT`),
        dohFetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(row.domain)}&type=MX`),
        dohFetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(row.domain)}&type=TXT`),
        dohFetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(wildcardProbe)}&type=MX`),
      ]);

      if (!dnsTxt && !dnsMx && !dnsSpf && !dnsWildcardMx) throw new Error("All DNS queries failed");

      let verifyTxtOk = false;
      let mxOk = false;
      let spfOk = false;
      let wildcardMxOk = row.allow_subdomain_aliases !== 1;

      if (dnsTxt?.Status === 0 && dnsTxt.Answer) {
        verifyTxtOk = dnsTxt.Answer.some((a: any) => a.type === 16 && a.data.replace(/"/g, "") === tokenRecord);
      }

      if (dnsMx?.Status === 0 && dnsMx.Answer) {
        // MX record data sometimes has priority included or trailing dot
        mxOk = dnsMx.Answer.some((a: any) => a.type === 15 && a.data.includes(expectedMx));
      }

      if (dnsSpf?.Status === 0 && dnsSpf.Answer) {
        spfOk = dnsSpf.Answer.some((a: any) => {
          if (a.type !== 16) return false;
          const data = a.data.replace(/"/g, "");
          return data.startsWith("v=spf1") && data.includes("include:amazonses.com");
        });
      }

      if (row.allow_subdomain_aliases === 1 && dnsWildcardMx?.Status === 0 && dnsWildcardMx.Answer) {
        wildcardMxOk = dnsWildcardMx.Answer.some((a: any) => a.type === 15 && a.data.includes(expectedMx));
      }

      const verified = verifyTxtOk; // Only require the verification TXT to actually "verify" domain ownership
      const results = { verify_txt: verifyTxtOk, mx: mxOk, spf: spfOk, wildcard_mx: wildcardMxOk };

      if (verified) {
        await db.prepare("UPDATE domains SET verified_at = ?, active = 1 WHERE id = ?").bind(Date.now(), id).run();
        // Auto-promote to primary if no primary is set yet, and enable subdomain aliases on it
        const promoted = await db.prepare(
          "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'main_global_domain' AND (value IS NULL OR value = '')"
        ).bind(row.domain, Date.now()).run();
        if (promoted.meta.changes > 0) {
          await db.prepare("UPDATE domains SET allow_subdomain_aliases = 1 WHERE id = ?").bind(id).run();
        }
        return c.json({ ok: true, verified: true, results });
      } else {
        return c.json({ ok: true, verified: false, error: "DNS record not found", results });
      }
    } catch (e: any) {
      return c.json({ error: "DNS lookup failed" }, 500);
    }
  });

  r.post("/test-email", async (c) => {
    const { type, to } = await c.req.json<{ type?: string; to?: string }>().catch((): { type?: string; to?: string } => ({}));
    const emailType = (type ?? "").trim().toLowerCase();
    if (!TEST_EMAIL_TYPES.has(emailType)) return c.json({ error: "Invalid test email type" }, 400);

    const email = normalizeEmail(to ?? "");
    if (!email) return c.json({ error: "Invalid destination email" }, 400);

    const db = c.env.DB;
    const sesAccessKeyId = await getEnvWithOverride(db, c.env, "ses_access_key_id");
    const sesSecretAccessKey = await getEnvWithOverride(db, c.env, "ses_secret_access_key");
    const sesRegion = await getEnvWithOverride(db, c.env, "ses_region");
    if (!sesAccessKeyId || !sesSecretAccessKey || !sesRegion) {
      return c.json({ error: "SES is not configured" }, 400);
    }

    const mainGlobalDomain = await getMainGlobalDomain(db, c.env) || "example.com";
    const { buildRecoveryEmail, buildMfaEmail, buildNotificationEmail } = await import("../../lib/emails");
    let rawBase64: string;
    let fromAddr = `HideMyEmail <noreply@${mainGlobalDomain}>`;
    if (emailType === "recovery") {
      const recoveryUrl = new URL("/recover?token=test-token", c.req.url).toString();
      rawBase64 = buildRecoveryEmail(email, recoveryUrl, mainGlobalDomain);
    } else if (emailType === "mfa") {
      rawBase64 = buildMfaEmail(email, "123456", mainGlobalDomain);
    } else if (emailType === "demo_forward" || emailType === "demo_oq") {
      const { buildDemoForward } = await import("../../email/demo");
      const built = await buildDemoForward({
        to: email, mainGlobalDomain, env: c.env, withOverQuota: emailType === "demo_oq",
      });
      rawBase64 = built.rawBase64;
      fromAddr = built.fromAddr;
    } else {
      rawBase64 = buildNotificationEmail(
        email,
        "HideMyEmail Test Notification",
        "Test Notification",
        "This is a test notification from your HideMyEmail admin interface.",
        mainGlobalDomain
      );
    }

    const sesSend: typeof sendRaw = (c.env as any).__sesSend ?? sendRaw;
    await sesSend(
      { accessKeyId: sesAccessKeyId, secretAccessKey: sesSecretAccessKey, region: sesRegion },
      { from: fromAddr, to: email, rawBase64 }
    );

    return c.json({ ok: true, type: emailType, to: email });
  });

  return r;
}
