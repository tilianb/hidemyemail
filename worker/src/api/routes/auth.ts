import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { verifyPassword, signFreshAuth, signSession, derivePassphraseHash, signMfaChallenge, verifyMfaChallenge, signPasskeyAuthChallenge, verifyPasskeyAuthChallenge } from "../../lib/auth";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { getEnvWithOverride, getMainGlobalDomain } from "../../lib/settings";

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
const FRESH_AUTH_TTL = 60 * 10; // 10 minutes

// Rate limit policy: 10 failed attempts per IP per hour, fixed window.
// Successful auth does NOT count — only failures consume budget.
// Shared bucket across login/register/MFA/passkey-verify/recovery so an
// attacker can't dodge the limit by rotating endpoints.
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

// Native clients (iOS/Android) can't use the HttpOnly __Host- cookie jar, so
// they opt into bearer-token auth by sending `X-Auth-Mode: token`. Only then do
// we echo the session token in the response body.
//
// We additionally require the absence of an `Origin` header. `Origin` is a
// forbidden header: page JavaScript can neither set nor strip it, and browsers
// attach it to every POST (login/register/mfa-complete are all POST). Native
// URLSession requests carry no Origin. So "token mode AND no Origin" is an
// unspoofable native-only signal — even an XSS on the app's own (or a
// CORS-allowed) origin can't flip a cookie-bound HttpOnly session into an
// exfiltratable bearer token, because the browser always pins Origin on.
function wantsToken(c: Context<AppEnv>): boolean {
  return c.req.header("X-Auth-Mode") === "token" && !c.req.header("Origin");
}

async function setAuthenticatedCookies(c: Context<AppEnv>, userId: number): Promise<string> {
  const sessionToken = await signSession(c.env.SESSION_SECRET, userId, SESSION_TTL);
  const freshAuthToken = await signFreshAuth(c.env.SESSION_SECRET, userId, FRESH_AUTH_TTL);
  setCookie(c, "__Host-session", sessionToken, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_TTL });
  setCookie(c, "__Host-fresh-auth", freshAuthToken, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: FRESH_AUTH_TTL });
  return sessionToken;
}

function randomSixDigitCode(): string {
  const max = 1_000_000;
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while (values[0]! >= limit);
  return (values[0]! % max).toString().padStart(6, "0");
}

export function authRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/config", async (c) => {
    const main_global_domain = await getMainGlobalDomain(c.env.DB, c.env);
    const { getBoolSetting, getNumericSetting } = await import("../../lib/settings");
    const max_subdomains = await getNumericSetting(c.env.DB, "max_subdomains");
    const max_total_aliases = await getNumericSetting(c.env.DB, "max_total_aliases");
    const alias_quota_buffer_enabled = await getBoolSetting(c.env.DB, "alias_quota_buffer_enabled");
    return c.json({ main_global_domain, max_subdomains, max_total_aliases, alias_quota_buffer_enabled });
  });

  r.post("/login", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || "unknown";
    if (!(await canAttempt(ip, c.env.DB))) {
      return c.json({ error: "Too many attempts" }, 429);
    }

    const { password } = await c.req.json<{ password: string }>().catch(() => ({ password: "" }));

    let userId: number | null = null;

    const isAdmin = await verifyPassword(password, c.env.AUTH_PASSWORD_SALT, c.env.AUTH_PASSWORD_HASH);
    if (isAdmin) {
      userId = 1;
    } else {
      const hash = await derivePassphraseHash(password, c.env.AUTH_PASSWORD_SALT);
      // Gracefully handle pre-migration DBs that lack the deleted_at column by
      // selecting it as NULL when absent — the catch below treats that as zero.
      let user: { id: number; active: number; deleted_at: number | null } | null = null;
      try {
        user = await c.env.DB.prepare(
          "SELECT id, active, deleted_at FROM users WHERE passphrase_hash = ?"
        ).bind(hash).first<{ id: number; active: number; deleted_at: number | null }>();
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("no such column")) {
          // Migration not yet applied — fall back to query without deleted_at
          const u = await c.env.DB.prepare(
            "SELECT id, active FROM users WHERE passphrase_hash = ?"
          ).bind(hash).first<{ id: number; active: number }>();
          user = u ? { ...u, deleted_at: null } : null;
        } else {
          throw err;
        }
      }

      if (!user) {
        await recordFailedAttempt(ip, c.env.DB);
        return c.json({ error: "Invalid passphrase" }, 401);
      }
      if (user.active === 0) {
        // Correct passphrase but disabled account — not a brute-force attempt.
        return c.json({ error: "Account is disabled" }, 403);
      }
      if (user.deleted_at !== null) {
        // Account is tombstoned — pending purge. Reject explicitly even if
        // somehow re-activated (active=0 already covers the normal path).
        return c.json({ error: "Account has been deleted" }, 403);
      }
      userId = user.id;
    }

    if (!userId) {
      await recordFailedAttempt(ip, c.env.DB);
      return c.json({ error: "Invalid" }, 401);
    }

    // Fail open only for missing-table (migration not yet applied); re-throw all other errors
    // so transient D1 failures never silently bypass MFA on protected accounts.
    const mfa = await c.env.DB.prepare(
      "SELECT totp_enabled FROM mfa WHERE user_id = ?"
    ).bind(userId).first<{ totp_enabled: number }>().catch((err: unknown) => {
      if (err instanceof Error && err.message.includes("no such table")) return null;
      throw err;
    });

    if (mfa?.totp_enabled === 1) {
      const challenge = await signMfaChallenge(c.env.SESSION_SECRET, userId);
      setCookie(c, "__Host-mfa-challenge", challenge, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 300 });
      // Native clients carry the short-lived challenge themselves since they
      // can't rely on the __Host-mfa-challenge cookie round-trip.
      return c.json(wantsToken(c) ? { mfa_required: true, mfa_token: challenge } : { mfa_required: true });
    }

    const token = await setAuthenticatedCookies(c, userId);
    return c.json(wantsToken(c) ? { ok: true, userId, token } : { ok: true, userId });
  });

  r.post("/register", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || "unknown";
    if (!(await canAttempt(ip, c.env.DB))) {
      return c.json({ error: "Too many attempts" }, 429);
    }

    // Check if registration is enabled
    const { getBoolSetting } = await import("../../lib/settings");
    const registrationEnabled = await getBoolSetting(c.env.DB, "registration_enabled");
    if (!registrationEnabled) {
      return c.json({ error: "Registration is currently disabled" }, 403);
    }

    const { password } = await c.req.json<{ password: string }>().catch(() => ({ password: "" }));
    if (!password || password.length < 16) {
      return c.json({ error: "Passphrase too weak" }, 400);
    }

    const hash = await derivePassphraseHash(password, c.env.AUTH_PASSWORD_SALT);

    try {
      const res = await c.env.DB.prepare(
        "INSERT INTO users (passphrase_hash, created_at) VALUES (?, ?)"
      ).bind(hash, Date.now()).run();

      const userId = res.meta.last_row_id;
      const token = await setAuthenticatedCookies(c, userId);
      return c.json(wantsToken(c) ? { ok: true, userId, token } : { ok: true, userId });
    } catch (err: any) {
      if (err.message && err.message.includes("UNIQUE constraint failed")) {
        await recordFailedAttempt(ip, c.env.DB);
        return c.json({ error: "Already exists" }, 409);
      }
      return c.json({ error: "Internal error" }, 500);
    }
  });

  r.post("/logout", (c) => {
    deleteCookie(c, "__Host-session", { path: "/", secure: true });
    deleteCookie(c, "__Host-fresh-auth", { path: "/", secure: true });
    return c.json({ ok: true });
  });

  r.post("/mfa/complete", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || "unknown";
    if (!(await canAttempt(ip, c.env.DB))) {
      return c.json({ error: "Too many attempts" }, 429);
    }

    const { code, mfa_token } = await c.req.json<{ code: string; mfa_token?: string }>().catch(() => ({ code: "", mfa_token: undefined }));

    // Cookie for the web app; body fallback (mfa_token) for native bearer clients.
    const challenge = getCookie(c, "__Host-mfa-challenge") || mfa_token;
    if (!challenge) return c.json({ error: "No challenge" }, 401);

    const userId = await verifyMfaChallenge(c.env.SESSION_SECRET, challenge);
    if (!userId) return c.json({ error: "Challenge expired" }, 401);

    if (!code) return c.json({ error: "Missing code" }, 400);

    const mfa = await c.env.DB.prepare(
      "SELECT totp_secret, totp_backup_codes FROM mfa WHERE user_id = ? AND totp_enabled = 1"
    ).bind(userId).first<{ totp_secret: string; totp_backup_codes: string | null }>();

    if (!mfa) return c.json({ error: "MFA not configured" }, 401);

    const { decryptDestination } = await import("../../lib/crypto");
    const { verifyTOTP, verifyBackupCode } = await import("../../lib/totp");

    const secret = await decryptDestination(mfa.totp_secret, c.env.DESTINATION_ENCRYPTION_KEY);

    let verified = false;

    if (/^\d{6}$/.test(code)) {
      verified = await verifyTOTP(secret, code);
    }

    if (!verified) {
      const normalized = code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
      if (normalized.length === 8) {
        const hashedCodes: string[] = mfa.totp_backup_codes ? JSON.parse(mfa.totp_backup_codes) : [];
        const idx = await verifyBackupCode(normalized, hashedCodes);
        if (idx !== -1) {
          hashedCodes.splice(idx, 1);
          await c.env.DB.prepare("UPDATE mfa SET totp_backup_codes = ? WHERE user_id = ?")
            .bind(JSON.stringify(hashedCodes), userId).run();
          verified = true;
        }
      }
    }

    if (!verified) {
      await recordFailedAttempt(ip, c.env.DB);
      return c.json({ error: "Invalid code" }, 401);
    }

    deleteCookie(c, "__Host-mfa-challenge", { path: "/", secure: true });
    const token = await setAuthenticatedCookies(c, userId);
    return c.json(wantsToken(c) ? { ok: true, userId, token } : { ok: true, userId });
  });

  // ── Passkey authentication (discoverable credentials, no passphrase needed) ──

  r.post("/passkey/challenge", async (c) => {
    const { generateAuthenticationOptions } = await import("@simplewebauthn/server");
    const { getRpFromOrigin } = await import("../../lib/webauthn");

    const { rpID } = getRpFromOrigin(c.req.header("origin"));

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      // Empty allowCredentials → browser shows all resident passkeys for this origin
    });

    const cookie = await signPasskeyAuthChallenge(c.env.SESSION_SECRET, options.challenge);
    setCookie(c, "__Host-passkey-challenge", cookie, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 300 });

    return c.json(options);
  });

  r.post("/passkey/verify", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || "unknown";
    if (!(await canAttempt(ip, c.env.DB))) {
      return c.json({ error: "Too many attempts" }, 429);
    }

    const cookie = getCookie(c, "__Host-passkey-challenge");
    if (!cookie) return c.json({ error: "No challenge" }, 401);

    const expectedChallenge = await verifyPasskeyAuthChallenge(c.env.SESSION_SECRET, cookie);
    if (!expectedChallenge) return c.json({ error: "Challenge expired" }, 401);

    const response = await c.req.json<AuthenticationResponseJSON>().catch(() => null);
    if (!response?.id) return c.json({ error: "Invalid request" }, 400);

    const cred = await c.env.DB.prepare(
      "SELECT user_id, public_key, sign_count, transports FROM passkey_credentials WHERE id = ?"
    ).bind(response.id).first<{ user_id: number; public_key: string; sign_count: number; transports: string | null }>();

    if (!cred) {
      await recordFailedAttempt(ip, c.env.DB);
      return c.json({ error: "Unknown credential" }, 401);
    }

    const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
    const { fromBase64url, getRpFromOrigin } = await import("../../lib/webauthn");
    const { rpID, expectedOrigin } = getRpFromOrigin(c.req.header("origin"));

    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: response.id,
        publicKey: fromBase64url(cred.public_key),
        counter: cred.sign_count,
        transports: cred.transports ? JSON.parse(cred.transports) : undefined,
      },
    }).catch(() => ({ verified: false as const, authenticationInfo: undefined }));

    if (!result.verified || !result.authenticationInfo) {
      await recordFailedAttempt(ip, c.env.DB);
      return c.json({ error: "Verification failed" }, 401);
    }

    if (cred.user_id !== 1) {
      const user = await c.env.DB.prepare("SELECT active FROM users WHERE id = ?")
        .bind(cred.user_id).first<{ active: number }>();
      if (!user || user.active === 0) return c.json({ error: "Account is disabled" }, 403);
    }

    await c.env.DB.prepare("UPDATE passkey_credentials SET sign_count = ? WHERE id = ?")
      .bind(result.authenticationInfo.newCounter, response.id).run();

    deleteCookie(c, "__Host-passkey-challenge", { path: "/", secure: true });
    await setAuthenticatedCookies(c, cred.user_id);

    return c.json({ ok: true, userId: cred.user_id });
  });

  r.post("/recover/send-code", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || "unknown";
    if (!(await canAttempt(ip, c.env.DB))) {
      return c.json({ error: "Too many attempts" }, 429);
    }

    const { token } = await c.req.json<{ token: string }>().catch(() => ({ token: "" }));
    if (!token) return c.json({ error: "Invalid request" }, 400);

    const db = c.env.DB;
    const user = await db.prepare(
      "SELECT id FROM users WHERE recovery_token = ? AND recovery_expires_at > ? AND active = 1"
    ).bind(token, Date.now()).first<{ id: number }>();

    if (!user) {
      await recordFailedAttempt(ip, c.env.DB);
      return c.json({ error: "Invalid or expired recovery token" }, 400);
    }

    const dest = await db.prepare("SELECT email FROM destinations WHERE user_id = ? AND is_default = 1").bind(user.id).first<{ email: string }>();
    if (!dest) return c.json({ error: "User has no default destination email" }, 400);

    const { decryptDestination } = await import("../../lib/crypto");
    const { sendRaw } = await import("../../lib/ses");
    const { buildMfaEmail } = await import("../../lib/emails");

    const email = await decryptDestination(dest.email, c.env.DESTINATION_ENCRYPTION_KEY);
    const code = randomSixDigitCode();

    await db.prepare("UPDATE users SET recovery_mfa_code = ? WHERE id = ?").bind(code, user.id).run();

    const sesAccessKeyId = await getEnvWithOverride(db, c.env, "ses_access_key_id");
    const sesSecretAccessKey = await getEnvWithOverride(db, c.env, "ses_secret_access_key");
    const sesRegion = await getEnvWithOverride(db, c.env, "ses_region");

    if (sesAccessKeyId && sesSecretAccessKey && sesRegion) {
      const mainGlobalDomain = await getMainGlobalDomain(db, c.env);
      await sendRaw({
        accessKeyId: sesAccessKeyId,
        secretAccessKey: sesSecretAccessKey,
        region: sesRegion
      }, {
        from: `HideMyEmail <noreply@${mainGlobalDomain}>`,
        to: email,
        rawBase64: buildMfaEmail(email, code, mainGlobalDomain)
      });
    }

    return c.json({ ok: true });
  });

  r.post("/recover/verify", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || "unknown";
    if (!(await canAttempt(ip, c.env.DB))) {
      return c.json({ error: "Too many attempts" }, 429);
    }

    const { token, code } = await c.req.json<{ token: string; code: string }>().catch(() => ({ token: "", code: "" }));
    if (!token || !code) return c.json({ error: "Invalid request" }, 400);

    const db = c.env.DB;
    const user = await db.prepare(
      "SELECT id FROM users WHERE recovery_token = ? AND recovery_mfa_code = ? AND recovery_expires_at > ? AND active = 1"
    ).bind(token, code, Date.now()).first<{ id: number }>();

    if (!user) {
      await recordFailedAttempt(ip, c.env.DB);
      return c.json({ error: "Invalid token or code" }, 400);
    }

    const { generatePassphrase } = await import("../../lib/passphrase");
    const newPassphrase = generatePassphrase();
    const hash = await derivePassphraseHash(newPassphrase, c.env.AUTH_PASSWORD_SALT);
    
    await db.prepare(
      "UPDATE users SET passphrase_hash = ?, recovery_token = NULL, recovery_expires_at = NULL, recovery_mfa_code = NULL WHERE id = ?"
    ).bind(hash, user.id).run();

    await db.prepare(
      "UPDATE mfa SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL WHERE user_id = ?"
    ).bind(user.id).run().catch((err: unknown) => {
      if (err instanceof Error && err.message.includes("no such table")) return;
      throw err;
    });

    // Log them in immediately
    await setAuthenticatedCookies(c, user.id);
    
    return c.json({ ok: true, passphrase: newPassphrase });
  });

  return r;
}
