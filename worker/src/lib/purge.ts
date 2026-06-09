/**
 * Hard-delete helpers for account purge.
 *
 * hardDeleteUser  — full manual cascade for a single user id.
 * purgeDeletedAccounts — select tombstoned users past the 7-day window and hard-delete each.
 */

/**
 * Permanently delete a user and all their owned rows, in child-before-parent order.
 * Mirrors the cascade in admin.ts DELETE /users/:id, extended to cover mfa and
 * passkey_credentials.
 */
export async function hardDeleteUser(db: D1Database, userId: number): Promise<void> {
  // 1. Per-destination and per-alias children
  await db.prepare(
    "DELETE FROM events WHERE detail IN (SELECT 'dest:' || id FROM destinations WHERE user_id = ?)"
  ).bind(userId).run();
  await db.prepare(
    "DELETE FROM events WHERE alias_id IN (SELECT id FROM aliases WHERE user_id = ?)"
  ).bind(userId).run();
  await db.prepare(
    "DELETE FROM reverse_map WHERE alias_id IN (SELECT id FROM aliases WHERE user_id = ?)"
  ).bind(userId).run();

  // 2. Top-level owned rows
  await db.prepare("DELETE FROM aliases WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM blocks WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM destinations WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM domains WHERE user_id = ?").bind(userId).run();

  // 3. MFA (table added by migration 0005 — tolerate missing table)
  await db.prepare("DELETE FROM mfa WHERE user_id = ?").bind(userId).run()
    .catch((err: unknown) => {
      if (err instanceof Error && err.message.includes("no such table")) return;
      throw err;
    });

  // 4. Passkey credentials (table added by migration 0006 — tolerate missing table)
  await db.prepare("DELETE FROM passkey_credentials WHERE user_id = ?").bind(userId).run()
    .catch((err: unknown) => {
      if (err instanceof Error && err.message.includes("no such table")) return;
      throw err;
    });

  // 5. The user row itself
  await db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
}

/**
 * Select all users whose deleted_at tombstone has passed the 7-day grace period
 * and permanently remove them. Returns the count of accounts purged.
 *
 * Wraps the deleted_at column access in a try/catch so a pre-migration DB
 * (missing the column) returns 0 rather than throwing, mirroring the pattern
 * used in suppressDestination / clearSuppression in queries.ts.
 */
export async function purgeDeletedAccounts(db: D1Database, now: number): Promise<number> {
  const cutoff = now - 7 * 24 * 3_600_000;

  let rows: { id: number }[];
  try {
    const result = await db.prepare(
      "SELECT id FROM users WHERE deleted_at IS NOT NULL AND deleted_at <= ?"
    ).bind(cutoff).all<{ id: number }>();
    rows = result.results ?? [];
  } catch (err: unknown) {
    if (String((err as any)?.message ?? err).includes("no such column")) return 0;
    throw err;
  }

  for (const row of rows) {
    await hardDeleteUser(db, row.id);
  }

  return rows.length;
}
