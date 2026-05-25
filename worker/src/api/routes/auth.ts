import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../app";
import { verifyPassword, signSession, derivePassphraseHash } from "../../lib/auth";

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days

async function checkRateLimit(ip: string, db: D1Database): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare("SELECT attempts, reset_at FROM rate_limits WHERE ip = ?").bind(ip).first<{ attempts: number, reset_at: number }>();
  
  if (row) {
    if (now > row.reset_at) {
      await db.prepare("UPDATE rate_limits SET attempts = 1, reset_at = ? WHERE ip = ?").bind(now + 3600, ip).run();
      return true;
    }
    if (row.attempts >= 10) return false;
    await db.prepare("UPDATE rate_limits SET attempts = attempts + 1 WHERE ip = ?").bind(ip).run();
    return true;
  }
  
  await db.prepare("INSERT INTO rate_limits (ip, attempts, reset_at) VALUES (?, 1, ?)").bind(ip, now + 3600).run();
  return true;
}

export function authRoutes() {
  const r = new Hono<AppEnv>();

  r.post("/login", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || "unknown";
    if (!(await checkRateLimit(ip, c.env.DB))) {
      return c.json({ error: "too many attempts" }, 429);
    }

    const { password } = await c.req.json<{ password: string }>().catch(() => ({ password: "" }));
    
    let userId: number | null = null;
    
    // Check if it's the admin
    const isAdmin = await verifyPassword(password, c.env.AUTH_PASSWORD_SALT, c.env.AUTH_PASSWORD_HASH);
    if (isAdmin) {
      userId = 1;
    } else {
      // Check for a regular user
      const hash = await derivePassphraseHash(password, c.env.AUTH_PASSWORD_SALT);
      const user = await c.env.DB.prepare("SELECT id FROM users WHERE passphrase_hash = ?").bind(hash).first<{ id: number }>();
      if (user) {
        userId = user.id;
      }
    }

    if (!userId) return c.json({ error: "invalid" }, 401);
    
    // Success, reset rate limits for this IP
    await c.env.DB.prepare("DELETE FROM rate_limits WHERE ip = ?").bind(ip).run();

    const token = await signSession(c.env.SESSION_SECRET, userId, SESSION_TTL);
    setCookie(c, "session", token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_TTL });
    return c.json({ ok: true, userId });
  });

  r.post("/register", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || "unknown";
    if (!(await checkRateLimit(ip, c.env.DB))) {
      return c.json({ error: "too many attempts" }, 429);
    }

    const { password } = await c.req.json<{ password: string }>().catch(() => ({ password: "" }));
    if (!password || password.length < 16) {
      return c.json({ error: "passphrase too weak" }, 400);
    }

    const hash = await derivePassphraseHash(password, c.env.AUTH_PASSWORD_SALT);
    
    try {
      const res = await c.env.DB.prepare(
        "INSERT INTO users (passphrase_hash, created_at) VALUES (?, ?)"
      ).bind(hash, Date.now()).run();
      
      const userId = res.meta.last_row_id;
      const token = await signSession(c.env.SESSION_SECRET, userId, SESSION_TTL);
      setCookie(c, "session", token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_TTL });
      return c.json({ ok: true, userId });
    } catch (err: any) {
      if (err.message && err.message.includes("UNIQUE constraint failed")) {
        return c.json({ error: "already exists" }, 409);
      }
      return c.json({ error: "internal error" }, 500);
    }
  });

  r.post("/logout", (c) => {
    deleteCookie(c, "session", { path: "/" });
    return c.json({ ok: true });
  });

  return r;
}
