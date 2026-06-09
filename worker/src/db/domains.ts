import type { DomainRow } from "../types";

export async function createDomain(db: D1Database, domain: string, dest: string): Promise<number> {
  const r = await db.prepare(
    "INSERT INTO domains (domain, default_destination, active, created_at) VALUES (?,?,1,?) RETURNING id"
  ).bind(domain, dest, Date.now()).first<{ id: number }>();
  return r!.id;
}

export async function getDomain(db: D1Database, domain: string): Promise<DomainRow | null> {
  return db.prepare("SELECT * FROM domains WHERE domain = ?").bind(domain).first<DomainRow>();
}
