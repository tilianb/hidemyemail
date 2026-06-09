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
    // Bounce totals sum hard ('bounce') and soft ('soft_bounce') events.
    const countEvents = (types: string, since: number) =>
      db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type IN (${types}) AND ts >= ?`).bind(since).first<{ n: number }>();
    const [bounce24hTotal, bounce7dTotal, complaint24hTotal, complaint7dTotal] = await Promise.all([
      countEvents("'bounce','soft_bounce'", since24h),
      countEvents("'bounce','soft_bounce'", since7d),
      countEvents("'complaint'", since24h),
      countEvents("'complaint'", since7d),
    ]);
    const totalsBase = {
      bounce_24h: bounce24hTotal?.n ?? 0,
      bounce_7d: bounce7dTotal?.n ?? 0,
      complaint_24h: complaint24hTotal?.n ?? 0,
      complaint_7d: complaint7dTotal?.n ?? 0,
    };
    const healthFor = (hardSuppressed: number) =>
      totalsBase.complaint_24h > 0 || totalsBase.bounce_24h >= 10 || hardSuppressed > 0 ? "attention" : "healthy";

    const suppressedRows = await db.prepare(
      "SELECT id, user_id, email_hash, suppressed_at, suppression_reason, suppression_class FROM destinations WHERE suppressed_at IS NOT NULL ORDER BY suppressed_at DESC"
    ).all<{ id: number; user_id: number; email_hash: string | null; suppressed_at: number; suppression_reason: string | null; suppression_class: string | null }>();

    const results = [];
    for (const row of suppressedRows.results ?? []) {
      const [bounce24h, bounce7d, complaint24h, complaint7d] = await Promise.all([
        countEventsForDestinationSince(db, row.id, ["bounce", "soft_bounce"], since24h),
        countEventsForDestinationSince(db, row.id, ["bounce", "soft_bounce"], since7d),
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

    const hardSuppressed = results.filter(s => s.suppression_class === "hard").length;
    const totals = {
      ...totalsBase,
      suppressed: results.length,
      hard_suppressed: hardSuppressed,
      soft_suppressed: results.filter(s => s.suppression_class === "soft").length,
    };

    return c.json({ suppressions: results, totals, health: healthFor(hardSuppressed) });
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
