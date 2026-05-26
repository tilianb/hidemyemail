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
import { destinationRoutes, verificationRoute } from "./routes/destinations";

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
    origin: (origin) => {
      const allowed = [
        "https://hidemyemail.dev",
        "http://localhost:5173",
      ];
      return allowed.includes(origin) ? origin : "";
    },
    allowHeaders: ["Content-Type", "Cookie"],
    credentials: true
  }));

  // public routes (no session)
  app.route("/api", authRoutes());
  app.route("/api", verificationRoute());
  app.route("/api", sesWebhookRoutes());
  app.route("/api", sesInboundRoutes());

  // session guard for everything else under /api
  app.use("/api/*", async (c, next) => {
    const p = new URL(c.req.url).pathname;
    if (
      p === "/api/login" ||
      p === "/api/register" ||
      p === "/api/logout" ||
      p === "/api/verify" ||
      p === "/api/ses/notification" ||
      p === "/api/ses/inbound"
    ) return next();
    const token = getCookie(c, "__Host-session");
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const userId = await verifySession(c.env.SESSION_SECRET, token);
    if (userId === null) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", userId);
    return next();
  });

  // guarded routers (inherit the session guard above)
  app.route("/api", domainRoutes());
  app.route("/api", aliasRoutes());
  app.route("/api", statsRoutes());
  app.route("/api", blockRoutes());
  app.route("/api", destinationRoutes());

  return app;
}
