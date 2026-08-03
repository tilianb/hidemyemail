import { sha256Base64url } from "./auth";

export async function isSessionRevoked(db: D1Database, token: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const hash = await sha256Base64url(token);
  const row = await db.prepare("SELECT 1 AS revoked FROM revoked_sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(hash, now).first();
  return !!row;
}

export async function revokeSession(db: D1Database, token: string, expiresAt: number): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO revoked_sessions (token_hash, expires_at, revoked_at) VALUES (?, ?, ?)")
    .bind(await sha256Base64url(token), expiresAt, Date.now()).run();
}
