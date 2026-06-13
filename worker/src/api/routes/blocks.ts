import { Hono } from "hono";
import type { AppEnv } from "../app";

export function blockRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/blocks", async (c) => {
    const userId = c.get("userId");
    const rows = await c.env.DB.prepare("SELECT * FROM blocks WHERE user_id = ? ORDER BY created_at DESC").bind(userId).all();
    return c.json(rows.results ?? []);
  });
  r.post("/blocks", async (c) => {
    const userId = c.get("userId");
    const b = await c.req.json<{ alias_id?: number | null; domain_id?: number | null; kind?: string; pattern: string }>();
    if (!b.pattern) return c.json({ error: "Missing pattern" }, 400);

    const kind = b.kind ?? "block";
    if (kind !== "block" && kind !== "allow") return c.json({ error: "kind must be 'block' or 'allow'" }, 400);

    // A rule is scoped to one alias, one subdomain, or (neither) the whole user.
    if (b.alias_id && b.domain_id) return c.json({ error: "Choose an alias or a subdomain scope, not both" }, 400);

    if (b.alias_id) {
      const alias = await c.env.DB.prepare("SELECT id FROM aliases WHERE id = ? AND user_id = ?").bind(b.alias_id, userId).first();
      if (!alias) return c.json({ error: "Alias not found" }, 403);
    }
    if (b.domain_id) {
      // Only personal subdomains may be scoped: a global domain is shared, so a
      // rule on it would apply to every user's aliases under that domain.
      const dom = await c.env.DB.prepare("SELECT id FROM domains WHERE id = ? AND user_id = ? AND is_global = 0").bind(b.domain_id, userId).first();
      if (!dom) return c.json({ error: "Domain not found" }, 403);
    }

    const row = await c.env.DB.prepare("INSERT INTO blocks (user_id, alias_id, domain_id, kind, pattern, created_at) VALUES (?,?,?,?,?,?) RETURNING *")
      .bind(userId, b.alias_id ?? null, b.domain_id ?? null, kind, b.pattern.toLowerCase(), Date.now()).first();
    return c.json(row);
  });
  r.delete("/blocks/:id", async (c) => {
    const userId = c.get("userId");
    await c.env.DB.prepare("DELETE FROM blocks WHERE id=? AND user_id=?").bind(Number(c.req.param("id")), userId).run();
    return c.json({ ok: true });
  });
  return r;
}
