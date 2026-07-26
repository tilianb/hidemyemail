import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../app";
import {
  sha256Base64url,
  signAppAuthCode,
  signFreshAuth,
  signSession,
  timingSafeEqual,
  verifyAppAuthCode,
  verifyFreshAuth,
  verifySession,
} from "../../lib/auth";
import { consumeAuthArtifact, markFailedAttempt, rateLimitFailures } from "../../lib/auth-security";
import { clearAuthenticatedCookies } from "../auth-route-helpers";

const SESSION_TTL = 60 * 60 * 24 * 7;
const FRESH_AUTH_TTL = 60 * 10;
const APP_CALLBACK = "hidemyemail://auth";

export function appAuthRoutes() {
  const r = new Hono<AppEnv>();

  r.use("/exchange", rateLimitFailures());

  r.post("/authorize", async (c) => {
    const body = await c.req.parseBody();
    const challenge = typeof body.challenge === "string" ? body.challenge : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return c.json({ error: "Invalid challenge" }, 400);
    }

    const sessionCookie = getCookie(c, "__Host-session");
    const principal = sessionCookie ? await verifySession(c.env.SESSION_SECRET, sessionCookie) : null;
    if (principal === null) return c.json({ error: "Unauthorized" }, 401);

    const freshAuth = getCookie(c, "__Host-fresh-auth");
    if (!freshAuth || !(await verifyFreshAuth(c.env.SESSION_SECRET, freshAuth, principal.userId, principal.authVersion))) {
      clearAuthenticatedCookies(c);
      return c.redirect(`/app-auth?challenge=${encodeURIComponent(challenge)}`, 303);
    }

    const user = await c.env.DB.prepare("SELECT active, auth_version FROM users WHERE id = ?")
      .bind(principal.userId).first<{ active: number; auth_version: number }>();
    if (!user || user.active === 0) return c.json({ error: "Account is disabled" }, 403);
    if (user.auth_version !== principal.authVersion) return c.json({ error: "Unauthorized" }, 401);

    const code = await signAppAuthCode(c.env.SESSION_SECRET, principal.userId, principal.authVersion, challenge);
    return new Response(null, {
      status: 303,
      headers: { Location: `${APP_CALLBACK}?code=${encodeURIComponent(code)}` },
    });
  });

  r.post("/exchange", async (c) => {
    if (c.req.header("Origin")) return c.json({ error: "Forbidden" }, 403);

    const { code, verifier } = await c.req.json<{ code?: string; verifier?: string }>()
      .catch(() => ({ code: undefined, verifier: undefined }));
    if (!code || !verifier) return c.json({ error: "Missing code or verifier" }, 400);

    const parsed = await verifyAppAuthCode(c.env.SESSION_SECRET, code);
    if (!parsed || !timingSafeEqual(await sha256Base64url(verifier), parsed.challenge)) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid or expired code" }, 401);
    }

    const user = await c.env.DB.prepare("SELECT active, auth_version FROM users WHERE id = ?")
      .bind(parsed.userId).first<{ active: number; auth_version: number }>();
    if (!user || user.active === 0) return c.json({ error: "Account is disabled" }, 403);
    if (user.auth_version !== parsed.authVersion) return c.json({ error: "Unauthorized" }, 401);
    if (!(await consumeAuthArtifact(c.env.DB, code, Math.floor(Date.now() / 1000) + 120))) {
      return c.json({ error: "Invalid or expired code" }, 401);
    }

    const token = await signSession(c.env.SESSION_SECRET, parsed.userId, SESSION_TTL, parsed.authVersion);
    const freshAuth = await signFreshAuth(c.env.SESSION_SECRET, parsed.userId, FRESH_AUTH_TTL, parsed.authVersion);
    return c.json({ ok: true, userId: parsed.userId, token, fresh_auth: freshAuth });
  });

  return r;
}
