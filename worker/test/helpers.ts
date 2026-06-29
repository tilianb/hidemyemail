export async function resetDb(db: D1Database): Promise<void> {
  for (const t of ["events", "reverse_map", "contacts", "blocks", "aliases", "domains", "rate_limits", "push_devices"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
}
