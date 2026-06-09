import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import type { AppEnv } from "../app";
import { derivePassphraseHash, timingSafeEqual } from "../../lib/auth";
import { decryptDestination } from "../../lib/crypto";

export function accountRoutes() {
  const r = new Hono<AppEnv>();

  /**
   * GET /export
   * Returns a JSON file with the authenticated user's data. Secret columns
   * (passphrase_hash, recovery_token, recovery_*) are omitted. Destination
   * emails are decrypted to plaintext.
   */
  r.get("/export", async (c) => {
    const userId = c.get("userId");
    const db = c.env.DB;
    const key = c.env.DESTINATION_ENCRYPTION_KEY;

    // User row — omit secret columns
    const user = await db.prepare(
      "SELECT id, created_at, active, forwarding, name, deleted_at FROM users WHERE id = ?"
    ).bind(userId).first<{
      id: number; created_at: number; active: number; forwarding: number;
      name: string | null; deleted_at: number | null;
    }>();

    // Domains owned by this user
    const domainsResult = await db.prepare(
      "SELECT id, domain, default_destination, active, created_at, verified_at, verification_token, is_global, allow_custom_aliases, allow_subdomain_aliases, catch_all, inline_actions_pref FROM domains WHERE user_id = ?"
    ).bind(userId).all<Record<string, unknown>>();

    // Aliases owned by this user
    const aliasesResult = await db.prepare(
      "SELECT id, domain_id, local_part, full_address, destination, label, active, source, fwd_count, blocked_count, reply_count, created_at, last_seen_at, muted_until FROM aliases WHERE user_id = ?"
    ).bind(userId).all<Record<string, unknown>>();

    // Destinations — decrypt email for plaintext export
    const destinationsResult = await db.prepare(
      "SELECT id, email, email_hash, token, verified_at, created_at, is_default, suppressed_at, suppression_reason, suppression_class FROM destinations WHERE user_id = ?"
    ).bind(userId).all<{ id: number; email: string; email_hash: string | null; token: string; verified_at: number | null; created_at: number; is_default: number; suppressed_at: number | null; suppression_reason: string | null; suppression_class: string | null }>();

    const destinations = await Promise.all(
      (destinationsResult.results ?? []).map(async (d) => ({
        ...d,
        email: await decryptDestination(d.email, key),
      }))
    );
    const destinationIds = (destinationsResult.results ?? []).map(d => d.id);

    // Blocks owned by this user (global, per-subdomain, and per-alias; block/allow)
    const blocksResult = await db.prepare(
      "SELECT id, alias_id, domain_id, kind, pattern, created_at FROM blocks WHERE user_id = ?"
    ).bind(userId).all<Record<string, unknown>>();

    // Events for all aliases belonging to this user
    const eventsResult = await db.prepare(
      "SELECT e.id, e.alias_id, e.type, e.external_sender, e.subject, e.bytes, e.detail, e.ts " +
      "FROM events e INNER JOIN aliases a ON a.id = e.alias_id WHERE a.user_id = ?"
    ).bind(userId).all<Record<string, unknown>>();

    let destinationEvents: Record<string, unknown>[] = [];
    if (destinationIds.length > 0) {
      const placeholders = destinationIds.map(() => "?").join(", ");
      const result = await db.prepare(
        `SELECT id, alias_id, type, external_sender, subject, bytes, detail, ts FROM events WHERE detail IN (${placeholders})`
      ).bind(...destinationIds.map(id => `dest:${id}`)).all<Record<string, unknown>>();
      destinationEvents = result.results ?? [];
    }

    const ts = Date.now();
    const payload = {
      exported_at: ts,
      user,
      domains: domainsResult.results ?? [],
      aliases: aliasesResult.results ?? [],
      destinations,
      blocks: blocksResult.results ?? [],
      events: [...(eventsResult.results ?? []), ...destinationEvents],
    };

    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="hidemyemail-export-${ts}.json"`,
      },
    });
  });

  /**
   * POST /delete
   * Body: { password: string, confirm: string }
   * Tombstones the account (sets deleted_at, active=0, forwarding=0) and
   * clears the session cookies. The account will be hard-deleted after 7 days
   * by the scheduled purge job.
   */
  r.post("/delete", async (c) => {
    const userId = c.get("userId");
    if (userId === 1) {
      return c.json({ error: "The admin account cannot be self-deleted" }, 403);
    }

    const { password, confirm } = await c.req.json<{ password?: string; confirm?: string }>()
      .catch(() => ({} as { password?: string; confirm?: string }));

    if (confirm !== "DELETE") {
      return c.json({ error: "Confirmation must be \"DELETE\"" }, 400);
    }

    if (!password) {
      return c.json({ error: "Password is required" }, 400);
    }

    const db = c.env.DB;

    // Verify the password against the stored passphrase hash
    const userRow = await db.prepare(
      "SELECT passphrase_hash FROM users WHERE id = ?"
    ).bind(userId).first<{ passphrase_hash: string }>();

    if (!userRow) {
      return c.json({ error: "User not found" }, 404);
    }

    const hash = await derivePassphraseHash(password, c.env.AUTH_PASSWORD_SALT);
    if (!timingSafeEqual(hash, userRow.passphrase_hash)) {
      return c.json({ error: "Invalid password" }, 401);
    }

    // Tombstone the account: stop forwarding & login immediately; schedule purge
    const now = Date.now();
    await db.prepare(
      "UPDATE users SET deleted_at = ?, active = 0, forwarding = 0 WHERE id = ?"
    ).bind(now, userId).run();

    // Clear session cookies so the client is logged out immediately
    deleteCookie(c, "__Host-session", { path: "/", secure: true });
    deleteCookie(c, "__Host-fresh-auth", { path: "/", secure: true });

    return c.json({ ok: true });
  });

  return r;
}
