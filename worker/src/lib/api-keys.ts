/**
 * API keys for the addy.io-compatible /api/v1 surface.
 *
 * Tokens look like `hme_<48 hex chars>` and are shown exactly once at
 * creation. Only the SHA-256 hex of the full token is stored; lookups hash
 * the presented token and match on the unique token_hash column.
 */

const TOKEN_PREFIX = "hme_";

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

export function generateApiToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return TOKEN_PREFIX + toHex(bytes);
}

/** The displayable prefix stored alongside the hash (e.g. "hme_ab12…"). */
export function tokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX.length + 4);
}

export interface ApiKeyAuth {
  keyId: number;
  keyName: string;
  keyCreatedAt: number;
  userId: number;
}

/**
 * Resolve a presented bearer token to a user. Returns null for unknown
 * tokens and for keys whose owner is disabled or tombstoned. Touches
 * last_used_at on success.
 */
export async function authenticateApiKey(db: D1Database, token: string): Promise<ApiKeyAuth | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const hash = await sha256Hex(token);
  const row = await db.prepare(
    "SELECT k.id, k.name, k.created_at, k.user_id, u.active, u.deleted_at " +
    "FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.token_hash = ?"
  ).bind(hash).first<{ id: number; name: string; created_at: number; user_id: number; active: number; deleted_at: number | null }>();
  if (!row || row.active === 0 || row.deleted_at != null) return null;
  await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(Date.now(), row.id).run();
  return { keyId: row.id, keyName: row.name, keyCreatedAt: row.created_at, userId: row.user_id };
}
