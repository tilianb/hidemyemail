import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../types";
import { verifySession } from "../lib/auth";
import { authRoutes } from "./routes/auth";

export type AppEnv = { Bindings: Env };

export function createApp() {
  const app = new Hono<AppEnv>();

  // public routes (no session)
  app.route("/api", authRoutes());

  // session guard for everything else under /api
  app.use("/api/*", async (c, next) => {
    const p = new URL(c.req.url).pathname;
    if (p === "/api/login" || p === "/api/logout" || p === "/api/ses/notification") return next();
    const token = getCookie(c, "session");
    if (!token || !(await verifySession(c.env.SESSION_SECRET, token))) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  // temporary guarded route so the auth test has an endpoint; replaced by real stats in Task 13
  app.get("/api/stats", (c) => c.json({ ok: true }));

  return app;
}
