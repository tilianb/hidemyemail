export type IdentifierKind = "alias" | "subdomain";

/** The insert triggers make the permanent claim atomically with creation. */
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
