import { Hono } from "hono";
import type { AppEnv } from "../app";

export function blockRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/blocks", async (c) => {
    const rows = await c.env.DB.prepare("SELECT * FROM blocks ORDER BY created_at DESC").all();
    return c.json(rows.results ?? []);
  });
  r.post("/blocks", async (c) => {
    const b = await c.req.json<{ alias_id?: number | null; pattern: string }>();
    if (!b.pattern) return c.json({ error: "missing pattern" }, 400);
    const row = await c.env.DB.prepare("INSERT INTO blocks (alias_id, pattern, created_at) VALUES (?,?,?) RETURNING id")
      .bind(b.alias_id ?? null, b.pattern.toLowerCase(), Date.now()).first<{ id: number }>();
    return c.json(row);
  });
  r.delete("/blocks/:id", async (c) => {
    await c.env.DB.prepare("DELETE FROM blocks WHERE id=?").bind(Number(c.req.param("id"))).run();
    return c.json({ ok: true });
  });
  return r;
}
