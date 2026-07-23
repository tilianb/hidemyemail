import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import type { AppEnv } from "../app";
import { verifyPassword, signFreshAuth, verifyFreshAuth, signSession, verifySession, derivePassphraseHash, createPassphraseVerifier, verifyPassphraseVerifier, signMfaChallenge, verifyMfaChallenge, signPasskeyAuthChallenge, verifyPasskeyAuthChallenge, updatePasskeySignCount } from "../../lib/auth";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { getEnvWithOverride, getMainGlobalDomain } from "../../lib/settings";
import { consumeAuthArtifact, markFailedAttempt, rateLimitFailures } from "../../lib/auth-security";
import { randomSixDigitCode, setAuthenticatedCookies, wantsToken } from "../auth-route-helpers";

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
const FRESH_AUTH_TTL = 60 * 10; // 10 minutes
export function authRoutes() {
  const r = new Hono<AppEnv>();
  for (const path of ["/login", "/restore", "/register", "/mfa/complete", "/passkey/verify", "/recover/send-code", "/recover/verify", "/recover/code"]) {
    r.use(path, rateLimitFailures());
  }

  r.get("/config", async (c) => {
    const main_global_domain = await getMainGlobalDomain(c.env.DB, c.env);
    const { getBoolSetting, getNumericSetting } = await import("../../lib/settings");
    const max_subdomains = await getNumericSetting(c.env.DB, "max_subdomains");
    const max_total_aliases = await getNumericSetting(c.env.DB, "max_total_aliases");
    const registration_enabled = await getBoolSetting(c.env.DB, "registration_enabled");
    const alias_quota_buffer_enabled = await getBoolSetting(c.env.DB, "alias_quota_buffer_enabled");
    const catch_all_auto_create = await getBoolSetting(c.env.DB, "catch_all_auto_create");
    const inline_actions_default_enabled = await getBoolSetting(c.env.DB, "inline_actions_default_enabled");
    return c.json({
      main_global_domain,
      max_subdomains,
      max_total_aliases,
      registration_enabled,
      alias_quota_buffer_enabled,
      catch_all_auto_create,
      inline_actions_default_enabled,
    });
  });

  r.post("/login", async (c) => {
    const { password } = await c.req.json<{ password: string }>().catch(() => ({ password: "" }));

    let userId: number | null = null;
    let authVersion: number | null = null;

    const isAdmin = await verifyPassword(password, c.env.AUTH_PASSWORD_SALT, c.env.AUTH_PASSWORD_HASH);
    if (isAdmin) {
      const admin = await c.env.DB.prepare("SELECT auth_version FROM users WHERE id = 1")
        .first<{ auth_version: number }>();
      if (admin) {
        userId = 1;
        authVersion = admin.auth_version;
      }
    } else {
      const hash = await derivePassphraseHash(password, c.env.AUTH_PASSWORD_SALT);
      const user = await c.env.DB.prepare(
        "SELECT id, active, deleted_at, auth_version, passphrase_verifier FROM users WHERE passphrase_hash = ?"
      ).bind(hash).first<{ id: number; active: number; deleted_at: number | null; auth_version: number; passphrase_verifier: string | null }>();

      if (!user || (user.passphrase_verifier && !(await verifyPassphraseVerifier(password, user.passphrase_verifier)))) {
        markFailedAttempt(c);
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
      if (!user.passphrase_verifier) {
        await c.env.DB.prepare("UPDATE users SET passphrase_verifier = ? WHERE id = ? AND passphrase_verifier IS NULL")
          .bind(await createPassphraseVerifier(password), user.id).run();
      }
      userId = user.id;
      authVersion = user.auth_version;
    }

    if (userId === null || authVersion === null) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid" }, 401);
    }

    const mfa = await c.env.DB.prepare(
      "SELECT totp_enabled FROM mfa WHERE user_id = ?"
    ).bind(userId).first<{ totp_enabled: number }>();

    if (mfa?.totp_enabled === 1) {
      const challenge = await signMfaChallenge(c.env.SESSION_SECRET, userId, authVersion);
      setCookie(c, "__Host-mfa-challenge", challenge, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 300 });
      // Native clients carry the short-lived challenge themselves since they
      // can't rely on the __Host-mfa-challenge cookie round-trip.
      return c.json(wantsToken(c) ? { mfa_required: true, mfa_token: challenge } : { mfa_required: true });
    }

    const { token, freshAuth } = await setAuthenticatedCookies(c, userId, authVersion);
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
    const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: "" }));
    if (!password) return c.json({ error: "Password is required" }, 400);

    const hash = await derivePassphraseHash(password, c.env.AUTH_PASSWORD_SALT);
    const user = await c.env.DB.prepare(
      "SELECT id, deleted_at FROM users WHERE passphrase_hash = ?"
    ).bind(hash).first<{ id: number; deleted_at: number | null }>();

    if (!user) {
      // Wrong passphrase, or the grace period elapsed and the purge already
      // removed the account — indistinguishable by design.
      markFailedAttempt(c);
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
      markFailedAttempt(c);
      return c.json({ error: "Invalid passphrase or account no longer exists" }, 401);
    }

    await c.env.DB.prepare(
      "UPDATE users SET deleted_at = NULL, active = 1, forwarding = 1 WHERE id = ?"
    ).bind(user.id).run();

    return c.json({ ok: true });
  });

  r.post("/register", async (c) => {
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
    const verifier = await createPassphraseVerifier(password);

    try {
      // Generate self-service recovery codes up front so a brand-new account
      // is recoverable from the very first session. Plaintext is returned once
      // here for the client to surface ("save these"); only hashes are stored.
      const { generateRecoveryCodes } = await import("../../lib/recovery");
      const { plain, hashed } = await generateRecoveryCodes();

      const res = await c.env.DB.prepare(
        "INSERT INTO users (passphrase_hash, passphrase_verifier, created_at, recovery_codes) VALUES (?, ?, ?, ?)"
      ).bind(hash, verifier, Date.now(), JSON.stringify(hashed)).run();

      const userId = res.meta.last_row_id;
      const { token, freshAuth } = await setAuthenticatedCookies(c, userId, 0);
      return c.json(wantsToken(c)
        ? { ok: true, userId, token, fresh_auth: freshAuth, recovery_codes: plain }
        : { ok: true, userId, recovery_codes: plain });
    } catch (err: any) {
      if (err.message && err.message.includes("UNIQUE constraint failed")) {
        markFailedAttempt(c);
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
    const { code, mfa_token } = await c.req.json<{ code: string; mfa_token?: string }>().catch(() => ({ code: "", mfa_token: undefined }));

    // Cookie for the web app; body fallback (mfa_token) for native bearer clients.
    const challenge = getCookie(c, "__Host-mfa-challenge") || mfa_token;
    if (!challenge) return c.json({ error: "No challenge" }, 401);

    const principal = await verifyMfaChallenge(c.env.SESSION_SECRET, challenge);
    if (!principal) return c.json({ error: "Challenge expired" }, 401);
    const { userId } = principal;

    if (!code) return c.json({ error: "Missing code" }, 400);

    const mfa = await c.env.DB.prepare(
      "SELECT m.totp_secret, m.totp_backup_codes, u.auth_version FROM mfa m JOIN users u ON u.id = m.user_id WHERE m.user_id = ? AND m.totp_enabled = 1"
    ).bind(userId).first<{ totp_secret: string; totp_backup_codes: string | null; auth_version: number }>();

    if (!mfa) return c.json({ error: "MFA not configured" }, 401);
    if (mfa.auth_version !== principal.authVersion) return c.json({ error: "Challenge expired" }, 401);

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
          const consumed = await c.env.DB.prepare(
            "UPDATE mfa SET totp_backup_codes = ? WHERE user_id = ? AND totp_backup_codes = ?"
          ).bind(JSON.stringify(hashedCodes), userId, mfa.totp_backup_codes).run();
          verified = consumed.meta.changes === 1;
        }
      }
    }

    if (!verified) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid code" }, 401);
    }

    deleteCookie(c, "__Host-mfa-challenge", { path: "/", secure: true });
    const { token, freshAuth } = await setAuthenticatedCookies(c, userId, principal.authVersion);
    return c.json(wantsToken(c) ? { ok: true, userId, token, fresh_auth: freshAuth } : { ok: true, userId });
  });

  // ── Passkey authentication (discoverable credentials, no passphrase needed) ──

  r.post("/passkey/challenge", async (c) => {
    const { generateAuthenticationOptions } = await import("@simplewebauthn/server");
    const { getRpFromOrigin } = await import("../../lib/webauthn");

    let rpID: string;
    try {
      ({ rpID } = getRpFromOrigin(c.env.APP_ORIGIN));
    } catch {
      return c.json({ error: "Passkey authentication is not configured" }, 500);
    }

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
    // Read the assertion first: native clients carry the challenge token in the
    // body (`passkey_token`) because they have no cookie jar.
    const response = await c.req.json<AuthenticationResponseJSON & { passkey_token?: string }>().catch(() => null);
    if (!response?.id) return c.json({ error: "Invalid request" }, 400);

    const cookie = getCookie(c, "__Host-passkey-challenge") || response.passkey_token || null;
    if (!cookie) return c.json({ error: "No challenge" }, 401);

    const expectedChallenge = await verifyPasskeyAuthChallenge(c.env.SESSION_SECRET, cookie);
    if (!expectedChallenge) return c.json({ error: "Challenge expired" }, 401);

    const cred = await c.env.DB.prepare(
      "SELECT p.user_id, p.public_key, p.sign_count, p.transports, u.auth_version FROM passkey_credentials p JOIN users u ON u.id = p.user_id WHERE p.id = ?"
    ).bind(response.id).first<{ user_id: number; public_key: string; sign_count: number; transports: string | null; auth_version: number }>();

    if (!cred) {
      markFailedAttempt(c);
      return c.json({ error: "Unknown credential" }, 401);
    }

    const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
    const { fromBase64url, getRpFromOrigin } = await import("../../lib/webauthn");
    let rpID: string;
    let expectedOrigin: string;
    try {
      ({ rpID, expectedOrigin } = getRpFromOrigin(c.env.APP_ORIGIN));
    } catch {
      return c.json({ error: "Passkey authentication is not configured" }, 500);
    }

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
      markFailedAttempt(c);
      return c.json({ error: "Verification failed" }, 401);
    }
    if (!(await consumeAuthArtifact(c.env.DB, cookie, Math.floor(Date.now() / 1000) + 300))) {
      return c.json({ error: "Challenge expired" }, 401);
    }

    if (cred.user_id !== 1) {
      const user = await c.env.DB.prepare("SELECT active FROM users WHERE id = ?")
        .bind(cred.user_id).first<{ active: number }>();
      if (!user || user.active === 0) return c.json({ error: "Account is disabled" }, 403);
    }

    await updatePasskeySignCount(c.env.DB, response.id, result.authenticationInfo.newCounter);

    deleteCookie(c, "__Host-passkey-challenge", { path: "/", secure: true });
    const { token, freshAuth } = await setAuthenticatedCookies(c, cred.user_id, cred.auth_version);

    return c.json(wantsToken(c) ? { ok: true, userId: cred.user_id, token, fresh_auth: freshAuth } : { ok: true, userId: cred.user_id });
  });

  r.post("/recover/send-code", async (c) => {
    const { token } = await c.req.json<{ token: string }>().catch(() => ({ token: "" }));
    if (!token) return c.json({ error: "Invalid request" }, 400);

    const db = c.env.DB;
    const user = await db.prepare(
      "SELECT id FROM users WHERE recovery_token = ? AND recovery_expires_at > ? AND active = 1"
    ).bind(token, Date.now()).first<{ id: number }>();

    if (!user) {
      markFailedAttempt(c);
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
    const { token, code } = await c.req.json<{ token: string; code: string }>().catch(() => ({ token: "", code: "" }));
    if (!token || !code) return c.json({ error: "Invalid request" }, 400);

    const db = c.env.DB;
    const user = await db.prepare(
      "SELECT id, recovery_expires_at, auth_version FROM users WHERE recovery_token = ? AND recovery_mfa_code = ? AND recovery_expires_at > ? AND active = 1"
    ).bind(token, code, Date.now()).first<{ id: number; recovery_expires_at: number; auth_version: number }>();

    if (!user) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid token or code" }, 400);
    }

    const { generatePassphrase } = await import("../../lib/passphrase");
    const newPassphrase = generatePassphrase();
    const hash = await derivePassphraseHash(newPassphrase, c.env.AUTH_PASSWORD_SALT);
    const verifier = await createPassphraseVerifier(newPassphrase);
    const nextVersion = user.auth_version + 1;
    const [consumed] = await db.batch([
      db.prepare(
        "UPDATE users SET passphrase_hash = ?, passphrase_verifier = ?, recovery_token = NULL, recovery_expires_at = NULL, recovery_mfa_code = NULL, auth_version = ? WHERE id = ? AND recovery_token = ? AND recovery_mfa_code = ? AND recovery_expires_at = ? AND recovery_expires_at > ? AND auth_version = ? AND active = 1"
      ).bind(hash, verifier, nextVersion, user.id, token, code, user.recovery_expires_at, Date.now(), user.auth_version),
      db.prepare(
        "UPDATE mfa SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND passphrase_hash = ? AND auth_version = ?)"
      ).bind(user.id, user.id, hash, nextVersion),
      db.prepare("DELETE FROM passkey_credentials WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND passphrase_hash = ? AND auth_version = ?)").bind(user.id, user.id, hash, nextVersion),
      db.prepare("DELETE FROM api_keys WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND passphrase_hash = ? AND auth_version = ?)").bind(user.id, user.id, hash, nextVersion),
    ]);
    if (consumed?.meta.changes !== 1) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid token or code" }, 400);
    }

    // Log them in immediately
    await setAuthenticatedCookies(c, user.id, nextVersion);

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
    const { username, code } = await c.req.json<{ username?: string; code?: string }>()
      .catch(() => ({ username: undefined, code: undefined }));
    if (!username || !code) return c.json({ error: "Invalid request" }, 400);

    const db = c.env.DB;
    const user = await db.prepare(
      "SELECT id, recovery_codes, auth_version FROM users WHERE lower(username) = lower(?) AND active = 1 AND deleted_at IS NULL"
    ).bind(username).first<{ id: number; recovery_codes: string | null; auth_version: number }>();

    // Unknown username and wrong code are indistinguishable by design — both
    // consume rate-limit budget and return the same generic error.
    if (!user || !user.recovery_codes) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid username or recovery code" }, 400);
    }

    const { verifyBackupCode } = await import("../../lib/totp");
    let hashed: string[];
    try {
      hashed = JSON.parse(user.recovery_codes);
      if (!Array.isArray(hashed)) throw new Error("bad");
    } catch {
      markFailedAttempt(c);
      return c.json({ error: "Invalid username or recovery code" }, 400);
    }

    const idx = await verifyBackupCode(code, hashed);
    if (idx === -1) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid username or recovery code" }, 400);
    }

    // Consume the used code so it can't be replayed.
    hashed.splice(idx, 1);

    const { generatePassphrase } = await import("../../lib/passphrase");
    const newPassphrase = generatePassphrase();
    const newHash = await derivePassphraseHash(newPassphrase, c.env.AUTH_PASSWORD_SALT);
    const verifier = await createPassphraseVerifier(newPassphrase);
    const nextVersion = user.auth_version + 1;
    const [consumed] = await db.batch([
      db.prepare(
        "UPDATE users SET passphrase_hash = ?, passphrase_verifier = ?, recovery_codes = ?, recovery_token = NULL, recovery_expires_at = NULL, recovery_mfa_code = NULL, auth_version = ? WHERE id = ? AND recovery_codes = ? AND auth_version = ? AND active = 1 AND deleted_at IS NULL"
      ).bind(newHash, verifier, JSON.stringify(hashed), nextVersion, user.id, user.recovery_codes, user.auth_version),
      db.prepare(
        "UPDATE mfa SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND passphrase_hash = ? AND auth_version = ?)"
      ).bind(user.id, user.id, newHash, nextVersion),
      db.prepare("DELETE FROM passkey_credentials WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND passphrase_hash = ? AND auth_version = ?)").bind(user.id, user.id, newHash, nextVersion),
      db.prepare("DELETE FROM api_keys WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND passphrase_hash = ? AND auth_version = ?)").bind(user.id, user.id, newHash, nextVersion),
    ]);
    if (consumed?.meta.changes !== 1) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid username or recovery code" }, 400);
    }

    const { token, freshAuth } = await setAuthenticatedCookies(c, user.id, nextVersion);
    return c.json(wantsToken(c)
      ? { ok: true, userId: user.id, passphrase: newPassphrase, codes_remaining: hashed.length, token, fresh_auth: freshAuth }
      : { ok: true, passphrase: newPassphrase, codes_remaining: hashed.length });
  });

  return r;
}
