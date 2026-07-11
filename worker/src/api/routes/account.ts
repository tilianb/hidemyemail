import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import type { AppEnv } from "../app";
import { derivePassphraseHash, timingSafeEqual } from "../../lib/auth";
import { hasFreshAuth } from "../auth-helpers";
import { decryptDestination } from "../../lib/crypto";
import { validateUsername } from "../../lib/username";
import { generateRecoveryCodes } from "../../lib/recovery";

export function accountRoutes() {
  const r = new Hono<AppEnv>();

  /**
   * GET /export
   * Returns a JSON file with the authenticated user's data. Secret columns
   * (passphrase_hash, recovery_token, recovery_*, TOTP secret/backup codes,
   * passkey public keys) are omitted. Destination emails are decrypted to
   * plaintext. Includes account preferences, MFA/passkey status, reverse-alias
   * correspondents, and registered push devices so it is a complete export.
   *
   * Fresh-auth gated: the export contains every destination address in
   * plaintext, so a stolen long-lived session cookie alone must not reach it.
   */
  r.get("/export", async (c) => {
    if (!(await hasFreshAuth(c))) return c.json({ error: "Fresh authentication required" }, 401);
    const userId = c.get("userId");
    const db = c.env.DB;
    const key = c.env.DESTINATION_ENCRYPTION_KEY;

    // User row — omit secret columns; include account-level preferences
    const user = await db.prepare(
      "SELECT id, created_at, active, forwarding, name, username, inline_actions_enabled, inline_actions_pref, inline_actions_position, deleted_at FROM users WHERE id = ?"
    ).bind(userId).first<Record<string, unknown>>();

    // MFA status — enabled flag only; the TOTP secret and backup codes are secret.
    const mfaRow = await db.prepare(
      "SELECT totp_enabled FROM mfa WHERE user_id = ?"
    ).bind(userId).first<{ totp_enabled: number }>();
    const mfa = { totp_enabled: (mfaRow?.totp_enabled ?? 0) === 1 };

    // Passkey credentials — metadata only; the public key is omitted.
    const passkeysResult = await db.prepare(
      "SELECT id, device_name, transports, sign_count, created_at FROM passkey_credentials WHERE user_id = ?"
    ).bind(userId).all<Record<string, unknown>>();

    // Domains owned by this user
    const domainsResult = await db.prepare(
      "SELECT id, domain, default_destination, active, created_at, verified_at, verification_token, is_global, allow_custom_aliases, allow_subdomain_aliases, catch_all, inline_actions_pref FROM domains WHERE user_id = ?"
    ).bind(userId).all<Record<string, unknown>>();
    const domains = await Promise.all(
      (domainsResult.results ?? []).map(async (d) => ({
        ...d,
        default_destination: typeof d.default_destination === "string"
          ? await decryptDestination(d.default_destination, key)
          : d.default_destination,
      }))
    );

    // Aliases owned by this user
    const aliasesResult = await db.prepare(
      "SELECT id, domain_id, local_part, full_address, destination, label, active, source, fwd_count, blocked_count, reply_count, created_at, last_seen_at, muted_until FROM aliases WHERE user_id = ?"
    ).bind(userId).all<Record<string, unknown>>();
    const aliases = await Promise.all(
      (aliasesResult.results ?? []).map(async (a) => ({
        ...a,
        destination: typeof a.destination === "string"
          ? await decryptDestination(a.destination, key)
          : a.destination,
      }))
    );

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
    const aliasIds = (aliasesResult.results ?? []).map(a => a.id as number);

    // Reverse-alias map — the correspondents (and reply-routing tokens) per alias.
    let reverseMap: Record<string, unknown>[] = [];
    if (aliasIds.length > 0) {
      const placeholders = aliasIds.map(() => "?").join(", ");
      const rm = await db.prepare(
        `SELECT token, alias_id, external_sender, created_at, last_used_at FROM reverse_map WHERE alias_id IN (${placeholders})`
      ).bind(...aliasIds).all<Record<string, unknown>>();
      reverseMap = rm.results ?? [];
    }

    // Registered push devices and their per-device notification preferences.
    const pushDevicesResult = await db.prepare(
      "SELECT platform, token, notify_blocked, notify_bounce, notify_forward, notify_reply, created_at, last_seen_at FROM push_devices WHERE user_id = ?"
    ).bind(userId).all<Record<string, unknown>>();

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
      mfa,
      passkeys: passkeysResult.results ?? [],
      domains,
      aliases,
      destinations,
      reverse_map: reverseMap,
      blocks: blocksResult.results ?? [],
      push_devices: pushDevicesResult.results ?? [],
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
    // Fresh-auth gated on top of the password check: with MFA enabled, a
    // stolen session + password alone must not be able to destroy the account.
    if (!(await hasFreshAuth(c))) return c.json({ error: "Fresh authentication required" }, 401);
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

  /**
   * GET /profile
   * Current user's public-ish profile for the dashboard: id, username, admin
   * label name, whether self-service recovery codes exist and how many remain.
   * Secret columns (hashes, passphrase) never leave the server.
   */
  r.get("/profile", async (c) => {
    const userId = c.get("userId");
    const row = await c.env.DB.prepare(
      "SELECT username, name, recovery_codes FROM users WHERE id = ?"
    ).bind(userId).first<{ username: string | null; name: string | null; recovery_codes: string | null }>();
    return c.json({
      id: userId,
      username: row?.username ?? null,
      name: row?.name ?? null,
      isAdmin: userId === 1,
      recovery_codes_remaining: recoveryCodesRemaining(row?.recovery_codes ?? null),
    });
  });

  /**
   * PATCH /username
   * Body: { username: string | null }
   * Set or clear the caller's public username. Not a secret and not a login
   * credential, so a normal session is enough (no fresh-auth gate). Uniqueness
   * is case-insensitive, enforced by the DB index — a collision returns 409.
   */
  r.patch("/username", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json<{ username?: string | null }>().catch(() => ({ username: undefined }));

    // Explicit clear: null or empty string removes the username.
    if (body.username === null || body.username === "") {
      await c.env.DB.prepare("UPDATE users SET username = NULL WHERE id = ?").bind(userId).run();
      return c.json({ ok: true, username: null });
    }

    const result = validateUsername(body.username);
    if (!result.ok) return c.json({ error: result.error }, 400);

    try {
      await c.env.DB.prepare("UPDATE users SET username = ? WHERE id = ?").bind(result.value, userId).run();
    } catch (err: any) {
      if (err.message && err.message.includes("UNIQUE constraint failed")) {
        return c.json({ error: "That username is already taken" }, 409);
      }
      return c.json({ error: "Internal error" }, 500);
    }
    return c.json({ ok: true, username: result.value });
  });

  /**
   * GET /recovery-codes
   * How many unused recovery codes remain. Never returns the codes themselves
   * (only hashes are stored); plaintext is shown once at generation time.
   */
  r.get("/recovery-codes", async (c) => {
    const userId = c.get("userId");
    const row = await c.env.DB.prepare(
      "SELECT recovery_codes FROM users WHERE id = ?"
    ).bind(userId).first<{ recovery_codes: string | null }>();
    return c.json({ remaining: recoveryCodesRemaining(row?.recovery_codes ?? null) });
  });

  /**
   * POST /recovery-codes
   * (Re)generate the caller's recovery codes. Returns the fresh plaintext set
   * exactly once; only hashes are stored. Regenerating invalidates any previous
   * codes. Fresh-auth gated: minting a new account-recovery secret is exactly
   * the kind of operation a stolen long-lived cookie must not be able to do.
   */
  r.post("/recovery-codes", async (c) => {
    if (!(await hasFreshAuth(c))) return c.json({ error: "Fresh authentication required" }, 401);
    const userId = c.get("userId");
    const { plain, hashed } = await generateRecoveryCodes();
    await c.env.DB.prepare("UPDATE users SET recovery_codes = ? WHERE id = ?")
      .bind(JSON.stringify(hashed), userId).run();
    return c.json({ codes: plain });
  });

  return r;
}

/** Count of unused recovery codes from the stored JSON hash array. */
function recoveryCodesRemaining(json: string | null): number {
  if (!json) return 0;
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}
