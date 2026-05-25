import { Hono } from "hono";
import type { AppEnv } from "../app";
import * as q from "../../db/queries";

export function domainRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/domains", async (c) => {
    const userId = c.get("userId");
    const rows = await c.env.DB.prepare("SELECT * FROM domains WHERE is_global = 1 OR user_id = ? ORDER BY domain").bind(userId).all();
    return c.json(rows.results ?? []);
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
      const destVerified = await c.env.DB.prepare("SELECT id FROM destinations WHERE user_id = ? AND email = ? AND verified_at IS NOT NULL").bind(userId, default_destination.toLowerCase()).first();
      if (!destVerified) return c.json({ error: "destination email not verified" }, 400);
    }

    try {
      const res = await c.env.DB.prepare(
        "INSERT INTO domains (user_id, is_global, domain, default_destination, created_at) VALUES (?, 0, ?, ?, ?)"
      ).bind(userId, fullDomain, default_destination ? default_destination.toLowerCase() : null, Math.floor(Date.now() / 1000)).run();
      
      return c.json({ id: res.meta.last_row_id, domain: fullDomain, default_destination });
    } catch (err: any) {
      return c.json({ error: "domain already exists or internal error" }, 500);
    }
  });

  r.delete("/domains/:id", async (c) => {
    const userId = c.get("userId");
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400);

    const domainRow = await c.env.DB.prepare("SELECT is_global FROM domains WHERE id = ? AND user_id = ?").bind(id, userId).first<{ is_global: number }>();
    if (!domainRow) return c.json({ error: "not found" }, 404);
    if (domainRow.is_global) return c.json({ error: "cannot delete global domain" }, 400);

    await c.env.DB.prepare("DELETE FROM aliases WHERE domain_id = ?").bind(id).run();
    await c.env.DB.prepare("DELETE FROM domains WHERE id = ?").bind(id).run();
    
    return c.json({ ok: true });
  });

  return r;
}
