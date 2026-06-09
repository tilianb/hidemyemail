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
    allowHeaders: ["Content-Type", "Cookie"],
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
    if (
      p === "/api/login" ||
      p === "/api/register" ||
      p === "/api/restore" ||
      p === "/api/logout" ||
      p === "/api/verify" ||
      p === "/api/ses/notification" ||
      p === "/api/ses/inbound" ||
      p === "/api/unsubscribe"
    ) return next();
    const token = getCookie(c, "__Host-session");
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

  return app;
}
