import { Hono } from "hono";
import type { AppEnv } from "../app";
import { encryptDestination, decryptDestination, hashDestination } from "../../lib/crypto";
import { getMainGlobalDomain, getEnvWithOverride } from "../../lib/settings";
import { canUseIdentifier, isIdentifierReservationError, reserveIdentifierAndRun } from "../../db/reservations";

type ResolvedDefaultDestination = {
  encrypted: string | null;
  hash: string | null;
  publicValue: string | null | undefined;
};

async function resolveDefaultDestination(
  db: D1Database,
  userId: number,
  defaultDestination: string | null | undefined,
  encryptionKey: string,
): Promise<ResolvedDefaultDestination | null> {
  if (!defaultDestination) {
    return { encrypted: null, hash: null, publicValue: defaultDestination };
  }

  const normalizedDestination = defaultDestination === "global" ? "global" : defaultDestination.toLowerCase();
  const destinationHash = await hashDestination(normalizedDestination, encryptionKey);

  if (normalizedDestination !== "global") {
    const destVerified = await db.prepare(
      "SELECT id FROM destinations WHERE user_id = ? AND email_hash = ? AND verified_at IS NOT NULL"
    ).bind(userId, destinationHash).first();
    if (!destVerified) return null;
  }

  return {
    encrypted: await encryptDestination(normalizedDestination, encryptionKey),
    hash: destinationHash,
    publicValue: normalizedDestination,
  };
}

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

    const resolvedDefaultDestination = await resolveDefaultDestination(
      c.env.DB,
      userId,
      default_destination,
      c.env.DESTINATION_ENCRYPTION_KEY,
    );
    if (!resolvedDefaultDestination) return c.json({ error: "Destination email not verified" }, 400);
    if (!(await canUseIdentifier(c.env.DB, "subdomain", fullDomain, userId))) {
      return c.json({ error: "Subdomain is reserved by its original owner" }, 409);
    }

    try {
      const row = await reserveIdentifierAndRun<{ id: number }>(c.env.DB, "subdomain", fullDomain, userId, c.env.DB.prepare(
        "INSERT INTO domains (user_id, is_global, domain, default_destination, default_destination_hash, created_at) " +
        "VALUES (?, 0, ?, ?, ?, ?) RETURNING id"
      ).bind(userId, fullDomain, resolvedDefaultDestination.encrypted, resolvedDefaultDestination.hash, Date.now()));
      
      return c.json({ id: row!.id, domain: fullDomain, default_destination: resolvedDefaultDestination.publicValue });
    } catch (err: any) {
      if (isIdentifierReservationError(err)) {
        return c.json({ error: "Subdomain is reserved by its original owner" }, 409);
      }
      if (err.message?.includes("UNIQUE constraint failed")) {
        return c.json({ error: "Domain already exists" }, 409);
      }
      return c.json({ error: "Domain already exists or internal error" }, 500);
    }
  });

  // Update a personal subdomain in place — default destination and/or the
  // per-subdomain policies (catch-all, inline actions). No delete+recreate.
  r.patch("/domains/:id", async (c) => {
    const userId = c.get("userId");
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

    const b = await c.req
      .json<{ catch_all?: number | null; inline_actions_pref?: string | null; default_destination?: string | null }>()
      .catch(() => ({} as { catch_all?: number | null; inline_actions_pref?: string | null; default_destination?: string | null }));

    // Scope by user_id (no IDOR); only personal subdomains are editable here.
    // Global domains stay managed via the admin routes.
    const domainRow = await c.env.DB.prepare(
      "SELECT is_global FROM domains WHERE id = ? AND user_id = ?"
    ).bind(id, userId).first<{ is_global: number }>();
    if (!domainRow) return c.json({ error: "Not found" }, 404);
    if (domainRow.is_global) return c.json({ error: "Cannot edit global domain" }, 400);

    const sets: string[] = [];
    const vals: unknown[] = [];

    if (b.catch_all !== undefined) {
      if (b.catch_all !== null && b.catch_all !== 0 && b.catch_all !== 1) {
        return c.json({ error: "catch_all must be 0, 1, or null" }, 400);
      }
      sets.push("catch_all = ?"); vals.push(b.catch_all);
    }

    if (b.inline_actions_pref !== undefined) {
      if (b.inline_actions_pref !== null && b.inline_actions_pref !== "on" && b.inline_actions_pref !== "off") {
        return c.json({ error: "inline_actions_pref must be 'on', 'off', or null" }, 400);
      }
      sets.push("inline_actions_pref = ?"); vals.push(b.inline_actions_pref);
    }

    if (b.default_destination !== undefined) {
      // Validate the destination: "global", or a verified destination owned by
      // this user. Mirror POST /domains. Fail closed.
      const resolvedDefaultDestination = await resolveDefaultDestination(
        c.env.DB,
        userId,
        b.default_destination,
        c.env.DESTINATION_ENCRYPTION_KEY,
      );
      if (!resolvedDefaultDestination) return c.json({ error: "Destination email not verified" }, 400);
      sets.push("default_destination = ?"); vals.push(resolvedDefaultDestination.encrypted);
      sets.push("default_destination_hash = ?"); vals.push(resolvedDefaultDestination.hash);
    }

    if (!sets.length) return c.json({ error: "No fields" }, 400);
    vals.push(id, userId);
    await c.env.DB.prepare(`UPDATE domains SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).bind(...vals).run();
    return c.json(b.default_destination !== undefined ? { ok: true, default_destination: b.default_destination } : { ok: true });
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
      stmts.push(c.env.DB.prepare("DELETE FROM contacts WHERE alias_id = ?").bind(aid));
      stmts.push(c.env.DB.prepare("DELETE FROM blocks WHERE alias_id = ?").bind(aid));
      stmts.push(c.env.DB.prepare("DELETE FROM events WHERE alias_id = ?").bind(aid));
    }
    if (userId === 1) {
      stmts.push(c.env.DB.prepare("DELETE FROM blocks WHERE domain_id = ?").bind(id));
      stmts.push(c.env.DB.prepare("DELETE FROM aliases WHERE domain_id = ?").bind(id));
      stmts.push(c.env.DB.prepare("DELETE FROM domains WHERE id = ?").bind(id));
    } else {
      stmts.push(c.env.DB.prepare("DELETE FROM blocks WHERE domain_id = ? AND user_id = ?").bind(id, userId));
      stmts.push(c.env.DB.prepare("DELETE FROM aliases WHERE domain_id = ? AND user_id = ?").bind(id, userId));
      stmts.push(c.env.DB.prepare("DELETE FROM domains WHERE id = ? AND user_id = ?").bind(id, userId));
    }
    if (stmts.length > 0) await c.env.DB.batch(stmts);
    
    return c.json({ ok: true });
  });

  return r;
}
