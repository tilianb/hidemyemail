import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { verifyPassword, signFreshAuth, verifyFreshAuth, signSession, verifySession, derivePassphraseHash, signMfaChallenge, verifyMfaChallenge, signPasskeyAuthChallenge, verifyPasskeyAuthChallenge, signAppAuthCode, verifyAppAuthCode, sha256Base64url, timingSafeEqual } from "../../lib/auth";
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

async function setAuthenticatedCookies(c: Context<AppEnv>, userId: number): Promise<{ token: string; freshAuth: string }> {
  const sessionToken = await signSession(c.env.SESSION_SECRET, userId, SESSION_TTL);
  const freshAuthToken = await signFreshAuth(c.env.SESSION_SECRET, userId, FRESH_AUTH_TTL);
  setCookie(c, "__Host-session", sessionToken, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_TTL });
  setCookie(c, "__Host-fresh-auth", freshAuthToken, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: FRESH_AUTH_TTL });
  return { token: sessionToken, freshAuth: freshAuthToken };
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

  /**
   * POST /app-auth/code — first half of the web-session → native-app login
   * handoff (lets self-hosters use passkeys in the app even though the iOS
   * binary can only carry webcredentials for our own domain).
   *
   * Requires a logged-in dashboard session (cookie). Body: { challenge } —
   * base64url SHA-256 of a verifier held by the native app. Returns a
   * short-lived signed code bound to this user + challenge.
   */
  r.post("/app-auth/code", async (c) => {
    const sessionCookie = getCookie(c, "__Host-session");
    const userId = sessionCookie ? await verifySession(c.env.SESSION_SECRET, sessionCookie) : null;
    if (userId === null) return c.json({ error: "Unauthorized" }, 401);

    // Minting a code creates a NEW device credential (the exchanged bearer
    // token), so a stolen long-lived session cookie alone must not be enough —
    // require fresh auth, same as the other sensitive account operations.
    // This also narrows what same-origin XSS can do with the cookie jar to
    // the 10-minute window right after an interactive login.
    const freshAuth = getCookie(c, "__Host-fresh-auth");
    if (!freshAuth || !(await verifyFreshAuth(c.env.SESSION_SECRET, freshAuth, userId))) {
      return c.json({ error: "Fresh authentication required" }, 401);
    }

    const { challenge } = await c.req.json<{ challenge?: string }>().catch(() => ({ challenge: undefined }));
    // base64url SHA-256 is exactly 43 chars; reject anything else so the
    // challenge can never smuggle a delimiter into the signed payload.
    if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return c.json({ error: "Invalid challenge" }, 400);
    }

    const user = await c.env.DB.prepare("SELECT active FROM users WHERE id = ?")
      .bind(userId).first<{ active: number }>();
    if (!user || user.active === 0) return c.json({ error: "Account is disabled" }, 403);

    return c.json({ code: await signAppAuthCode(c.env.SESSION_SECRET, userId, challenge) });
  });

  /**
   * POST /app-auth/exchange — second half. Public (the app holds no auth yet),
   * IP-rate-limited. Body: { code, verifier }. Verifies the code's signature,
   * expiry, and that SHA-256(verifier) matches the embedded challenge, then
   * mints a bearer token. A stolen code is useless without the verifier.
   */
  r.post("/app-auth/exchange", async (c) => {
    // Native-only, same unspoofable signal as wantsToken(): browsers pin the
    // forbidden Origin header onto every POST, native HTTP stacks send none.
    // Without this, same-origin JS could mint a code with the cookie jar and
    // exchange it here, converting an HttpOnly session into an exfiltratable
    // bearer token — exactly what the wantsToken() Origin check prevents on
    // the login endpoints.
    if (c.req.header("Origin")) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const ip = c.req.header("cf-connecting-ip") || "unknown";
    if (!(await canAttempt(ip, c.env.DB))) {
      return c.json({ error: "Too many attempts" }, 429);
    }

    const { code, verifier } = await c.req.json<{ code?: string; verifier?: string }>()
      .catch(() => ({ code: undefined, verifier: undefined }));
    if (!code || !verifier) return c.json({ error: "Missing code or verifier" }, 400);

    const parsed = await verifyAppAuthCode(c.env.SESSION_SECRET, code);
    if (!parsed || !timingSafeEqual(await sha256Base64url(verifier), parsed.challenge)) {
      await recordFailedAttempt(ip, c.env.DB);
      return c.json({ error: "Invalid or expired code" }, 401);
    }

    const user = await c.env.DB.prepare("SELECT active FROM users WHERE id = ?")
      .bind(parsed.userId).first<{ active: number }>();
    if (!user || user.active === 0) return c.json({ error: "Account is disabled" }, 403);

    const token = await signSession(c.env.SESSION_SECRET, parsed.userId, SESSION_TTL);
    // The user just completed an interactive web login seconds ago, so the
    // exchanged session is as fresh as a direct token-mode login.
    const freshAuth = await signFreshAuth(c.env.SESSION_SECRET, parsed.userId, FRESH_AUTH_TTL);
    return c.json({ ok: true, userId: parsed.userId, token, fresh_auth: freshAuth });
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
      const user = await c.env.DB.prepare(
        "SELECT id, active, deleted_at FROM users WHERE passphrase_hash = ?"
      ).bind(hash).first<{ id: number; active: number; deleted_at: number | null }>();

      if (!user) {
        await recordFailedAttempt(ip, c.env.DB);
        return c.json({ error: "Invalid passphrase" }, 401);
      }
      if (user.deleted_at !== null) {
        // Account is tombstoned — pending purge. Checked BEFORE active
        // (deletion also sets active=0): `deleted: true` lets the dashboard
        // offer POST /restore during the 7-day grace window instead of a
        // dead-end "disabled" error.
        return c.json({ error: "Account has been deleted", deleted: true }, 403);
      }
      if (user.active === 0) {
        // Correct passphrase but disabled account — not a brute-force attempt.
        return c.json({ error: "Account is disabled" }, 403);
      }
      userId = user.id;
    }

    if (!userId) {
      await recordFailedAttempt(ip, c.env.DB);
      return c.json({ error: "Invalid" }, 401);
    }

    const mfa = await c.env.DB.prepare(
      "SELECT totp_enabled FROM mfa WHERE user_id = ?"
    ).bind(userId).first<{ totp_enabled: number }>();

    if (mfa?.totp_enabled === 1) {
      const challenge = await signMfaChallenge(c.env.SESSION_SECRET, userId);
      setCookie(c, "__Host-mfa-challenge", challenge, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 300 });
      // Native clients carry the short-lived challenge themselves since they
      // can't rely on the __Host-mfa-challenge cookie round-trip.
      return c.json(wantsToken(c) ? { mfa_required: true, mfa_token: challenge } : { mfa_required: true });
    }

    const { token, freshAuth } = await setAuthenticatedCookies(c, userId);
    return c.json(wantsToken(c) ? { ok: true, userId, token, fresh_auth: freshAuth } : { ok: true, userId });
  });

  /**
   * POST /restore
   * Body: { password: string }
   * Cancels a pending account deletion during the 7-day grace window. Public
   * (the tombstoned user cannot log in), authenticated by passphrase and
   * IP-rate-limited like /login. Restoring re-enables login and forwarding;
   * with MFA enabled the restored account still requires MFA to log in.
   */
  r.post("/restore", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || "unknown";
    if (!(await canAttempt(ip, c.env.DB))) {
      return c.json({ error: "Too many attempts" }, 429);
    }

    const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: "" }));
    if (!password) return c.json({ error: "Password is required" }, 400);

    const hash = await derivePassphraseHash(password, c.env.AUTH_PASSWORD_SALT);
    const user = await c.env.DB.prepare(
      "SELECT id, deleted_at FROM users WHERE passphrase_hash = ?"
    ).bind(hash).first<{ id: number; deleted_at: number | null }>();

    if (!user) {
      // Wrong passphrase, or the grace period elapsed and the purge already
      // removed the account — indistinguishable by design.
      await recordFailedAttempt(ip, c.env.DB);
      return c.json({ error: "Invalid passphrase or account no longer exists" }, 401);
    }
    if (user.deleted_at === null) {
      return c.json({ error: "Account is not scheduled for deletion" }, 400);
    }
    // Enforce the 7-day grace window independently of purge timing: the cron
    // runs daily (and self-hosted cron can lag), so a tombstone may outlive the
    // window before purgeDeletedAccounts() removes it. Mirror the purge cutoff
    // (deleted_at <= now - 7d) and treat an elapsed window like an account that
    // no longer exists — indistinguishable from a wrong passphrase by design.
    const graceCutoff = Date.now() - 7 * 24 * 3_600_000;
    if (user.deleted_at <= graceCutoff) {
      await recordFailedAttempt(ip, c.env.DB);
      return c.json({ error: "Invalid passphrase or account no longer exists" }, 401);
    }

    await c.env.DB.prepare(
      "UPDATE users SET deleted_at = NULL, active = 1, forwarding = 1 WHERE id = ?"
    ).bind(user.id).run();

    return c.json({ ok: true });
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
      // Generate self-service recovery codes up front so a brand-new account
      // is recoverable from the very first session. Plaintext is returned once
      // here for the client to surface ("save these"); only hashes are stored.
      const { generateRecoveryCodes } = await import("../../lib/recovery");
      const { plain, hashed } = await generateRecoveryCodes();

      const res = await c.env.DB.prepare(
        "INSERT INTO users (passphrase_hash, created_at, recovery_codes) VALUES (?, ?, ?)"
      ).bind(hash, Date.now(), JSON.stringify(hashed)).run();

      const userId = res.meta.last_row_id;
      const { token, freshAuth } = await setAuthenticatedCookies(c, userId);
      return c.json(wantsToken(c)
        ? { ok: true, userId, token, fresh_auth: freshAuth, recovery_codes: plain }
        : { ok: true, userId, recovery_codes: plain });
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
    const { token, freshAuth } = await setAuthenticatedCookies(c, userId);
    return c.json(wantsToken(c) ? { ok: true, userId, token, fresh_auth: freshAuth } : { ok: true, userId });
  });

  // ── Passkey authentication (discoverable credentials, no passphrase needed) ──

  r.post("/passkey/challenge", async (c) => {
    const { generateAuthenticationOptions } = await import("@simplewebauthn/server");
    const { getRpFromOrigin } = await import("../../lib/webauthn");

    // Native clients send no Origin; fall back to the configured app origin so
    // the rpID matches the iOS associated-domains entitlement (app.hidemyemail.dev).
    const origin = c.req.header("origin") || c.env.APP_ORIGIN || "https://app.hidemyemail.dev";
    const { rpID } = getRpFromOrigin(origin);

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      // Empty allowCredentials → browser shows all resident passkeys for this origin
    });

    const cookie = await signPasskeyAuthChallenge(c.env.SESSION_SECRET, options.challenge);
    setCookie(c, "__Host-passkey-challenge", cookie, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 300 });

    // Token-mode (native) clients can't persist the HttpOnly cookie, so echo the
    // signed challenge token in the body to round-trip back on verify.
    return c.json(wantsToken(c) ? { ...options, passkey_token: cookie } : options);
  });

  r.post("/passkey/verify", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || "unknown";
    if (!(await canAttempt(ip, c.env.DB))) {
      return c.json({ error: "Too many attempts" }, 429);
    }

    // Read the assertion first: native clients carry the challenge token in the
    // body (`passkey_token`) because they have no cookie jar.
    const response = await c.req.json<AuthenticationResponseJSON & { passkey_token?: string }>().catch(() => null);
    if (!response?.id) return c.json({ error: "Invalid request" }, 400);

    const cookie = getCookie(c, "__Host-passkey-challenge") || response.passkey_token || null;
    if (!cookie) return c.json({ error: "No challenge" }, 401);

    const expectedChallenge = await verifyPasskeyAuthChallenge(c.env.SESSION_SECRET, cookie);
    if (!expectedChallenge) return c.json({ error: "Challenge expired" }, 401);

    const cred = await c.env.DB.prepare(
      "SELECT user_id, public_key, sign_count, transports FROM passkey_credentials WHERE id = ?"
    ).bind(response.id).first<{ user_id: number; public_key: string; sign_count: number; transports: string | null }>();

    if (!cred) {
      await recordFailedAttempt(ip, c.env.DB);
      return c.json({ error: "Unknown credential" }, 401);
    }

    const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
    const { fromBase64url, getRpFromOrigin } = await import("../../lib/webauthn");
    const origin = c.req.header("origin") || c.env.APP_ORIGIN || "https://app.hidemyemail.dev";
    const { rpID, expectedOrigin } = getRpFromOrigin(origin);

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
    const { token, freshAuth } = await setAuthenticatedCookies(c, cred.user_id);

    return c.json(wantsToken(c) ? { ok: true, userId: cred.user_id, token, fresh_auth: freshAuth } : { ok: true, userId: cred.user_id });
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
    ).bind(user.id).run();

    // Log them in immediately
    await setAuthenticatedCookies(c, user.id);

    return c.json({ ok: true, passphrase: newPassphrase });
  });

  /**
   * POST /recover/code — self-service recovery with username + recovery code.
   * Body: { username, code }. No admin and no destination email required: the
   * username says WHICH account, the one-time recovery code is the secret proof.
   * On success the code is consumed, a new passphrase is issued, MFA is cleared
   * (mirrors /recover/verify — a possession factor resets the account), and the
   * user is logged in. Rate-limited on the shared per-IP failure budget.
   */
  r.post("/recover/code", async (c) => {
    const ip = c.req.header("cf-connecting-ip") || "unknown";
    if (!(await canAttempt(ip, c.env.DB))) {
      return c.json({ error: "Too many attempts" }, 429);
    }

    const { username, code } = await c.req.json<{ username?: string; code?: string }>()
      .catch(() => ({ username: undefined, code: undefined }));
    if (!username || !code) return c.json({ error: "Invalid request" }, 400);

    const db = c.env.DB;
    const user = await db.prepare(
      "SELECT id, recovery_codes FROM users WHERE lower(username) = lower(?) AND active = 1 AND deleted_at IS NULL"
    ).bind(username).first<{ id: number; recovery_codes: string | null }>();

    // Unknown username and wrong code are indistinguishable by design — both
    // consume rate-limit budget and return the same generic error.
    if (!user || !user.recovery_codes) {
      await recordFailedAttempt(ip, c.env.DB);
      return c.json({ error: "Invalid username or recovery code" }, 400);
    }

    const { verifyBackupCode } = await import("../../lib/totp");
    let hashed: string[];
    try {
      hashed = JSON.parse(user.recovery_codes);
      if (!Array.isArray(hashed)) throw new Error("bad");
    } catch {
      await recordFailedAttempt(ip, c.env.DB);
      return c.json({ error: "Invalid username or recovery code" }, 400);
    }

    const idx = await verifyBackupCode(code, hashed);
    if (idx === -1) {
      await recordFailedAttempt(ip, c.env.DB);
      return c.json({ error: "Invalid username or recovery code" }, 400);
    }

    // Consume the used code so it can't be replayed.
    hashed.splice(idx, 1);

    const { generatePassphrase } = await import("../../lib/passphrase");
    const newPassphrase = generatePassphrase();
    const newHash = await derivePassphraseHash(newPassphrase, c.env.AUTH_PASSWORD_SALT);

    await db.prepare(
      "UPDATE users SET passphrase_hash = ?, recovery_codes = ?, recovery_token = NULL, recovery_expires_at = NULL, recovery_mfa_code = NULL WHERE id = ?"
    ).bind(newHash, JSON.stringify(hashed), user.id).run();

    await db.prepare(
      "UPDATE mfa SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL WHERE user_id = ?"
    ).bind(user.id).run();

    const { token, freshAuth } = await setAuthenticatedCookies(c, user.id);
    return c.json(wantsToken(c)
      ? { ok: true, userId: user.id, passphrase: newPassphrase, codes_remaining: hashed.length, token, fresh_auth: freshAuth }
      : { ok: true, passphrase: newPassphrase, codes_remaining: hashed.length });
  });

  return r;
}
