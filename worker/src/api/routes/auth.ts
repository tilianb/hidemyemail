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
      const user = await c.env.DB.prepare(
      "SELECT id, active FROM users WHERE passphrase_hash = ?"
    ).bind(hash).first<{ id: number; active: number }>();

    if (!user) {
      return c.json({ error: "Invalid passphrase" }, 401);
    }
    if (user.active === 0) {
      return c.json({ error: "Account is disabled" }, 403);
    }
    userId = user.id;
    }

    if (!userId) return c.json({ error: "invalid" }, 401);
    
    // NOTE: We intentionally do NOT reset rate limits on success.
    // Resetting would allow an attacker who knows one valid password
    // to get unlimited brute-force attempts on other accounts.

    const token = await signSession(c.env.SESSION_SECRET, userId, SESSION_TTL);
    setCookie(c, "__Host-session", token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_TTL });
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
      setCookie(c, "__Host-session", token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_TTL });
      return c.json({ ok: true, userId });
    } catch (err: any) {
      if (err.message && err.message.includes("UNIQUE constraint failed")) {
        return c.json({ error: "already exists" }, 409);
      }
      return c.json({ error: "internal error" }, 500);
    }
  });

  r.post("/logout", (c) => {
    deleteCookie(c, "__Host-session", { path: "/", secure: true });
    return c.json({ ok: true });
  });

  r.post("/recover/send-code", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || "unknown";
    if (!(await checkRateLimit(ip, c.env.DB))) {
      return c.json({ error: "too many attempts" }, 429);
    }

    const { token } = await c.req.json<{ token: string }>().catch(() => ({ token: "" }));
    if (!token) return c.json({ error: "invalid request" }, 400);

    const db = c.env.DB;
    const user = await db.prepare(
      "SELECT id FROM users WHERE recovery_token = ? AND recovery_expires_at > ? AND active = 1"
    ).bind(token, Date.now()).first<{ id: number }>();

    if (!user) return c.json({ error: "Invalid or expired recovery token" }, 400);

    const dest = await db.prepare("SELECT email FROM destinations WHERE user_id = ? AND is_default = 1").bind(user.id).first<{ email: string }>();
    if (!dest) return c.json({ error: "User has no default destination email" }, 400);

    const { decryptDestination } = await import("../../lib/crypto");
    const { sendRaw } = await import("../../lib/ses");
    const { buildMfaEmail } = await import("../../lib/emails");

    const email = await decryptDestination(dest.email, c.env.DESTINATION_ENCRYPTION_KEY);
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    await db.prepare("UPDATE users SET recovery_mfa_code = ? WHERE id = ?").bind(code, user.id).run();

    if (c.env.SES_ACCESS_KEY_ID && c.env.SES_SECRET_ACCESS_KEY && c.env.SES_REGION) {
      await sendRaw({
        accessKeyId: c.env.SES_ACCESS_KEY_ID,
        secretAccessKey: c.env.SES_SECRET_ACCESS_KEY,
        region: c.env.SES_REGION
      }, {
        from: "HideMyEmail <noreply@hidemyemail.dev>",
        to: email,
        rawBase64: buildMfaEmail(email, code)
      });
    }

    return c.json({ ok: true });
  });

  r.post("/recover/verify", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || "unknown";
    if (!(await checkRateLimit(ip, c.env.DB))) {
      return c.json({ error: "too many attempts" }, 429);
    }

    const { token, code } = await c.req.json<{ token: string; code: string }>().catch(() => ({ token: "", code: "" }));
    if (!token || !code) return c.json({ error: "invalid request" }, 400);

    const db = c.env.DB;
    const user = await db.prepare(
      "SELECT id FROM users WHERE recovery_token = ? AND recovery_mfa_code = ? AND recovery_expires_at > ? AND active = 1"
    ).bind(token, code, Date.now()).first<{ id: number }>();

    if (!user) return c.json({ error: "Invalid token or code" }, 400);

    const { generatePassphrase } = await import("../../lib/passphrase");
    const newPassphrase = generatePassphrase();
    const hash = await derivePassphraseHash(newPassphrase, c.env.AUTH_PASSWORD_SALT);
    
    await db.prepare(
      "UPDATE users SET passphrase_hash = ?, recovery_token = NULL, recovery_expires_at = NULL, recovery_mfa_code = NULL WHERE id = ?"
    ).bind(hash, user.id).run();

    // Log them in immediately
    const sessionId = await signSession(c.env.SESSION_SECRET, user.id, SESSION_TTL);
    setCookie(c, "__Host-session", sessionId, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_TTL });
    
    return c.json({ ok: true, passphrase: newPassphrase });
  });

  return r;
}
