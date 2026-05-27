import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { signPasskeyRegChallenge, verifyFreshAuth, verifyPasskeyRegChallenge } from "../../lib/auth";
import { fromBase64url, toBase64url, getRpFromOrigin } from "../../lib/webauthn";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SECONDS = 3600;

async function canAttempt(ip: string, db: D1Database): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare("SELECT attempts, reset_at FROM rate_limits WHERE ip = ?").bind(ip).first<{ attempts: number; reset_at: number }>();
  if (!row) return true;
  if (now >= row.reset_at) return true;
  return row.attempts < RATE_LIMIT_MAX;
}

async function recordFailedAttempt(ip: string, db: D1Database): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare("SELECT attempts, reset_at FROM rate_limits WHERE ip = ?").bind(ip).first<{ attempts: number; reset_at: number }>();
  if (!row) {
    await db.prepare("INSERT INTO rate_limits (ip, attempts, reset_at) VALUES (?, 1, ?)").bind(ip, now + RATE_LIMIT_WINDOW_SECONDS).run();
    return;
  }
  if (now >= row.reset_at) {
    await db.prepare("UPDATE rate_limits SET attempts = 1, reset_at = ? WHERE ip = ?").bind(now + RATE_LIMIT_WINDOW_SECONDS, ip).run();
    return;
  }
  await db.prepare("UPDATE rate_limits SET attempts = attempts + 1 WHERE ip = ?").bind(ip).run();
}

async function hasFreshAuth(c: Context<AppEnv>): Promise<boolean> {
  const token = getCookie(c, "__Host-fresh-auth");
  return !!token && await verifyFreshAuth(c.env.SESSION_SECRET, token, c.get("userId"));
}

export function settingsRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/mfa", async (c) => {
    const userId = c.get("userId");
    const mfa = await c.env.DB.prepare(
      "SELECT totp_enabled, totp_backup_codes FROM mfa WHERE user_id = ?"
    ).bind(userId).first<{ totp_enabled: number; totp_backup_codes: string | null }>();

    const backupCodesRemaining = mfa?.totp_enabled === 1 && mfa.totp_backup_codes
      ? (JSON.parse(mfa.totp_backup_codes) as string[]).length
      : 0;

    return c.json({
      enabled: mfa?.totp_enabled === 1,
      backupCodesRemaining,
    });
  });

  // Begin TOTP setup: generate secret and return URI for QR code
  r.post("/mfa/setup", async (c) => {
    const userId = c.get("userId");
    if (!(await hasFreshAuth(c))) return c.json({ error: "fresh authentication required" }, 401);
    const { generateTOTPSecret, makeTOTPUri } = await import("../../lib/totp");
    const { encryptDestination } = await import("../../lib/crypto");

    // SECURITY: refuse to overwrite an already-enabled MFA enrolment. /mfa/disable
    // requires a fresh TOTP/backup code; allowing /mfa/setup to silently flip
    // totp_enabled back to 0 (and wipe backup codes) would bypass that gate and
    // let an attacker with a stolen session pivot the account onto their own TOTP.
    const current = await c.env.DB.prepare(
      "SELECT totp_enabled FROM mfa WHERE user_id = ?"
    ).bind(userId).first<{ totp_enabled: number }>().catch((err: unknown) => {
      if (err instanceof Error && err.message.includes("no such table")) return null;
      throw err;
    });
    if (current?.totp_enabled === 1) {
      return c.json({ error: "MFA already enabled — disable it first to re-enroll" }, 409);
    }

    const secret = generateTOTPSecret();
    const encryptedSecret = await encryptDestination(secret, c.env.DESTINATION_ENCRYPTION_KEY);

    // Store pending (not yet enabled) secret. Conditional ON CONFLICT keeps an
    // enabled row immutable as a second line of defence against races between
    // the check above and the write.
    await c.env.DB.prepare(
      "INSERT INTO mfa (user_id, totp_secret, totp_enabled) VALUES (?, ?, 0) ON CONFLICT(user_id) DO UPDATE SET totp_secret = excluded.totp_secret, totp_enabled = 0, totp_backup_codes = NULL WHERE totp_enabled = 0"
    ).bind(userId, encryptedSecret).run();

    const user = await c.env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(userId).first<{ name: string | null }>();
    const account = user?.name || (userId === 1 ? "Admin" : `User ${userId}`);
    const uri = makeTOTPUri(secret, "HideMyEmail", account);

    return c.json({ secret, uri });
  });

  // Verify code from authenticator app and activate MFA
  r.post("/mfa/verify", async (c) => {
    const userId = c.get("userId");
    const { code } = await c.req.json<{ code: string }>().catch(() => ({ code: "" }));

    if (!code || !/^\d{6}$/.test(code)) {
      return c.json({ error: "Enter a 6-digit code" }, 400);
    }

    const mfa = await c.env.DB.prepare(
      "SELECT totp_secret FROM mfa WHERE user_id = ?"
    ).bind(userId).first<{ totp_secret: string }>();

    if (!mfa?.totp_secret) return c.json({ error: "No pending setup found" }, 400);

    const { decryptDestination } = await import("../../lib/crypto");
    const { verifyTOTP, generateBackupCodes } = await import("../../lib/totp");

    const secret = await decryptDestination(mfa.totp_secret, c.env.DESTINATION_ENCRYPTION_KEY);

    if (!(await verifyTOTP(secret, code))) {
      return c.json({ error: "Code does not match — check your authenticator app clock" }, 400);
    }

    const { plain, hashed } = await generateBackupCodes();

    await c.env.DB.prepare(
      "UPDATE mfa SET totp_enabled = 1, totp_backup_codes = ? WHERE user_id = ?"
    ).bind(JSON.stringify(hashed), userId).run();

    return c.json({ ok: true, backupCodes: plain });
  });

  // Disable TOTP — requires a valid TOTP code or backup code for confirmation
  r.post("/mfa/disable", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || "unknown";
    if (!(await canAttempt(ip, c.env.DB))) return c.json({ error: "too many attempts" }, 429);
    const userId = c.get("userId");
    if (!(await hasFreshAuth(c))) return c.json({ error: "fresh authentication required" }, 401);
    const { code } = await c.req.json<{ code: string }>().catch(() => ({ code: "" }));

    if (!code) return c.json({ error: "Code required" }, 400);

    const mfa = await c.env.DB.prepare(
      "SELECT totp_secret, totp_backup_codes FROM mfa WHERE user_id = ? AND totp_enabled = 1"
    ).bind(userId).first<{ totp_secret: string; totp_backup_codes: string | null }>();

    if (!mfa) return c.json({ error: "MFA not enabled" }, 400);

    const { decryptDestination } = await import("../../lib/crypto");
    const { verifyTOTP, verifyBackupCode } = await import("../../lib/totp");

    const secret = await decryptDestination(mfa.totp_secret, c.env.DESTINATION_ENCRYPTION_KEY);

    let verified = false;

    if (/^\d{6}$/.test(code)) {
      verified = await verifyTOTP(secret, code);
    } else {
      const normalized = code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
      const hashedCodes: string[] = mfa.totp_backup_codes ? JSON.parse(mfa.totp_backup_codes) : [];
      verified = (await verifyBackupCode(normalized, hashedCodes)) !== -1;
    }

    if (!verified) {
      await recordFailedAttempt(ip, c.env.DB);
      return c.json({ error: "Invalid code" }, 401);
    }

    await c.env.DB.prepare(
      "UPDATE mfa SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL WHERE user_id = ?"
    ).bind(userId).run();

    return c.json({ ok: true });
  });

  // Regenerate backup codes — requires current TOTP code
  r.post("/mfa/backup-codes", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || "unknown";
    if (!(await canAttempt(ip, c.env.DB))) return c.json({ error: "too many attempts" }, 429);
    const userId = c.get("userId");
    if (!(await hasFreshAuth(c))) return c.json({ error: "fresh authentication required" }, 401);
    const { code } = await c.req.json<{ code: string }>().catch(() => ({ code: "" }));

    if (!code || !/^\d{6}$/.test(code)) {
      return c.json({ error: "Enter a 6-digit code to regenerate backup codes" }, 400);
    }

    const mfa = await c.env.DB.prepare(
      "SELECT totp_secret FROM mfa WHERE user_id = ? AND totp_enabled = 1"
    ).bind(userId).first<{ totp_secret: string }>();

    if (!mfa) return c.json({ error: "MFA not enabled" }, 400);

    const { decryptDestination } = await import("../../lib/crypto");
    const { verifyTOTP, generateBackupCodes } = await import("../../lib/totp");

    const secret = await decryptDestination(mfa.totp_secret, c.env.DESTINATION_ENCRYPTION_KEY);

    if (!(await verifyTOTP(secret, code))) {
      await recordFailedAttempt(ip, c.env.DB);
      return c.json({ error: "Invalid code" }, 401);
    }

    const { plain, hashed } = await generateBackupCodes();

    await c.env.DB.prepare(
      "UPDATE mfa SET totp_backup_codes = ? WHERE user_id = ?"
    ).bind(JSON.stringify(hashed), userId).run();

    return c.json({ ok: true, backupCodes: plain });
  });

  // ── Passkey management ────────────────────────────────────────────────────

  r.get("/passkeys", async (c) => {
    const userId = c.get("userId");
    const rows = await c.env.DB.prepare(
      "SELECT id, device_name, created_at FROM passkey_credentials WHERE user_id = ? ORDER BY created_at DESC"
    ).bind(userId).all<{ id: string; device_name: string | null; created_at: number }>();
    return c.json(rows.results ?? []);
  });

  // Generate a WebAuthn registration challenge
  r.post("/passkeys/challenge", async (c) => {
    const userId = c.get("userId");
    if (!(await hasFreshAuth(c))) return c.json({ error: "fresh authentication required" }, 401);
    const { generateRegistrationOptions } = await import("@simplewebauthn/server");
    const { rpID } = getRpFromOrigin(c.req.header("origin"));

    const existing = await c.env.DB.prepare(
      "SELECT id, transports FROM passkey_credentials WHERE user_id = ?"
    ).bind(userId).all<{ id: string; transports: string | null }>();

    const user = await c.env.DB.prepare("SELECT name FROM users WHERE id = ?")
      .bind(userId).first<{ name: string | null }>();
    const userName = user?.name || (userId === 1 ? "Admin" : `User ${userId}`);

    const options = await generateRegistrationOptions({
      rpName: "HideMyEmail",
      rpID,
      userID: Uint8Array.from(new TextEncoder().encode(String(userId))),
      userName,
      userDisplayName: userName,
      attestationType: "none",
      excludeCredentials: (existing.results ?? []).map(cred => ({
        id: cred.id,
        transports: cred.transports ? JSON.parse(cred.transports) : undefined,
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });

    const cookie = await signPasskeyRegChallenge(c.env.SESSION_SECRET, userId, options.challenge);
    setCookie(c, "__Host-passkey-reg", cookie, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 300 });

    return c.json(options);
  });

  // Verify attestation and persist the new credential
  r.post("/passkeys/register", async (c) => {
    const sessionUserId = c.get("userId");
    if (!(await hasFreshAuth(c))) return c.json({ error: "fresh authentication required" }, 401);

    const regCookie = getCookie(c, "__Host-passkey-reg");
    if (!regCookie) return c.json({ error: "No registration challenge" }, 401);

    const verified = await verifyPasskeyRegChallenge(c.env.SESSION_SECRET, regCookie);
    if (!verified || verified.userId !== sessionUserId) {
      return c.json({ error: "Invalid or expired challenge" }, 401);
    }

    const { response, deviceName } = await c.req.json<{ response: RegistrationResponseJSON; deviceName?: string }>()
      .catch(() => ({ response: null as unknown as RegistrationResponseJSON, deviceName: undefined }));

    if (!response?.id) return c.json({ error: "invalid request" }, 400);

    const { verifyRegistrationResponse } = await import("@simplewebauthn/server");
    const { rpID, expectedOrigin } = getRpFromOrigin(c.req.header("origin"));

    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: verified.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: true,
    }).catch(err => ({ verified: false as const, registrationInfo: undefined, error: String(err) }));

    if (!result.verified || !result.registrationInfo) {
      return c.json({ error: "Verification failed" }, 400);
    }

    const { credential } = result.registrationInfo;
    const credId = credential.id;

    const dup = await c.env.DB.prepare("SELECT id FROM passkey_credentials WHERE id = ?").bind(credId).first();
    if (dup) return c.json({ error: "Credential already registered" }, 409);

    const transports = response.response.transports ?? [];

    await c.env.DB.prepare(
      "INSERT INTO passkey_credentials (id, user_id, public_key, sign_count, transports, device_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(credId, sessionUserId, toBase64url(credential.publicKey), credential.counter, JSON.stringify(transports), deviceName || null, Date.now()).run();

    deleteCookie(c, "__Host-passkey-reg", { path: "/", secure: true });

    return c.json({ ok: true, id: credId });
  });

  r.patch("/passkeys/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const { deviceName } = await c.req.json<{ deviceName: string }>().catch(() => ({ deviceName: "" }));

    if (!deviceName || deviceName.length > 64) return c.json({ error: "Invalid name (max 64 chars)" }, 400);

    await c.env.DB.prepare(
      "UPDATE passkey_credentials SET device_name = ? WHERE id = ? AND user_id = ?"
    ).bind(deviceName, id, userId).run();

    return c.json({ ok: true });
  });

  r.delete("/passkeys/:id", async (c) => {
    const userId = c.get("userId");
    if (!(await hasFreshAuth(c))) return c.json({ error: "fresh authentication required" }, 401);
    const id = c.req.param("id");

    await c.env.DB.prepare(
      "DELETE FROM passkey_credentials WHERE id = ? AND user_id = ?"
    ).bind(id, userId).run();

    return c.json({ ok: true });
  });

  return r;
}
