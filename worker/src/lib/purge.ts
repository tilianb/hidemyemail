/**
 * Hard-delete helpers for account purge.
 *
 * hardDeleteUser  — full manual cascade for a single user id.
 * purgeDeletedAccounts — select tombstoned users past the 7-day window and hard-delete each.
 */

/**
 * Permanently delete a user and all their owned rows, in child-before-parent order.
 * Mirrors the cascade in admin.ts DELETE /users/:id, extended to cover mfa,
 * passkey_credentials, and push_devices.
 */
export async function hardDeleteUser(db: D1Database, userId: number): Promise<void> {
  // One atomic batch: child rows before parents, in order. db.batch() runs the
  // statements in a single transaction, so a transient failure can never leave
  // a half-purged account (which would orphan rows and re-enter the purge with
  // destinations already gone).
  await db.batch([
    db.prepare("DELETE FROM events WHERE detail IN (SELECT 'dest:' || id FROM destinations WHERE user_id = ?)").bind(userId),
    db.prepare("DELETE FROM events WHERE alias_id IN (SELECT id FROM aliases WHERE user_id = ?)").bind(userId),
    db.prepare("DELETE FROM reverse_map WHERE alias_id IN (SELECT id FROM aliases WHERE user_id = ?)").bind(userId),
    db.prepare("DELETE FROM blocks WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM mfa WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM passkey_credentials WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM aliases WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM destinations WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM domains WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM push_devices WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}

/**
 * Select all users whose deleted_at tombstone has passed the 7-day grace period
 * and permanently remove them. Returns the count of accounts purged.
 */
export async function purgeDeletedAccounts(db: D1Database, now: number): Promise<number> {
  const cutoff = now - 7 * 24 * 3_600_000;

  const result = await db.prepare(
    "SELECT id FROM users WHERE deleted_at IS NOT NULL AND deleted_at <= ?"
  ).bind(cutoff).all<{ id: number }>();
  const rows = result.results ?? [];

  for (const row of rows) {
    await hardDeleteUser(db, row.id);
  }

  return rows.length;
}
