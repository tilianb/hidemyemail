import type { AliasRow, DomainRow, EventType, ReverseRow, BlockRow } from "../types";
import { decryptDestination } from "../lib/crypto";

export async function createDomain(db: D1Database, domain: string, dest: string): Promise<number> {
  const r = await db.prepare(
    "INSERT INTO domains (domain, default_destination, active, created_at) VALUES (?,?,1,?) RETURNING id"
  ).bind(domain, dest, Date.now()).first<{ id: number }>();
  return r!.id;
}

export async function getDomain(db: D1Database, domain: string): Promise<DomainRow | null> {
  return db.prepare("SELECT * FROM domains WHERE domain = ?").bind(domain).first<DomainRow>();
}

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



export async function upsertReverse(
  db: D1Database, aliasId: number, externalSender: string, token: string
): Promise<ReverseRow> {
  await db.prepare(
    "INSERT INTO reverse_map (token, alias_id, external_sender, created_at) VALUES (?,?,?,?) " +
    "ON CONFLICT(alias_id, external_sender) DO NOTHING"
  ).bind(token, aliasId, externalSender, Date.now()).run();
  return (await db.prepare("SELECT * FROM reverse_map WHERE alias_id = ? AND external_sender = ?")
    .bind(aliasId, externalSender).first<ReverseRow>())!;
}

export async function getReverseByToken(db: D1Database, token: string): Promise<ReverseRow | null> {
  return db.prepare("SELECT * FROM reverse_map WHERE token = ?").bind(token).first<ReverseRow>();
}

export async function touchReverse(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE reverse_map SET last_used_at = ? WHERE id = ?").bind(Date.now(), id).run();
}

export async function listBlocks(db: D1Database, aliasId: number, userId: number): Promise<BlockRow[]> {
  const r = await db.prepare("SELECT * FROM blocks WHERE alias_id = ? OR (alias_id IS NULL AND user_id = ?)").bind(aliasId, userId).all<BlockRow>();
  return r.results ?? [];
}

export async function insertEvent(
  db: D1Database,
  e: { alias_id?: number | null; type: EventType; external_sender?: string; subject?: string; bytes?: number; detail?: string; ts: number }
): Promise<void> {
  await db.prepare(
    "INSERT INTO events (alias_id, type, external_sender, subject, bytes, detail, ts) VALUES (?,?,?,?,?,?,?)"
  ).bind(e.alias_id ?? null, e.type, e.external_sender ?? null, e.subject ?? null, e.bytes ?? null, e.detail ?? null, e.ts).run();
}

export async function countEventsSince(db: D1Database, aliasId: number | null, since: number): Promise<number> {
  const sql = aliasId == null
    ? "SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND type IN ('forward','reply')"
    : "SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND alias_id = ? AND type IN ('forward','reply')";
  const stmt = aliasId == null ? db.prepare(sql).bind(since) : db.prepare(sql).bind(since, aliasId);
  const r = await stmt.first<{ n: number }>();
  return r?.n ?? 0;
}

export async function incCounter(db: D1Database, aliasId: number, col: "fwd_count" | "blocked_count" | "reply_count"): Promise<void> {
  await db.prepare(`UPDATE aliases SET ${col} = ${col} + 1, last_seen_at = ? WHERE id = ?`).bind(Date.now(), aliasId).run();
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
