import { Hono } from "hono";
import type { AppEnv } from "../app";

export function aliasRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/aliases", async (c) => {
    const userId = c.get("userId");
    const query = c.req.query("q");
    const sql = query
      ? "SELECT a.*, d.domain FROM aliases a JOIN domains d ON d.id=a.domain_id WHERE a.user_id = ? AND a.full_address LIKE ? ORDER BY a.created_at DESC LIMIT 500"
      : "SELECT a.*, d.domain FROM aliases a JOIN domains d ON d.id=a.domain_id WHERE a.user_id = ? ORDER BY a.created_at DESC LIMIT 500";
    const stmt = query ? c.env.DB.prepare(sql).bind(userId, `%${query}%`) : c.env.DB.prepare(sql).bind(userId);
    const rows = await stmt.all();
    return c.json(rows.results ?? []);
  });

  r.post("/aliases", async (c) => {
    const userId = c.get("userId");
    const b = await c.req.json<{ domain_id: number; local_part: string; destination?: string; label?: string }>();
    const dom = await c.env.DB.prepare("SELECT domain FROM domains WHERE id=?").bind(b.domain_id).first<{ domain: string }>();
    if (!dom) return c.json({ error: "unknown domain" }, 400);
    if (b.local_part.startsWith("r.")) return c.json({ error: "reserved prefix" }, 400);
    const full = `${b.local_part.toLowerCase()}@${dom.domain}`;
    
    try {
      const row = await c.env.DB.prepare(
        "INSERT INTO aliases (domain_id, user_id, local_part, full_address, destination, label, active, source, created_at) " +
        "VALUES (?,?,?,?,?,?,1,'dashboard',?) RETURNING *"
      ).bind(b.domain_id, userId, b.local_part.toLowerCase(), full, b.destination ?? null, b.label ?? null, Date.now()).first();
      return c.json(row);
    } catch (err: any) {
      if (err.message && err.message.includes("UNIQUE constraint failed")) {
        return c.json({ error: "alias already exists" }, 409);
      }
      return c.json({ error: "internal error" }, 500);
    }
  });

  r.patch("/aliases/:id", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    const b = await c.req.json<{ active?: number; destination?: string | null; label?: string | null }>();
    const sets: string[] = []; const vals: unknown[] = [];
    if (b.active !== undefined) { sets.push("active=?"); vals.push(b.active); }
    if (b.destination !== undefined) { sets.push("destination=?"); vals.push(b.destination); }
    if (b.label !== undefined) { sets.push("label=?"); vals.push(b.label); }
    if (!sets.length) return c.json({ error: "no fields" }, 400);
    vals.push(id, userId);
    const res = await c.env.DB.prepare(`UPDATE aliases SET ${sets.join(", ")} WHERE id=? AND user_id=?`).bind(...vals).run();
    if (res.meta.changes === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  r.delete("/aliases/:id", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
    try {
      const exists = await c.env.DB.prepare("SELECT id FROM aliases WHERE id=? AND user_id=?").bind(id, userId).first();
      if (!exists) return c.json({ error: "alias not found" }, 404);
      await c.env.DB.batch([
        c.env.DB.prepare("DELETE FROM reverse_map WHERE alias_id=?").bind(id),
        c.env.DB.prepare("DELETE FROM blocks WHERE alias_id=?").bind(id),
        c.env.DB.prepare("DELETE FROM events WHERE alias_id=?").bind(id),
        c.env.DB.prepare("DELETE FROM aliases WHERE id=? AND user_id=?").bind(id, userId),
      ]);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      return c.json({ error: `delete failed: ${msg}` }, 500);
    }
  });

  r.get("/aliases/:id/events", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    const rows = await c.env.DB.prepare(
      "SELECT e.* FROM events e JOIN aliases a ON e.alias_id = a.id WHERE e.alias_id=? AND a.user_id=? ORDER BY e.ts DESC LIMIT 200"
    ).bind(id, userId).all();
    return c.json(rows.results ?? []);
  });

  return r;
}
