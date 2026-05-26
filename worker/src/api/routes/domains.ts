import { Hono } from "hono";
import type { AppEnv } from "../app";
import * as q from "../../db/queries";
import { encryptDestination, decryptDestination, hashDestination } from "../../lib/crypto";

export function domainRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/domains", async (c) => {
    const userId = c.get("userId");
    const rows = await c.env.DB.prepare("SELECT * FROM domains WHERE is_global = 1 OR user_id = ? ORDER BY domain").bind(userId).all<any>();
    
    try {
      const results = [];
      for (const row of rows.results ?? []) {
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
    const { domain, default_destination } = await c.req.json<{ domain: string; default_destination: string }>();
    if (!domain) return c.json({ error: "missing domain prefix" }, 400);

    const prefix = domain.toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!prefix || prefix.length > 63) return c.json({ error: "invalid prefix" }, 400);

    const fullDomain = `${prefix}.hidemyemail.dev`;

    const count = await c.env.DB.prepare("SELECT COUNT(*) as count FROM domains WHERE user_id = ? AND is_global = 0").bind(userId).first<{ count: number }>();
    if (count && count.count >= 5) {
      return c.json({ error: "subdomain quota exceeded" }, 400);
    }

    if (default_destination) {
      const emailHash = await hashDestination(default_destination.toLowerCase(), c.env.DESTINATION_ENCRYPTION_KEY);
      const destVerified = await c.env.DB.prepare("SELECT id FROM destinations WHERE user_id = ? AND email_hash = ? AND verified_at IS NOT NULL").bind(userId, emailHash).first();
      if (!destVerified) return c.json({ error: "destination email not verified" }, 400);
    }

    try {
      const destEnc = default_destination ? await encryptDestination(default_destination.toLowerCase(), c.env.DESTINATION_ENCRYPTION_KEY) : null;
      const destHash = default_destination ? await hashDestination(default_destination.toLowerCase(), c.env.DESTINATION_ENCRYPTION_KEY) : null;
      
      const res = await c.env.DB.prepare(
        "INSERT INTO domains (user_id, is_global, domain, default_destination, default_destination_hash, created_at) VALUES (?, 0, ?, ?, ?, ?)"
      ).bind(userId, fullDomain, destEnc, destHash, Date.now()).run();
      
      return c.json({ id: res.meta.last_row_id, domain: fullDomain, default_destination });
    } catch (err: any) {
      return c.json({ error: "domain already exists or internal error" }, 500);
    }
  });

  r.delete("/domains/:id", async (c) => {
    const userId = c.get("userId");
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400);

    // Scope precheck by user_id for non-admins to prevent IDOR leak of other users' domain IDs
    const domainRow = userId === 1
      ? await c.env.DB.prepare("SELECT is_global FROM domains WHERE id = ?").bind(id).first<{ is_global: number }>()
      : await c.env.DB.prepare("SELECT is_global FROM domains WHERE id = ? AND user_id = ?").bind(id, userId).first<{ is_global: number }>();
    if (!domainRow) return c.json({ error: "not found" }, 404);
    if (domainRow.is_global && userId !== 1) return c.json({ error: "cannot delete global domain" }, 400);

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
