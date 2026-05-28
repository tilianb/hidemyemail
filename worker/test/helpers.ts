export async function resetDb(db: D1Database): Promise<void> {
  for (const t of ["events", "reverse_map", "blocks", "aliases", "domains", "rate_limits"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
}
