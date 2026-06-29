import { Hono } from "hono";
import type { AppEnv } from "../app";
import * as q from "../../db/queries";
import type { PushPrefs } from "../../db/push";
import { sendTestPush } from "../../lib/push";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// Device registration + per-device notification preferences for native push.
// All routes inherit the session guard in app.ts, so `userId` is always set.

function parsePrefs(input: any): Partial<PushPrefs> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: Partial<PushPrefs> = {};
  for (const k of ["blocked", "bounce", "forward", "reply"] as const) {
    if (typeof input[k] === "boolean") out[k] = input[k];
  }
  return Object.keys(out).length ? out : undefined;
}

export function pushRoutes() {
  const r = new Hono<AppEnv>();

  // List this user's registered devices and their prefs.
  r.get("/devices", async (c) => {
    const userId = c.get("userId");
    const rows = await q.listPushDevices(c.env.DB, userId);
    return c.json(rows.map((d) => ({
      token: d.token,
      platform: d.platform,
      prefs: {
        blocked: d.notify_blocked === 1,
        bounce: d.notify_bounce === 1,
        forward: d.notify_forward === 1,
        reply: d.notify_reply === 1,
      },
      created_at: d.created_at,
      last_seen_at: d.last_seen_at,
    })));
  });

  // Register or refresh a device token. Idempotent on token.
  r.post("/devices", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json<{ token?: string; platform?: string; prefs?: any }>().catch(() => ({} as { token?: string; platform?: string; prefs?: any }));
    const token = (body.token ?? "").trim().toLowerCase();
    if (!token) return c.json({ error: "Missing token" }, 400);
    // Reject malformed tokens so a buggy/abusive client can't seed the table
    // with junk that fans out (and is kept) on every dispatch.
    if (!q.isValidApnsToken(token)) return c.json({ error: "Invalid token" }, 400);
    const platform = (body.platform ?? "ios").trim() || "ios";
    await q.upsertPushDevice(c.env.DB, userId, token, platform, parsePrefs(body.prefs), Date.now());
    await q.enforceDeviceCap(c.env.DB, userId);
    return c.json({ ok: true });
  });

  // Update preferences for an already-registered token.
  r.patch("/devices", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json<{ token?: string; prefs?: any }>().catch(() => ({} as { token?: string; prefs?: any }));
    const token = (body.token ?? "").trim().toLowerCase();
    const prefs = parsePrefs(body.prefs);
    if (!token || !prefs) return c.json({ error: "Missing token or prefs" }, 400);
    const changed = await q.updatePushPrefs(c.env.DB, userId, token, prefs);
    if (!changed) return c.json({ error: "Unknown device" }, 404);
    return c.json({ ok: true });
  });

  // Unregister a device (e.g. on sign-out or when the user disables push).
  r.delete("/devices", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json<{ token?: string }>().catch(() => ({} as { token?: string }));
    const token = (body.token ?? "").trim().toLowerCase();
    if (!token) return c.json({ error: "Missing token" }, 400);
    await q.deletePushDevice(c.env.DB, userId, token);
    return c.json({ ok: true });
  });

  // Send a test push alert to every registered device for this account.
  // Self-scoped, rate-limited, and prunes dead tokens — see sendTestPush.
  r.post("/test", async (c) => {
    const userId = c.get("userId");
    const { status, body } = await sendTestPush(c.env, userId, Date.now());
    return c.json(body, status as ContentfulStatusCode);
  });

  return r;
}
