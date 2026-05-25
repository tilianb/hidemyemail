import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../app";
import { verifyPassword, signSession } from "../../lib/auth";

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days

export function authRoutes() {
  const r = new Hono<AppEnv>();

  r.post("/login", async (c) => {
    const { password } = await c.req.json<{ password: string }>().catch(() => ({ password: "" }));
    const ok = await verifyPassword(password, c.env.AUTH_PASSWORD_SALT, c.env.AUTH_PASSWORD_HASH);
    if (!ok) return c.json({ error: "invalid" }, 401);
    const token = await signSession(c.env.SESSION_SECRET, SESSION_TTL);
    setCookie(c, "session", token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_TTL });
    return c.json({ ok: true });
  });

  r.post("/logout", (c) => {
    deleteCookie(c, "session", { path: "/" });
    return c.json({ ok: true });
  });

  return r;
}
