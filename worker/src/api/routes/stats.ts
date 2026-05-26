import { Hono } from "hono";
import type { AppEnv } from "../app";

export function statsRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/stats", async (c) => {
    const db = c.env.DB;
    const userId = c.get("userId");
    const since = Date.now() - 24 * 3600_000;
    const aliases = await db.prepare("SELECT COUNT(*) AS n FROM aliases WHERE user_id = ?").bind(userId).first<{ n: number }>();
    const active = await db.prepare("SELECT COUNT(*) AS n FROM aliases WHERE active=1 AND user_id = ?").bind(userId).first<{ n: number }>();
    const byType = await db.prepare(
      "SELECT e.type, COUNT(*) AS n FROM events e JOIN aliases a ON e.alias_id = a.id WHERE a.user_id = ? AND e.ts>=? GROUP BY e.type"
    ).bind(userId, since).all<{ type: string; n: number }>();
    const top = await db.prepare(
      "SELECT full_address, fwd_count, reply_count, blocked_count FROM aliases WHERE user_id = ? ORDER BY fwd_count DESC LIMIT 10"
    ).bind(userId).all();
    const last24h: Record<string, number> = { forward: 0, reply: 0, block: 0, reject: 0, error: 0 };
    for (const row of byType.results ?? []) last24h[row.type] = row.n;
    return c.json({ totals: { aliases: aliases?.n ?? 0, active: active?.n ?? 0 }, last24h, topAliases: top.results ?? [], isAdmin: userId === 1 });
  });
  return r;
}
