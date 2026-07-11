import { Hono } from "hono";
import type { Env } from "../../types";
import { authenticateApiKey } from "../../lib/api-keys";
import { getMainGlobalDomain } from "../../lib/settings";
import { isValidLocalPart, randomLocalPart, escapeLike } from "../../lib/alias-format";
import { aliasQuotaExceeded, resolveDefaultDestination } from "../../db/aliases";

/**
 * addy.io-compatible API surface (/api/v1), authenticated with per-user API
 * keys (`Authorization: Bearer hme_…`). Speaking the addy.io dialect gives
 * instant integration with tools that already support it — most importantly
 * Bitwarden's username generator (forwarder type "addy.io", server URL set to
 * this instance's origin).
 *
 * Implemented endpoints (the subset those integrations use):
 *   GET    /api-token-details    — token validity check
 *   GET    /domain-options       — domains available for alias creation
 *   GET    /aliases              — list aliases
 *   POST   /aliases              — create an alias (the Bitwarden call)
 *   GET    /aliases/:id          — fetch one alias
 *   DELETE /aliases/:id          — delete an alias
 *   POST   /active-aliases       — activate an alias ({"id": …})
 *   DELETE /active-aliases/:id   — deactivate an alias
 *
 * Errors use addy.io's Laravel-style {"message": "…"} shape so client error
 * reporting works unmodified.
 */

type V1Env = {
  Bindings: Env;
  Variables: { userId: number; apiKeyName: string; apiKeyCreatedAt: number };
};

type AliasDbRow = {
  id: number; user_id: number; domain_id: number; local_part: string;
  full_address: string; label: string | null; active: number;
  fwd_count: number; blocked_count: number; reply_count: number;
  created_at: number; last_seen_at: number | null; domain: string;
};

type DomainDbRow = {
  id: number; domain: string; is_global: number; user_id: number;
  allow_custom_aliases: number; active: number; verified_at: number | null;
};

// addy.io timestamps look like "2024-05-31 09:33:15" (UTC).
function fmtTs(ms: number | null): string | null {
  if (ms == null) return null;
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

// Map an alias row to the addy.io alias resource. Consumers read `email`
// (Bitwarden) and `active`/`description` (addy.io browser extension).
function aliasResource(row: AliasDbRow) {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    aliasable_id: null,
    aliasable_type: null,
    local_part: row.local_part,
    extension: null,
    domain: row.domain,
    email: row.full_address,
    active: row.active === 1,
    description: row.label,
    from_name: null,
    emails_forwarded: row.fwd_count,
    emails_blocked: row.blocked_count,
    emails_replied: row.reply_count,
    emails_sent: 0,
    recipients: [],
    last_forwarded: fmtTs(row.last_seen_at),
    last_blocked: null,
    last_replied: null,
    last_sent: null,
    created_at: fmtTs(row.created_at),
    updated_at: fmtTs(row.created_at),
    deleted_at: null,
  };
}

const ALIAS_SELECT =
  "SELECT a.id, a.user_id, a.domain_id, a.local_part, a.full_address, a.label, a.active, " +
  "a.fwd_count, a.blocked_count, a.reply_count, a.created_at, a.last_seen_at, d.domain " +
  "FROM aliases a JOIN domains d ON d.id = a.domain_id";

export function v1Routes() {
  const r = new Hono<V1Env>();

  // Bearer API-key guard for the whole surface.
  r.use("*", async (c, next) => {
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) return c.json({ message: "Unauthenticated." }, 401);
    const auth = await authenticateApiKey(c.env.DB, token);
    if (!auth) return c.json({ message: "Unauthenticated." }, 401);
    c.set("userId", auth.userId);
    c.set("apiKeyName", auth.keyName);
    c.set("apiKeyCreatedAt", auth.keyCreatedAt);
    return next();
  });

  // Token validity probe used by addy.io clients to test their configuration.
  r.get("/api-token-details", (c) => {
    return c.json({
      name: c.get("apiKeyName"),
      created_at: fmtTs(c.get("apiKeyCreatedAt")),
      expires_at: null,
    });
  });

  // Domains the caller may create aliases on: active+verified global domains
  // plus the caller's own (subdomain) domains.
  r.get("/domain-options", async (c) => {
    const userId = c.get("userId");
    const [rows, main] = await Promise.all([
      c.env.DB.prepare(
        "SELECT domain FROM domains WHERE (is_global = 1 AND active = 1 AND verified_at IS NOT NULL) " +
        "OR (is_global = 0 AND user_id = ?) ORDER BY is_global DESC, domain"
      ).bind(userId).all<{ domain: string }>(),
      getMainGlobalDomain(c.env.DB, c.env),
    ]);
    const options = (rows.results ?? []).map((d) => d.domain);
    return c.json({
      data: options,
      defaultAliasDomain: options.includes(main) ? main : (options[0] ?? null),
      defaultAliasFormat: "random_characters",
    });
  });

  r.get("/aliases", async (c) => {
    const userId = c.get("userId");
    const search = c.req.query("filter[search]");
    const sql = `${ALIAS_SELECT} WHERE a.user_id = ?${search ? " AND a.full_address LIKE ? ESCAPE '\\'" : ""} ORDER BY a.created_at DESC LIMIT 100`;
    const stmt = search
      ? c.env.DB.prepare(sql).bind(userId, `%${escapeLike(search)}%`)
      : c.env.DB.prepare(sql).bind(userId);
    const rows = await stmt.all<AliasDbRow>();
    return c.json({ data: (rows.results ?? []).map(aliasResource) });
  });

  r.get("/aliases/:id", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ message: "Not found." }, 404);
    const row = await c.env.DB.prepare(`${ALIAS_SELECT} WHERE a.id = ? AND a.user_id = ?`)
      .bind(id, userId).first<AliasDbRow>();
    if (!row) return c.json({ message: "Not found." }, 404);
    return c.json({ data: aliasResource(row) });
  });

  // The alias-generation call. Bitwarden sends { domain, description }; the
  // addy.io extension additionally sends format (+ local_part for "custom").
  r.post("/aliases", async (c) => {
    const userId = c.get("userId");
    const b = await c.req.json<{ domain?: string; description?: string; format?: string; local_part?: string }>()
      .catch(() => ({} as { domain?: string; description?: string; format?: string; local_part?: string }));

    // Resolve the target domain: explicit name, else the main global domain.
    let dom: DomainDbRow | null = null;
    const DOMAIN_COLS = "SELECT id, domain, is_global, user_id, allow_custom_aliases, active, verified_at FROM domains";
    if (b.domain) {
      dom = await c.env.DB.prepare(`${DOMAIN_COLS} WHERE domain = ?`)
        .bind(b.domain.toLowerCase()).first<DomainDbRow>();
      if (dom && dom.is_global === 1 && (dom.active !== 1 || !dom.verified_at)) dom = null;
      if (dom && dom.is_global === 0 && dom.user_id !== userId) dom = null;
    } else {
      const main = await getMainGlobalDomain(c.env.DB, c.env);
      if (main) {
        dom = await c.env.DB.prepare(
          `${DOMAIN_COLS} WHERE domain = ? AND is_global = 1 AND active = 1 AND verified_at IS NOT NULL`
        ).bind(main).first<DomainDbRow>();
      }
    }
    if (!dom) return c.json({ message: "The chosen domain is not available." }, 422);

    if (await aliasQuotaExceeded(c.env.DB, userId)) {
      return c.json({ message: "You have reached your alias limit." }, 403);
    }

    const format = b.format ?? "random_characters";
    if (!["random_characters", "uuid", "custom"].includes(format)) {
      return c.json({ message: `The alias format '${format}' is not supported.` }, 422);
    }
    if (format === "custom") {
      const localPart = (b.local_part ?? "").toLowerCase();
      if (dom.is_global === 1 && !dom.allow_custom_aliases) {
        return c.json({ message: "Custom local parts are not allowed on this domain." }, 403);
      }
      if (localPart.startsWith("r.") || !isValidLocalPart(localPart)) {
        return c.json({ message: "The local part is invalid — use only letters, numbers, dots, hyphens." }, 422);
      }
    }

    // Global-domain aliases forward to the caller's default verified
    // destination; user-owned (subdomain) domains fall back to the domain's
    // own default destination at delivery time.
    let destEnc: string | null = null;
    let destHash: string | null = null;
    if (dom.is_global === 1) {
      const pair = await resolveDefaultDestination(c.env.DB, c.env.DESTINATION_ENCRYPTION_KEY, userId);
      if (!pair) {
        return c.json({ message: "Set a verified default destination in the dashboard first." }, 422);
      }
      ({ destEnc, destHash } = pair);
    }

    // Random formats retry on the (unlikely) UNIQUE collision; custom fails.
    const attempts = format === "custom" ? 1 : 3;
    for (let i = 0; i < attempts; i++) {
      const localPart = format === "custom" ? b.local_part!.toLowerCase()
        : format === "uuid" ? crypto.randomUUID()
        : randomLocalPart();
      const full = `${localPart}@${dom.domain}`;
      try {
        const row = await c.env.DB.prepare(
          "INSERT INTO aliases (domain_id, user_id, local_part, full_address, destination, destination_hash, label, active, source, created_at) " +
          "VALUES (?,?,?,?,?,?,?,1,'api',?) RETURNING *"
        ).bind(dom.id, userId, localPart, full, destEnc, destHash, b.description ?? null, Date.now()).first<AliasDbRow>();
        return c.json({ data: aliasResource({ ...row!, domain: dom.domain }) }, 201);
      } catch (err: any) {
        if (err.message?.includes("UNIQUE constraint failed")) {
          if (i === attempts - 1) return c.json({ message: "That alias already exists." }, 422);
          continue;
        }
        console.error("v1 alias create failed:", err);
        return c.json({ message: "Internal error." }, 500);
      }
    }
    return c.json({ message: "Internal error." }, 500);
  });

  r.delete("/aliases/:id", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ message: "Not found." }, 404);
    const exists = await c.env.DB.prepare("SELECT id FROM aliases WHERE id = ? AND user_id = ?")
      .bind(id, userId).first();
    if (!exists) return c.json({ message: "Not found." }, 404);
    // Same cascade as the dashboard DELETE /api/aliases/:id.
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM reverse_map WHERE alias_id=?").bind(id),
      c.env.DB.prepare("DELETE FROM contacts WHERE alias_id=?").bind(id),
      c.env.DB.prepare("DELETE FROM blocks WHERE alias_id=?").bind(id),
      c.env.DB.prepare("DELETE FROM events WHERE alias_id=?").bind(id),
      c.env.DB.prepare("DELETE FROM aliases WHERE id=? AND user_id=?").bind(id, userId),
    ]);
    return c.body(null, 204);
  });

  // addy.io toggles alias state through the active-aliases sub-resource.
  r.post("/active-aliases", async (c) => {
    const userId = c.get("userId");
    const { id } = await c.req.json<{ id?: number | string }>().catch(() => ({ id: undefined }));
    const aliasId = Number(id);
    if (!Number.isInteger(aliasId)) return c.json({ message: "Not found." }, 404);
    const res = await c.env.DB.prepare("UPDATE aliases SET active = 1 WHERE id = ? AND user_id = ?")
      .bind(aliasId, userId).run();
    if (res.meta.changes === 0) return c.json({ message: "Not found." }, 404);
    const row = await c.env.DB.prepare(`${ALIAS_SELECT} WHERE a.id = ?`).bind(aliasId).first<AliasDbRow>();
    return c.json({ data: aliasResource(row!) });
  });

  r.delete("/active-aliases/:id", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ message: "Not found." }, 404);
    const res = await c.env.DB.prepare("UPDATE aliases SET active = 0 WHERE id = ? AND user_id = ?")
      .bind(id, userId).run();
    if (res.meta.changes === 0) return c.json({ message: "Not found." }, 404);
    return c.body(null, 204);
  });

  return r;
}
