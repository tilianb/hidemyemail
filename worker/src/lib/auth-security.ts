import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../api/app";
import { sha256Base64url } from "./auth";

const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 3600;

export function sourceIp(c: Context<AppEnv>): string {
  if (c.env.ENVIRONMENT === "self-hosted") {
    // The self-hosted wrapper must replace this header at its trusted
    // socket/proxy boundary. Never fall back to caller-controlled forwarding headers.
    return c.req.header("x-hidemyemail-client-ip") || "unknown";
  }
  return c.req.header("cf-connecting-ip") || "unknown";
}

const FAILURE_MARKER = "X-HideMyEmail-Auth-Failure";

async function reserveAttempt(ip: string, db: D1Database): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  const resetAt = now + WINDOW_SECONDS;
  const result = await db.prepare(
    "INSERT INTO rate_limits (ip, attempts, reset_at) VALUES (?, 1, ?) " +
    "ON CONFLICT(ip) DO UPDATE SET attempts = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.attempts + 1 END, " +
    "reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END " +
    "WHERE rate_limits.reset_at <= ? OR rate_limits.attempts < ? RETURNING reset_at"
  ).bind(ip, resetAt, now, now, now, MAX_ATTEMPTS).first<{ reset_at: number }>();
  return result?.reset_at ?? null;
}

async function refundAttempt(ip: string, resetAt: number, db: D1Database): Promise<void> {
  await db.prepare(
    "UPDATE rate_limits SET attempts = MAX(attempts - 1, 0) WHERE ip = ? AND reset_at = ?"
  ).bind(ip, resetAt).run();
}

export function markFailedAttempt(c: Context<AppEnv>): void {
  c.header(FAILURE_MARKER, "1");
}

export function rateLimitFailures(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ip = sourceIp(c);
    const resetAt = await reserveAttempt(ip, c.env.DB);
    if (resetAt === null) return c.json({ error: "Too many attempts" }, 429);
    let routeError: unknown;
    let routeThrew = false;
    try {
      await next();
    } catch (error) {
      routeError = error;
      routeThrew = true;
    } finally {
      const charged = c.res.headers.get(FAILURE_MARKER) === "1";
      c.res.headers.delete(FAILURE_MARKER);
      if (!charged) {
        try {
          await refundAttempt(ip, resetAt, c.env.DB);
        } catch {
          // Cleanup is best-effort: leaking DB details or replacing a route error
          // is worse than conservatively retaining one rate-limit reservation.
        }
      }
    }
    if (routeThrew) throw routeError;
  };
}

export async function consumeAuthArtifact(db: D1Database, token: string, expiresAt: number): Promise<boolean> {
  const hash = await sha256Base64url(token);
  const now = Math.floor(Date.now() / 1000);
  const results = await db.batch([
    db.prepare("DELETE FROM consumed_auth_artifacts WHERE expires_at <= ?").bind(now),
    db.prepare("INSERT OR IGNORE INTO consumed_auth_artifacts (artifact_hash, expires_at) VALUES (?, ?)").bind(hash, expiresAt),
  ]);
  return results[1]?.meta.changes === 1;
}
