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
    const b = await c.req.json<{ alias_id?: number | null; pattern: string }>();
    if (!b.pattern) return c.json({ error: "missing pattern" }, 400);
    
    if (b.alias_id) {
      const alias = await c.env.DB.prepare("SELECT id FROM aliases WHERE id = ? AND user_id = ?").bind(b.alias_id, userId).first();
      if (!alias) return c.json({ error: "alias not found" }, 403);
    }
    
    const row = await c.env.DB.prepare("INSERT INTO blocks (user_id, alias_id, pattern, created_at) VALUES (?,?,?,?) RETURNING *")
      .bind(userId, b.alias_id ?? null, b.pattern.toLowerCase(), Date.now()).first();
    return c.json(row);
  });
  r.delete("/blocks/:id", async (c) => {
    const userId = c.get("userId");
    await c.env.DB.prepare("DELETE FROM blocks WHERE id=? AND user_id=?").bind(Number(c.req.param("id")), userId).run();
    return c.json({ ok: true });
  });
  return r;
}
