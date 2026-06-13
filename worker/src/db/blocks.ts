import type { BlockRow } from "../types";

export async function listBlocks(db: D1Database, aliasId: number, domainId: number, userId: number): Promise<BlockRow[]> {
  // Rules in scope for one alias: alias-specific, subdomain-wide, or user-wide.
  // The subdomain and user-wide branches are pinned to user_id so a rule can
  // never leak across users that happen to share a domain id.
  const r = await db.prepare(
    "SELECT * FROM blocks WHERE alias_id = ? OR (domain_id = ? AND user_id = ?) OR (alias_id IS NULL AND domain_id IS NULL AND user_id = ?)"
  ).bind(aliasId, domainId, userId, userId).all<BlockRow>();
  return r.results ?? [];
}
