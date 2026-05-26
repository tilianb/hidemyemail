import { Hono } from "hono";
import type { AppEnv } from "../app";

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

    const { active, forwarding, name } = await c.req.json<{ active?: number, forwarding?: number, name?: string }>().catch(() => ({}));
    
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

    const token = crypto.randomUUID();
    const expiresAt = Date.now() + 24 * 3600 * 1000; // 24 hours

    await db.prepare("UPDATE users SET recovery_token = ?, recovery_expires_at = ? WHERE id = ?").bind(token, expiresAt, id).run();

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
    if (!domain || !domain.includes(".")) return c.json({ error: "invalid domain" }, 400);
    
    const db = c.env.DB;
    try {
      await db.prepare(
        "INSERT INTO domains (user_id, is_global, domain, active, created_at) VALUES (1, 1, ?, 1, ?)"
      ).bind(domain.toLowerCase(), Date.now()).run();
      return c.json({ ok: true });
    } catch (e: any) {
      if (e.message && e.message.includes("UNIQUE constraint failed")) {
        return c.json({ error: "domain already exists" }, 409);
      }
      return c.json({ error: "internal error" }, 500);
    }
  });

  return r;
}
