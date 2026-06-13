import type { AliasRow } from "../types";

export async function getAlias(db: D1Database, fullAddress: string): Promise<AliasRow | null> {
  return db.prepare("SELECT * FROM aliases WHERE full_address = ?").bind(fullAddress).first<AliasRow>();
}

export async function getAliasById(db: D1Database, id: number): Promise<AliasRow | null> {
  return db.prepare("SELECT * FROM aliases WHERE id = ?").bind(id).first<AliasRow>();
}

export async function autoCreateAlias(
  db: D1Database, domainId: number, localPart: string, fullAddress: string, source = "auto"
): Promise<AliasRow | null> {
  const existing = await getAlias(db, fullAddress);
  if (existing) return existing;

  const dom = await db.prepare("SELECT user_id, default_destination FROM domains WHERE id = ?").bind(domainId).first<{ user_id: number, default_destination: string | null }>();
  if (!dom || !dom.default_destination) return null; // Do not auto-create if there is no default destination

  await db.prepare(
    "INSERT INTO aliases (domain_id, user_id, local_part, full_address, active, source, created_at) VALUES (?,?,?,?,1,?,?) " +
    "ON CONFLICT(full_address) DO NOTHING"
  ).bind(domainId, dom.user_id, localPart, fullAddress, source, Date.now()).run();
  return await getAlias(db, fullAddress);
}

export async function incCounter(db: D1Database, aliasId: number, col: "fwd_count" | "blocked_count" | "reply_count"): Promise<void> {
  await db.prepare(`UPDATE aliases SET ${col} = ${col} + 1, last_seen_at = ? WHERE id = ?`).bind(Date.now(), aliasId).run();
}

// Mute an alias until the given epoch-ms timestamp. Used by the distinct-recipient cap
// to force owner attention after a potential spam burst. The inbound path also enforces
// muted_until, so the alias goes quiet in both directions until the cooldown expires.
export async function muteAlias(db: D1Database, aliasId: number, until: number): Promise<void> {
  await db.prepare("UPDATE aliases SET muted_until = ? WHERE id = ?").bind(until, aliasId).run();
}
