import type { ReverseRow } from "../types";

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
