import { Hono } from "hono";
import type { AppEnv } from "../app";
import { hasFreshAuth } from "../auth-helpers";
import { generateApiToken, tokenPrefix, sha256Hex } from "../../lib/api-keys";

const MAX_KEYS_PER_USER = 20;

/**
 * Management CRUD for the API keys that authenticate the addy.io-compatible
 * /api/v1 surface (lib/api-keys.ts, routes/v1.ts). Mounted under
 * /api/settings behind the session guard; the dashboard's Settings → API
 * Keys card is the only consumer.
 */
export function apiKeyRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/api-keys", async (c) => {
    const userId = c.get("userId");
    const rows = await c.env.DB.prepare(
      "SELECT id, name, token_prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC"
    ).bind(userId).all<{ id: number; name: string; token_prefix: string; created_at: number; last_used_at: number | null }>();
    return c.json(rows.results ?? []);
  });

  // Create a key. The full token is returned exactly once — only its SHA-256
  // is stored. Fresh-auth gated like passkey enrolment: a stolen long-lived
  // session must not be able to mint a durable credential.
  r.post("/api-keys", async (c) => {
    const userId = c.get("userId");
    if (!(await hasFreshAuth(c))) return c.json({ error: "Fresh authentication required" }, 401);
    const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
    const trimmed = (name ?? "").trim();
    if (!trimmed || trimmed.length > 64) return c.json({ error: "Name required (max 64 chars)" }, 400);

    const count = await c.env.DB.prepare("SELECT COUNT(*) as count FROM api_keys WHERE user_id = ?")
      .bind(userId).first<{ count: number }>();
    if (count && count.count >= MAX_KEYS_PER_USER) {
      return c.json({ error: `API key limit reached (${MAX_KEYS_PER_USER})` }, 400);
    }

    const token = generateApiToken();
    const row = await c.env.DB.prepare(
      "INSERT INTO api_keys (user_id, name, token_hash, token_prefix, created_at) VALUES (?,?,?,?,?) RETURNING id, name, token_prefix, created_at"
    ).bind(userId, trimmed, await sha256Hex(token), tokenPrefix(token), Date.now())
      .first<{ id: number; name: string; token_prefix: string; created_at: number }>();

    return c.json({ ...row!, token });
  });

  r.delete("/api-keys/:id", async (c) => {
    const userId = c.get("userId");
    if (!(await hasFreshAuth(c))) return c.json({ error: "Fresh authentication required" }, 401);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "Invalid id" }, 400);
    const res = await c.env.DB.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?")
      .bind(id, userId).run();
    if (res.meta.changes === 0) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  return r;
}
