export async function resetDb(db: D1Database): Promise<void> {
  for (const t of ["mail_quota_reservations", "mail_deliveries", "events", "reverse_map", "contacts", "blocks", "aliases", "domains", "identifier_reservations", "rate_limits", "push_devices", "api_keys"]) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
}
