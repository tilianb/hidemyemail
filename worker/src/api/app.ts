import { Hono } from "hono";
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

export type AppEnv = { Bindings: Env };

export function createApp() {
  const app = new Hono<AppEnv>();

  // public routes (no session)
  app.route("/api", authRoutes());
  app.route("/api", sesWebhookRoutes());
  app.route("/api", sesInboundRoutes());

  // session guard for everything else under /api
  app.use("/api/*", async (c, next) => {
    const p = new URL(c.req.url).pathname;
    if (
      p === "/api/login" ||
      p === "/api/logout" ||
      p === "/api/ses/notification" ||
      p === "/api/ses/inbound"
    ) return next();
    const token = getCookie(c, "session");
    if (!token || !(await verifySession(c.env.SESSION_SECRET, token))) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  // guarded routers (inherit the session guard above)
  app.route("/api", domainRoutes());
  app.route("/api", aliasRoutes());
  app.route("/api", blockRoutes());
  app.route("/api", statsRoutes());

  return app;
}
