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
  try {
    const current = await db.prepare(
      "SELECT suppressed_at FROM destinations WHERE id = ?"
    ).bind(id).first<{ suppressed_at: number | null }>();
    await db.prepare(
      "UPDATE destinations SET suppressed_at = ?, suppression_reason = ?, suppression_class = ? WHERE id = ?"
    ).bind(ts, reason, suppressionClass, id).run();
    return !current?.suppressed_at;
  } catch (err: any) {
    if (String(err?.message ?? err).includes("no such column")) return false;
    throw err;
  }
}

export async function clearSuppression(db: D1Database, id: number): Promise<void> {
  try {
    await db.prepare(
      "UPDATE destinations SET suppressed_at = NULL, suppression_reason = NULL, suppression_class = NULL WHERE id = ?"
    ).bind(id).run();
  } catch (err: any) {
    if (String(err?.message ?? err).includes("no such column")) return;
    throw err;
  }
}

export async function getDestinationByEmail(db: D1Database, emailHash: string, userId: number): Promise<DestinationRow | null> {
  return db.prepare(
    "SELECT * FROM destinations WHERE email_hash = ? AND user_id = ?"
  ).bind(emailHash, userId).first<DestinationRow>();
}

export async function ownerDestinations(db: D1Database, userId: number, key: string): Promise<Set<string>> {
  const a = await db.prepare("SELECT default_destination AS d FROM domains WHERE user_id = ? OR is_global = 1").bind(userId).all<{ d: string }>();
  const b = await db.prepare("SELECT DISTINCT destination AS d FROM aliases WHERE destination IS NOT NULL AND user_id = ?").bind(userId).all<{ d: string }>();

  const decrypted = new Set<string>();
  for (const x of [...(a.results ?? []), ...(b.results ?? [])]) {
    if (x.d) {
      decrypted.add((await decryptDestination(x.d, key)).toLowerCase());
    }
  }
  return decrypted;
}
