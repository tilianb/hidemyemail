import { Hono } from "hono";
import { cors } from "hono/cors";
import { getCookie } from "hono/cookie";
import type { Env } from "../types";
import { verifySession } from "../lib/auth";
import { authRoutes } from "./routes/auth";
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
import { getSetting } from "../lib/settings";
import { SETTING_DEFAULTS } from "../config";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    userId: number;
  };
};

export function createApp() {
  const app = new Hono<AppEnv>();

  // Security headers
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });

  app.use("*", cors({
    origin: async (origin, c) => {
      if (!origin) return "";
      // The addy.io-compatible token API is meant to be called from browser
      // extensions and third-party tools — allow any origin there. It never
      // uses cookies (Bearer API keys only), so this widens nothing else.
      if (new URL(c.req.url).pathname.startsWith("/api/v1/")) return origin;
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
    allowHeaders: ["Content-Type", "Cookie", "Authorization", "X-Auth-Mode", "X-Requested-With"],
    credentials: true
  }));

  // public routes (no session)
  app.route("/api", authRoutes());
  app.route("/api", verificationRoute());
  app.route("/api", sesWebhookRoutes());
  app.route("/api", sesInboundRoutes());
  app.route("/api", unsubscribeRoutes());

  // session guard for everything else under /api
  app.use("/api/*", async (c, next) => {
    const p = new URL(c.req.url).pathname;
    // /api/v1/* is the addy.io-compatible surface — authenticated by its own
    // API-key middleware (routes/v1.ts), never by session cookies.
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
      // App-auth handoff: exchange is pre-auth by definition; code does its
      // own session-cookie check inside the handler.
      p === "/api/app-auth/exchange" ||
      p === "/api/app-auth/code"
    ) return next();
    // Web clients send the HttpOnly __Host-session cookie; native clients send
    // the same signed session token as `Authorization: Bearer <token>`.
    let token = getCookie(c, "__Host-session");
    if (!token) {
      const authHeader = c.req.header("Authorization");
      if (authHeader?.startsWith("Bearer ")) token = authHeader.slice(7).trim();
    }
    if (!token) return c.json({ error: "Unauthorized" }, 401);
    const userId = await verifySession(c.env.SESSION_SECRET, token);
    if (userId === null) return c.json({ error: "Unauthorized" }, 401);
    const user = await c.env.DB.prepare("SELECT active, deleted_at FROM users WHERE id = ?")
      .bind(userId).first<{ active: number; deleted_at: number | null }>();
    if (!user || user.active === 0) return c.json({ error: "Account is disabled" }, 403);
    if (user.deleted_at != null) return c.json({ error: "Account has been deleted" }, 403);
    c.set("userId", userId);
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
  // addy.io-compatible API (Bearer API keys — see routes/v1.ts)
  app.route("/api/v1", v1Routes());

  // Apple App Site Association — lets the iOS app claim `webcredentials` for
  // passkeys on this domain. Served by the Worker (not a static asset) so the
  // App ID stays configurable via the APPLE_APP_ID env var. Requires this path
  // in the assets `run_worker_first` list (see wrangler.jsonc).
  app.get("/.well-known/apple-app-site-association", (c) => {
    const appID = c.env.APPLE_APP_ID;
    if (!appID) return c.json({ error: "Not configured" }, 404);
    return c.json({ webcredentials: { apps: [appID] } });
  });

  return app;
}
