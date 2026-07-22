export type IdentifierKind = "alias" | "subdomain";

export async function canUseIdentifier(
  db: D1Database,
  kind: IdentifierKind,
  value: string,
  userId: number,
): Promise<boolean> {
  const reservation = await db.prepare(
    "SELECT user_id FROM identifier_reservations WHERE kind = ? AND value = ?"
  ).bind(kind, value.toLowerCase()).first<{ user_id: number }>();
  return !reservation || reservation.user_id === userId;
}

/** Claim an identifier and create its entity in one D1 transaction. */
export async function reserveIdentifierAndRun<T>(
  db: D1Database,
  kind: IdentifierKind,
  value: string,
  userId: number,
  statement: D1PreparedStatement,
): Promise<T | null> {
  const claim = db.prepare(
    "INSERT INTO identifier_reservations (kind, value, user_id, created_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(kind, value) DO UPDATE SET user_id = CASE " +
    "WHEN identifier_reservations.user_id = excluded.user_id THEN identifier_reservations.user_id ELSE NULL END"
  ).bind(kind, value.toLowerCase(), userId, Date.now());
  const results = await db.batch<T>([claim, statement]);
  return results[1]?.results?.[0] ?? null;
}

export function isIdentifierReservationError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("identifier_reservations.user_id");
}
