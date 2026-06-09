import type { Hono } from "hono";
import type { AppEnv } from "../../app";
import { clearSuppression, countEventsForDestinationSince } from "../../../db/queries";

export function registerAdminSuppressionRoutes(r: Hono<AppEnv>) {
  // ── Suppressions ──────────────────────────────────────────────────────────
  r.get("/suppressions", async (c) => {
    const db = c.env.DB;
    const now = Date.now();
    const since24h = now - 24 * 3600_000;
    const since7d = now - 7 * 24 * 3600_000;
    const emptySuppressionResponse = {
      suppressions: [],
      totals: {
        bounce_24h: 0,
        bounce_7d: 0,
        complaint_24h: 0,
        complaint_7d: 0,
        suppressed: 0,
        hard_suppressed: 0,
        soft_suppressed: 0,
      },
      health: "healthy" as const,
      migration_pending: true,
    };

    const bounce24hTotal = await db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE type = 'bounce' AND ts >= ?"
    ).bind(since24h).first<{ n: number }>();
    const bounce7dTotal = await db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE type = 'bounce' AND ts >= ?"
    ).bind(since7d).first<{ n: number }>();
    const complaint24hTotal = await db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE type = 'complaint' AND ts >= ?"
    ).bind(since24h).first<{ n: number }>();
    const complaint7dTotal = await db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE type = 'complaint' AND ts >= ?"
    ).bind(since7d).first<{ n: number }>();

    let suppressedRows;
    try {
      suppressedRows = await db.prepare(
        "SELECT id, user_id, email_hash, suppressed_at, suppression_reason, suppression_class FROM destinations WHERE suppressed_at IS NOT NULL ORDER BY suppressed_at DESC"
      ).all<{ id: number; user_id: number; email_hash: string | null; suppressed_at: number; suppression_reason: string | null; suppression_class: string | null }>();
    } catch (err: any) {
      if (String(err?.message ?? err).includes("no such column")) {
        return c.json(emptySuppressionResponse);
      }
      throw err;
    }

    const results = [];
    for (const row of suppressedRows.results ?? []) {
      const [bounce24h, bounce7d, complaint24h, complaint7d] = await Promise.all([
        countEventsForDestinationSince(db, row.id, "bounce", since24h),
        countEventsForDestinationSince(db, row.id, "bounce", since7d),
        countEventsForDestinationSince(db, row.id, "complaint", since24h),
        countEventsForDestinationSince(db, row.id, "complaint", since7d),
      ]);

      results.push({
        id: row.id,
        user_id: row.user_id,
        suppressed_at: row.suppressed_at,
        suppression_reason: row.suppression_reason,
        suppression_class: row.suppression_class,
        bounce_24h: bounce24h,
        bounce_7d: bounce7d,
        complaint_24h: complaint24h,
        complaint_7d: complaint7d,
      });
    }

    const totals = {
      bounce_24h: bounce24hTotal?.n ?? 0,
      bounce_7d: bounce7dTotal?.n ?? 0,
      complaint_24h: complaint24hTotal?.n ?? 0,
      complaint_7d: complaint7dTotal?.n ?? 0,
      suppressed: results.length,
      hard_suppressed: results.filter(s => s.suppression_class === "hard").length,
      soft_suppressed: results.filter(s => s.suppression_class === "soft").length,
    };
    const health = totals.complaint_24h > 0 || totals.bounce_24h >= 10 || totals.hard_suppressed > 0 ? "attention" : "healthy";

    return c.json({ suppressions: results, totals, health });
  });

  r.post("/suppressions/:id/clear", async (c) => {
    const db = c.env.DB;
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

    const dest = await db.prepare("SELECT id FROM destinations WHERE id = ?").bind(id).first<{ id: number }>();
    if (!dest) return c.json({ error: "Destination not found" }, 404);

    await clearSuppression(db, id);
    return c.json({ ok: true });
  });
}
