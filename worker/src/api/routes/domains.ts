import { Hono } from "hono";
import type { AppEnv } from "../app";
import * as q from "../../db/queries";
import { encryptDestination, decryptDestination, hashDestination } from "../../lib/crypto";
import { getMainGlobalDomain, getEnvWithOverride } from "../../lib/settings";

export function domainRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/domains", async (c) => {
    const userId = c.get("userId");
    const sql = userId === 1
      ? "SELECT * FROM domains WHERE is_global = 1 OR user_id = ? ORDER BY domain"
      : "SELECT * FROM domains WHERE (is_global = 1 AND active = 1 AND verified_at IS NOT NULL) OR user_id = ? ORDER BY domain";
    const rows = await c.env.DB.prepare(sql).bind(userId).all<any>();
    
    try {
      const results = [];
      for (const row of rows.results ?? []) {
        if (row.is_global === 1 && !row.verification_token) {
          const token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
          const result = await c.env.DB.prepare(
            "UPDATE domains SET verification_token = ? WHERE id = ? AND verification_token IS NULL"
          ).bind(token, row.id).run();
          if (result.meta.changes > 0) {
            row.verification_token = token;
          } else {
            const updated = await c.env.DB.prepare("SELECT verification_token FROM domains WHERE id = ?").bind(row.id).first<{ verification_token: string }>();
            row.verification_token = updated?.verification_token ?? token;
          }
        }
        if (row.default_destination) {
          row.default_destination = await decryptDestination(row.default_destination, c.env.DESTINATION_ENCRYPTION_KEY);
        }
        results.push(row);
      }
      return c.json(results);
    } catch (e) {
      console.error("GET /domains Error:", e);
      return c.json({ error: String(e) }, 500);
    }
  });

  r.post("/domains", async (c) => {
    const userId = c.get("userId");
    const { domain, default_destination, base_domain_id } = await c.req.json<{ domain: string; default_destination: string; base_domain_id?: number }>();
    if (!domain) return c.json({ error: "Missing domain prefix" }, 400);

    const prefix = domain.toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!prefix || prefix.length > 63) return c.json({ error: "Invalid prefix" }, 400);
    if (prefix === "dev") return c.json({ error: "The 'dev' subdomain is reserved" }, 400);

    let baseDomain: { domain: string; allow_subdomain_aliases: number; active: number; verified_at: number | null } | null;
    if (base_domain_id !== undefined) {
      baseDomain = await c.env.DB.prepare(
        "SELECT domain, allow_subdomain_aliases, active, verified_at FROM domains WHERE id = ? AND is_global = 1"
      ).bind(base_domain_id).first<{ domain: string; allow_subdomain_aliases: number; active: number; verified_at: number | null }>();
    } else {
      const mainGlobalDomain = await getMainGlobalDomain(c.env.DB, c.env);
      if (!mainGlobalDomain) return c.json({ error: "Main global domain is not configured" }, 400);
      baseDomain = await c.env.DB.prepare(
        "SELECT domain, allow_subdomain_aliases, active, verified_at FROM domains WHERE domain = ? AND is_global = 1"
      ).bind(mainGlobalDomain).first<{ domain: string; allow_subdomain_aliases: number; active: number; verified_at: number | null }>();
    }
    if (!baseDomain) return c.json({ error: "Base domain not found" }, 400);
    if (!baseDomain.active || !baseDomain.verified_at || !baseDomain.allow_subdomain_aliases) {
      return c.json({ error: "Subdomain aliases are not enabled for this domain" }, 403);
    }

    const fullDomain = `${prefix}.${baseDomain.domain}`;

    const sesRegion = await getEnvWithOverride(c.env.DB, c.env, "ses_region") || "us-east-1";
    const expectedMx = `inbound-smtp.${sesRegion}.amazonaws.com`;
    try {
      const mxRes = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(fullDomain)}&type=MX`,
        { headers: { "accept": "application/dns-json" } }
      );
      if (mxRes.ok) {
        const mxData = await mxRes.json() as any;
        const mxOk = mxData.Status === 0 && mxData.Answer?.some((a: any) => a.type === 15 && a.data.includes(expectedMx));
        if (!mxOk) return c.json({ error: `No MX record found for ${fullDomain} pointing to ${expectedMx}. Add a wildcard MX record on *.${baseDomain.domain} first.` }, 400);
      }
    } catch {}

    const maxSubdomains = await (await import("../../lib/settings")).getNumericSetting(c.env.DB, "max_subdomains");
    if (maxSubdomains >= 0) {
      const count = await c.env.DB.prepare("SELECT COUNT(*) as count FROM domains WHERE user_id = ? AND is_global = 0").bind(userId).first<{ count: number }>();
      if (count && count.count >= maxSubdomains) {
        return c.json({ error: "Total domain quota exceeded" }, 400);
      }
    }

    if (default_destination && default_destination !== "global") {
      const emailHash = await hashDestination(default_destination.toLowerCase(), c.env.DESTINATION_ENCRYPTION_KEY);
      const destVerified = await c.env.DB.prepare("SELECT id FROM destinations WHERE user_id = ? AND email_hash = ? AND verified_at IS NOT NULL").bind(userId, emailHash).first();
      if (!destVerified) return c.json({ error: "Destination email not verified" }, 400);
    }

    try {
      let destEnc = null;
      let destHash = null;
      if (default_destination === "global") {
        destEnc = await encryptDestination("global", c.env.DESTINATION_ENCRYPTION_KEY);
        destHash = await hashDestination("global", c.env.DESTINATION_ENCRYPTION_KEY);
      } else if (default_destination) {
        destEnc = await encryptDestination(default_destination.toLowerCase(), c.env.DESTINATION_ENCRYPTION_KEY);
        destHash = await hashDestination(default_destination.toLowerCase(), c.env.DESTINATION_ENCRYPTION_KEY);
      }
      
      const res = await c.env.DB.prepare(
        "INSERT INTO domains (user_id, is_global, domain, default_destination, default_destination_hash, created_at) VALUES (?, 0, ?, ?, ?, ?)"
      ).bind(userId, fullDomain, destEnc, destHash, Date.now()).run();
      
      return c.json({ id: res.meta.last_row_id, domain: fullDomain, default_destination });
    } catch (err: any) {
      return c.json({ error: "Domain already exists or internal error" }, 500);
    }
  });

  r.delete("/domains/:id", async (c) => {
    const userId = c.get("userId");
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

    // Scope precheck by user_id for non-admins to prevent IDOR leak of other users' domain IDs
    const domainRow = userId === 1
      ? await c.env.DB.prepare("SELECT is_global, domain FROM domains WHERE id = ?").bind(id).first<{ is_global: number; domain: string }>()
      : await c.env.DB.prepare("SELECT is_global, domain FROM domains WHERE id = ? AND user_id = ?").bind(id, userId).first<{ is_global: number; domain: string }>();
    if (!domainRow) return c.json({ error: "Not found" }, 404);
    if (domainRow.is_global && userId !== 1) return c.json({ error: "Cannot delete global domain" }, 400);
    if (domainRow.is_global && userId === 1) {
      const mainGlobalDomain = await getMainGlobalDomain(c.env.DB, c.env);
      if (domainRow.domain === mainGlobalDomain) return c.json({ error: "Cannot delete main global domain" }, 400);
    }

    // Get all alias IDs belonging to this user under this domain for cleanup
    const aliasRows = userId === 1 
      ? await c.env.DB.prepare("SELECT id FROM aliases WHERE domain_id = ?").bind(id).all<{ id: number }>()
      : await c.env.DB.prepare("SELECT id FROM aliases WHERE domain_id = ? AND user_id = ?").bind(id, userId).all<{ id: number }>();
    const aliasIds = (aliasRows.results ?? []).map(r => r.id);

    // Batch delete: related data, then aliases, then domain
    const stmts: D1PreparedStatement[] = [];
    for (const aid of aliasIds) {
      stmts.push(c.env.DB.prepare("DELETE FROM reverse_map WHERE alias_id = ?").bind(aid));
      stmts.push(c.env.DB.prepare("DELETE FROM blocks WHERE alias_id = ?").bind(aid));
      stmts.push(c.env.DB.prepare("DELETE FROM events WHERE alias_id = ?").bind(aid));
    }
    if (userId === 1) {
      stmts.push(c.env.DB.prepare("DELETE FROM aliases WHERE domain_id = ?").bind(id));
      stmts.push(c.env.DB.prepare("DELETE FROM domains WHERE id = ?").bind(id));
    } else {
      stmts.push(c.env.DB.prepare("DELETE FROM aliases WHERE domain_id = ? AND user_id = ?").bind(id, userId));
      stmts.push(c.env.DB.prepare("DELETE FROM domains WHERE id = ? AND user_id = ?").bind(id, userId));
    }
    if (stmts.length > 0) await c.env.DB.batch(stmts);
    
    return c.json({ ok: true });
  });

  return r;
}
