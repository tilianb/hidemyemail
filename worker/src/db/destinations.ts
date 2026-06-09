import type { DestinationRow } from "../types";
import { decryptDestination } from "../lib/crypto";

export async function findDestinationsByHash(db: D1Database, emailHash: string): Promise<DestinationRow[]> {
  const r = await db.prepare(
    "SELECT * FROM destinations WHERE email_hash = ?"
  ).bind(emailHash).all<DestinationRow>();
  return r.results ?? [];
}

export async function suppressDestination(
  db: D1Database,
  id: number,
  reason: string,
  suppressionClass: string,
  ts: number
): Promise<boolean> {
  // Single conditional UPDATE so concurrent SNS deliveries for the same
  // destination cannot both observe an unsuppressed row and both fire a
  // notification. We suppress when the row is not yet suppressed, OR when a
  // hard signal arrives for a currently-soft suppression (upgrade soft → hard).
  // `meta.changes` tells us whether this call was the one that changed state.
  const r = await db.prepare(
    "UPDATE destinations SET suppressed_at = ?, suppression_reason = ?, suppression_class = ? " +
    "WHERE id = ? AND (suppressed_at IS NULL OR (suppression_class = 'soft' AND ? = 'hard'))"
  ).bind(ts, reason, suppressionClass, id, suppressionClass).run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function clearSuppression(db: D1Database, id: number): Promise<void> {
  await db.prepare(
    "UPDATE destinations SET suppressed_at = NULL, suppression_reason = NULL, suppression_class = NULL WHERE id = ?"
  ).bind(id).run();
}

export async function getDestinationByEmail(db: D1Database, emailHash: string, userId: number): Promise<DestinationRow | null> {
  return db.prepare(
    "SELECT * FROM destinations WHERE email_hash = ? AND user_id = ?"
  ).bind(emailHash, userId).first<DestinationRow>();
}

export async function ownerDestinations(db: D1Database, userId: number, key: string): Promise<Set<string>> {
  // The reply gate treats these addresses as "the user's own mailboxes". Scope
  // strictly to rows this user owns — domains' default destinations, alias
  // overrides, and the user's verified destinations. The user's is_default
  // destination (used by aliases on shared global domains) lives in the
  // destinations table, so global-domain replies still resolve without pulling
  // OTHER tenants' addresses in via `is_global` — which previously let anyone
  // aligned as a global domain's default destination relay through every
  // tenant's alias.
  const [a, b, c] = await Promise.all([
    db.prepare("SELECT default_destination AS d FROM domains WHERE user_id = ?").bind(userId).all<{ d: string }>(),
    db.prepare("SELECT DISTINCT destination AS d FROM aliases WHERE destination IS NOT NULL AND user_id = ?").bind(userId).all<{ d: string }>(),
    db.prepare("SELECT email AS d FROM destinations WHERE user_id = ?").bind(userId).all<{ d: string }>(),
  ]);

  const decrypted = new Set<string>();
  for (const x of [...(a.results ?? []), ...(b.results ?? []), ...(c.results ?? [])]) {
    if (x.d) {
      decrypted.add((await decryptDestination(x.d, key)).toLowerCase());
    }
  }
  return decrypted;
}
