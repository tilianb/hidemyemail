import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { getCookie } from "hono/cookie";
import type { Env } from "../types";
import { verifySession } from "../lib/auth";
import { authRoutes } from "./routes/auth";
import { appAuthRoutes } from "./routes/app-auth";
import { domainRoutes } from "./routes/domains";
import { aliasRoutes } from "./routes/aliases";
import { blockRoutes } from "./routes/blocks";
import { statsRoutes } from "./routes/stats";
import { sesWebhookRoutes } from "./routes/ses-webhook";
import { sesInboundRoutes } from "./routes/ses-inbound";
import { unsubscribeRoutes } from "./routes/unsubscribe";
import { destinationRoutes, verificationRoute } from "./routes/destinations";
import { adminRoutes } from "./routes/admin";
import { settingsRoutes } from "./routes/settings";
import { accountRoutes } from "./routes/account";
import { pushRoutes } from "./routes/push";
import { v1Routes } from "./routes/v1";
import { apiKeyRoutes } from "./routes/api-keys";
import { nativeSecurityRoutes } from "./routes/native-security";
import { consumeAuthArtifact } from "../lib/auth-security";
import { verifySecurityHandoff } from "../lib/auth";
import { getAndroidAssociations, getRpFromOrigin } from "../lib/webauthn";
import { setAuthenticatedCookies } from "./auth-route-helpers";
import { getSetting } from "../lib/settings";
import { SETTING_DEFAULTS } from "../config";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    userId: number;
    authVersion: number;
    authSource: "cookie" | "bearer";
  };
};

const SECURITY_HANDOFF_PATTERN = /^security1\.\d+\.\d+\.\d+\.[a-f0-9]{32}\.[a-f0-9]{64}$/;

/**
 * Retrieves the authenticated user ID from a valid session cookie.
 *
 * @param c - The request context containing the session secret and user database
 * @returns The user ID if the session and account are valid, or `null` otherwise
 */
async function validCookieUser(c: Context<AppEnv>): Promise<number | null> {
  const token = getCookie(c, "__Host-session");
  if (!token) return null;
  const principal = await verifySession(c.env.SESSION_SECRET, token);
  if (!principal) return null;
  const user = await c.env.DB.prepare("SELECT active, deleted_at, auth_version FROM users WHERE id = ?")
    .bind(principal.userId).first<{ active: number; deleted_at: number | null; auth_version: number }>();
  return user?.active === 1 && user.deleted_at === null && user.auth_version === principal.authVersion
    ? principal.userId
    : null;
}

/**
 * Creates the Hono application with security middleware, CORS policies, authentication, and API routes.
 *
 * @returns The configured Hono application
 */
export function createApp() {
  const app = new Hono<AppEnv>();

  // Security headers
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    if (!c.res.headers.has("Referrer-Policy")) c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });

  // Two CORS policies, dispatched by path:
  //  - /api/v1/* (addy.io-compatible token API): any origin, NO credentials.
  //    It is called from browser extensions and third-party tools and is
  //    authenticated exclusively by Bearer API keys — never echo an
  //    arbitrary origin together with Allow-Credentials.
  //  - everything else (cookie-authenticated dashboard API): allowlisted
  //    origins from the cors_allowed_domains setting, with credentials.
  const v1Cors = cors({
    origin: (origin) => origin,
    allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    credentials: false,
  });
  const dashboardCors = cors({
    origin: async (origin, c) => {
      if (!origin) return "";
      // Read CORS allowed domains from DB settings (falls back to defaults)
      let domainsStr: string;
      try {
        domainsStr = await getSetting(c.env.DB, "cors_allowed_domains");
      } catch {
        domainsStr = SETTING_DEFAULTS.cors_allowed_domains ?? "";
      }
      const allowedOrigins = domainsStr.split(",").map(d => d.trim()).filter(Boolean);
      try {
        const url = new URL(origin);
        if (allowedOrigins.some(allowed => {
          if (allowed.includes("://")) return origin === allowed;
          return origin === `https://${allowed}` || origin === `http://${allowed}`;
        })) return origin;
      } catch (e) {}
      return "";
    },
    allowHeaders: ["Content-Type", "Cookie", "Authorization", "X-Auth-Mode"],
    credentials: true
  });
  app.use("*", (c, next) =>
    new URL(c.req.url).pathname.startsWith("/api/v1/") ? v1Cors(c, next) : dashboardCors(c, next)
  );

  // public routes (no session)
  app.route("/api", authRoutes());
  app.route("/api/app-auth", appAuthRoutes());
  app.route("/api", verificationRoute());
  app.route("/api", sesWebhookRoutes());
  app.route("/api", sesInboundRoutes());
  app.route("/api", unsubscribeRoutes());
  // addy.io-compatible API — authenticated by its own Bearer API-key
  // middleware (routes/v1.ts), never by session cookies.
  app.route("/api/v1", v1Routes());

  app.get("/security-handoff", async c => {
    const code = c.req.query("code");
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    if (!code || !SECURITY_HANDOFF_PATTERN.test(code)) return c.json({ error: "Invalid handoff" }, 401);
    const artifact = await verifySecurityHandoff(c.env.SESSION_SECRET, code);
    if (!artifact) return c.json({ error: "Invalid handoff" }, 401);
    try { getRpFromOrigin(c.env.APP_ORIGIN); }
    catch { return c.json({ error: "Invalid handoff" }, 401); }
    const user = await c.env.DB.prepare("SELECT active, deleted_at, auth_version FROM users WHERE id = ?")
      .bind(artifact.userId).first<{ active: number; deleted_at: number | null; auth_version: number }>();
    if (!user || user.active !== 1 || user.deleted_at !== null || user.auth_version !== artifact.authVersion) {
      return c.json({ error: "Invalid handoff" }, 401);
    }
    const cookieUser = await validCookieUser(c);
    if (cookieUser !== null && cookieUser !== artifact.userId) {
      return c.html("<!doctype html><title>Account mismatch</title><p>Sign out before continuing with another account.</p>", 409);
    }
    return c.html(`<!doctype html><title>Continue to Security settings</title><form method="post" action="/security-handoff"><input type="hidden" name="code" value="${code}"><button type="submit">Continue</button></form>`);
  });

  app.post("/security-handoff", async c => {
    let origin: string;
    try { origin = getRpFromOrigin(c.env.APP_ORIGIN).expectedOrigin; }
    catch { return c.json({ error: "Invalid handoff" }, 401); }
    if (c.req.header("Origin") !== origin) return c.json({ error: "Forbidden" }, 403);
    const body: Record<string, string | File> = await c.req.parseBody().catch(() => ({}));
    const code = body.code;
    if (typeof code !== "string" || !SECURITY_HANDOFF_PATTERN.test(code)) {
      return c.json({ error: "Invalid handoff" }, 401);
    }
    const artifact = await verifySecurityHandoff(c.env.SESSION_SECRET, code);
    if (!artifact) return c.json({ error: "Invalid handoff" }, 401);
    const cookieUser = await validCookieUser(c);
    if (cookieUser !== null && cookieUser !== artifact.userId) {
      return c.json({ error: "Account mismatch" }, 409);
    }
    const user = await c.env.DB.prepare("SELECT active, deleted_at, auth_version FROM users WHERE id = ?")
      .bind(artifact.userId).first<{ active: number; deleted_at: number | null; auth_version: number }>();
    if (!user || user.active !== 1 || user.deleted_at !== null || user.auth_version !== artifact.authVersion ||
        !(await consumeAuthArtifact(c.env.DB, code, artifact.expiresAt))) {
      return c.json({ error: "Invalid handoff" }, 401);
    }
    await setAuthenticatedCookies(c, artifact.userId, artifact.authVersion);
    return c.redirect(`${origin}/#settings`, 303);
  });

  // session guard for everything else under /api
  app.use("/api/*", async (c, next) => {
    const p = new URL(c.req.url).pathname;
    // /api/v1/* (mounted above, before this guard) authenticates with its own
    // API-key middleware — exempt the prefix here, belt-and-braces like the
    // public routes below.
    if (p.startsWith("/api/v1/")) return next();
    if (
      p === "/api/login" ||
      p === "/api/register" ||
      p === "/api/restore" ||
      p === "/api/logout" ||
      p === "/api/verify" ||
      p === "/api/ses/notification" ||
      p === "/api/ses/inbound" ||
      p === "/api/unsubscribe" ||
      // App-auth handoff: exchange is pre-auth by definition; authorize does
      // its own session + fresh-auth cookie checks inside the handler.
      p === "/api/app-auth/exchange" ||
      p === "/api/app-auth/authorize"
    ) return next();
    // Web clients send the HttpOnly __Host-session cookie; native clients send
    // the same signed session token as `Authorization: Bearer <token>`.
    let token = getCookie(c, "__Host-session");
    let authSource: "cookie" | "bearer" = "cookie";
    if (!token) {
      const authHeader = c.req.header("Authorization");
      if (authHeader?.startsWith("Bearer ")) {
        token = authHeader.slice(7).trim();
        authSource = "bearer";
      }
    }
    if (!token) return c.json({ error: "Unauthorized" }, 401);
    const principal = await verifySession(c.env.SESSION_SECRET, token);
    if (principal === null) return c.json({ error: "Unauthorized" }, 401);
    const user = await c.env.DB.prepare("SELECT active, deleted_at, auth_version FROM users WHERE id = ?")
      .bind(principal.userId).first<{ active: number; deleted_at: number | null; auth_version: number }>();
    if (user && user.auth_version !== principal.authVersion) return c.json({ error: "Unauthorized" }, 401);
    if (!user || user.active === 0) return c.json({ error: "Account is disabled" }, 403);
    if (user.deleted_at != null) return c.json({ error: "Account has been deleted" }, 403);
    c.set("userId", principal.userId);
    c.set("authVersion", principal.authVersion);
    c.set("authSource", authSource);
    return next();
  });

  // guarded routers (inherit the session guard above)
  app.route("/api", domainRoutes());
  app.route("/api", aliasRoutes());
  app.route("/api", statsRoutes());
  app.route("/api", blockRoutes());
  app.route("/api", destinationRoutes());
  app.route("/api/admin", adminRoutes());
  app.route("/api/settings", settingsRoutes());
  app.route("/api/account", accountRoutes());
  app.route("/api/push", pushRoutes());
  app.route("/api/settings", apiKeyRoutes());
  app.route("/api/settings", nativeSecurityRoutes());

  // Apple App Site Association — lets the iOS app claim `webcredentials` for
  // passkeys on this domain. Served by the Worker (not a static asset) so the
  // App ID stays configurable via the APPLE_APP_ID env var. Requires this path
  // in the assets `run_worker_first` list (see wrangler.jsonc).
  app.get("/.well-known/apple-app-site-association", (c) => {
    const appID = c.env.APPLE_APP_ID;
    if (!appID) return c.json({ error: "Not configured" }, 404);
    return c.json({ webcredentials: { apps: [appID] } });
  });

  app.get("/.well-known/assetlinks.json", c => {
    try {
      const { fingerprints } = getAndroidAssociations(c.env.ANDROID_APP_ORIGINS);
      if (!fingerprints.length) return c.json({ error: "Not configured" }, 404);
      return c.json([{
        relation: ["delegate_permission/common.get_login_creds"],
        target: { namespace: "android_app", package_name: "dev.hidemyemail.app", sha256_cert_fingerprints: fingerprints },
      }]);
    } catch {
      return c.json({ error: "Invalid configuration" }, 500);
    }
  });

  return app;
}
