import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import type { AppEnv } from "../app";
import { verifyPassword, signFreshAuth, verifyFreshAuth, signSession, verifySession, derivePassphraseHash, createPassphraseVerifier, verifyPassphraseVerifier, signMfaChallenge, verifyMfaChallenge, signPasskeyAuthChallenge, verifyPasskeyAuthChallenge, signPasskeyMfaChallenge, verifyPasskeyMfaChallenge, passkeyArtifactExpiresAt, sha256Base64url, timingSafeEqual } from "../../lib/auth";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { getEnvWithOverride, getMainGlobalDomain } from "../../lib/settings";
import { consumeAuthArtifact, finalizeMfaBackupCode, finalizeMfaTotp, finalizePasskeyAssertion, markFailedAttempt, rateLimitFailures } from "../../lib/auth-security";
import { clearAuthenticatedCookies, randomSixDigitCode, setAuthenticatedCookies, wantsToken } from "../auth-route-helpers";
import { recoveryDigest } from "../../lib/recovery-auth";
import { getRpFromOrigin } from "../../lib/webauthn";

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
const FRESH_AUTH_TTL = 60 * 10; // 10 minutes
export function authRoutes() {
  const r = new Hono<AppEnv>();
  const jsonMutations = ["/login", "/register", "/restore", "/mfa/complete", "/passkey/challenge", "/passkey/verify", "/recover/send-code", "/recover/verify", "/recover/code", "/logout"];
  for (const path of jsonMutations) r.use(path, async (c, next) => {
    if ((c.req.header("Content-Type") ?? "").split(";", 1)[0]!.trim().toLowerCase() !== "application/json") {
      return c.json({ error: "Content-Type must be application/json" }, 415);
    }
    await next();
  });
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
   * credentials revoked during deletion remain revoked.
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

  r.post("/logout", async (c) => {
    const origin = c.req.header("Origin");
    if (origin) {
      let canonicalOrigin: string;
      try { canonicalOrigin = getRpFromOrigin(c.env.APP_ORIGIN).expectedOrigin; }
      catch { return c.json({ error: "Application origin is not configured" }, 500); }
      if (origin !== canonicalOrigin) return c.json({ error: "Forbidden" }, 403);
    }
    const tokens = new Set<string>();
    const cookieToken = getCookie(c, "__Host-session");
    if (cookieToken) tokens.add(cookieToken);
    const header = c.req.header("Authorization");
    if (header?.startsWith("Bearer ")) tokens.add(header.slice(7).trim());
    for (const token of tokens) {
      const principal = await verifySession(c.env.SESSION_SECRET, token);
      if (principal) {
        const { revokeSession } = await import("../../lib/session-revocation");
        await revokeSession(c.env.DB, token, principal.expiresAt);
      }
    }
    clearAuthenticatedCookies(c);
    c.header("Clear-Site-Data", '"cookies", "storage", "cache"');
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true });
  });

  r.post("/mfa/complete", async (c) => {
    const { code, mfa_token } = await c.req.json<{ code: string; mfa_token?: string }>().catch(() => ({ code: "", mfa_token: undefined }));

    // Keep web artifacts HttpOnly and native artifacts explicitly body-carried.
    const challenge = wantsToken(c) ? mfa_token ?? null : getCookie(c, "__Host-mfa-challenge") ?? null;
    if (!challenge) return c.json({ error: "No challenge" }, 401);

    const principal = await verifyMfaChallenge(c.env.SESSION_SECRET, challenge);
    if (!principal) return c.json({ error: "Challenge expired" }, 401);
    const { userId } = principal;

    if (!code) return c.json({ error: "Missing code" }, 400);

    const mfa = await c.env.DB.prepare(
      "SELECT m.totp_secret, m.totp_backup_codes, m.totp_last_used_counter, u.auth_version FROM mfa m JOIN users u ON u.id = m.user_id WHERE m.user_id = ? AND m.totp_enabled = 1"
    ).bind(userId).first<{ totp_secret: string; totp_backup_codes: string | null; totp_last_used_counter: number | null; auth_version: number }>();

    if (!mfa) return c.json({ error: "MFA not configured" }, 401);
    if (mfa.auth_version !== principal.authVersion) return c.json({ error: "Challenge expired" }, 401);

    const { decryptDestination } = await import("../../lib/crypto");
    const { verifyTOTP, verifyBackupCode } = await import("../../lib/totp");

    const secret = await decryptDestination(mfa.totp_secret, c.env.DESTINATION_ENCRYPTION_KEY);

    let verified = false;
    let backupCode = false;
    let totpCounter: number | null = null;

    if (/^\d{6}$/.test(code)) {
      totpCounter = await verifyTOTP(secret, code);
      const lastCounter = mfa.totp_last_used_counter;
      verified = totpCounter !== null && (lastCounter === null || totpCounter > lastCounter);
    }

    if (!verified) {
      const normalized = code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
      if (normalized.length === 26) {
        const hashedCodes: string[] = mfa.totp_backup_codes ? JSON.parse(mfa.totp_backup_codes) : [];
        const idx = await verifyBackupCode(normalized, hashedCodes);
        if (idx !== -1) {
          backupCode = true;
          verified = true;
        }
      }
    }

    if (!verified) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid code" }, 401);
    }

    if (backupCode) {
      let committed = false;
      // A different challenge may consume a different code after our initial
      // read. Retry once against that new list so independent logins do not
      // invalidate each other; replayed parents still lose the artifact insert.
      for (let attempt = 0; attempt < 2 && !committed; attempt++) {
        const codesJson = attempt === 0
          ? mfa.totp_backup_codes
          : (await c.env.DB.prepare("SELECT totp_backup_codes FROM mfa WHERE user_id = ?")
              .bind(userId).first<{ totp_backup_codes: string | null }>())?.totp_backup_codes ?? null;
        const hashedCodes: string[] = codesJson ? JSON.parse(codesJson) : [];
        const idx = await verifyBackupCode(code, hashedCodes);
        if (idx === -1) break;
        hashedCodes.splice(idx, 1);
        committed = await finalizeMfaBackupCode(
          c.env.DB, challenge, principal.expiresAt, userId, codesJson!, JSON.stringify(hashedCodes),
        );
      }
      if (!committed) {
        markFailedAttempt(c);
        return c.json({ error: "Challenge expired" }, 401);
      }
    } else {
      if (!(await finalizeMfaTotp(c.env.DB, challenge, principal.expiresAt, userId, totpCounter!))) {
        markFailedAttempt(c);
        return c.json({ error: "Challenge expired" }, 401);
      }
    }

    deleteCookie(c, "__Host-mfa-challenge", { path: "/", secure: true });
    const { token, freshAuth } = await setAuthenticatedCookies(c, userId, principal.authVersion);
    return c.json(wantsToken(c) ? { ok: true, userId, token, fresh_auth: freshAuth } : { ok: true, userId });
  });

  // ── Passkey authentication (discoverable credentials, no passphrase needed) ──

  r.post("/passkey/challenge", async (c) => {
    const { generateAuthenticationOptions } = await import("@simplewebauthn/server");
    const { getRpFromOrigin } = await import("../../lib/webauthn");
    const body: { mfa?: true; mfa_token?: string } = await c.req.json<{ mfa?: true; mfa_token?: string }>().catch(() => ({}));
    const mfaMode = body.mfa === true;

    let rpID: string;
    try {
      ({ rpID } = getRpFromOrigin(c.env.APP_ORIGIN));
    } catch {
      return c.json({ error: "Passkey authentication is not configured" }, 500);
    }

    let mfaPrincipal: { userId: number; authVersion: number; expiresAt: number } | null = null;
    let mfaChallenge: string | null = null;
    let allowCredentials: { id: string; transports?: any[] }[] | undefined;
    if (mfaMode) {
      // Web requests use only the HttpOnly cookie; native token mode uses only
      // the explicit body token. Never let either transport silently fall back
      // to a standalone ceremony.
      mfaChallenge = wantsToken(c) ? body.mfa_token ?? null : getCookie(c, "__Host-mfa-challenge") ?? null;
      if (!mfaChallenge) return c.json({ error: "No MFA challenge" }, 401);
      mfaPrincipal = await verifyMfaChallenge(c.env.SESSION_SECRET, mfaChallenge);
      if (!mfaPrincipal) return c.json({ error: "MFA challenge expired" }, 401);

      const user = await c.env.DB.prepare(
        "SELECT u.active, u.deleted_at, u.auth_version, m.totp_enabled FROM users u JOIN mfa m ON m.user_id = u.id WHERE u.id = ?"
      ).bind(mfaPrincipal.userId).first<{ active: number; deleted_at: number | null; auth_version: number; totp_enabled: number }>();
      if (!user || user.active !== 1 || user.deleted_at !== null || user.auth_version !== mfaPrincipal.authVersion || user.totp_enabled !== 1) {
        return c.json({ error: "MFA challenge expired" }, 401);
      }
      const passkeys = await c.env.DB.prepare(
        "SELECT id, transports FROM passkey_credentials WHERE user_id = ? ORDER BY created_at"
      ).bind(mfaPrincipal.userId).all<{ id: string; transports: string | null }>();
      if (!passkeys.results.length) return c.json({ error: "No passkeys registered for this account" }, 409);
      allowCredentials = passkeys.results.map(passkey => ({
        id: passkey.id,
        transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
      }));
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      // Standalone remains discoverable; MFA is restricted to this account.
      allowCredentials,
    });

    const cookie = mfaPrincipal
      ? await signPasskeyMfaChallenge(
          c.env.SESSION_SECRET,
          mfaPrincipal.userId,
          mfaPrincipal.authVersion,
          options.challenge,
          await sha256Base64url(mfaChallenge!),
          mfaPrincipal.expiresAt,
        )
      : await signPasskeyAuthChallenge(c.env.SESSION_SECRET, options.challenge);
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

    const cookie = wantsToken(c)
      ? response.passkey_token ?? null
      : getCookie(c, "__Host-passkey-challenge") ?? null;
    if (!cookie) return c.json({ error: "No challenge" }, 401);

    const boundPrincipal = await verifyPasskeyMfaChallenge(c.env.SESSION_SECRET, cookie);
    const standaloneChallenge = boundPrincipal ? null : await verifyPasskeyAuthChallenge(c.env.SESSION_SECRET, cookie);
    const expectedChallenge = boundPrincipal?.challenge ?? standaloneChallenge;
    if (!expectedChallenge) return c.json({ error: "Challenge expired" }, 401);

    const cred = await c.env.DB.prepare(
      "SELECT p.user_id, p.public_key, p.sign_count, p.transports, u.auth_version, u.active, u.deleted_at, m.totp_enabled FROM passkey_credentials p JOIN users u ON u.id = p.user_id LEFT JOIN mfa m ON m.user_id = u.id WHERE p.id = ?"
    ).bind(response.id).first<{ user_id: number; public_key: string; sign_count: number; transports: string | null; auth_version: number; active: number; deleted_at: number | null; totp_enabled: number | null }>();

    if (!cred) {
      markFailedAttempt(c);
      return c.json({ error: "Unknown credential" }, 401);
    }
    if (boundPrincipal && (cred.user_id !== boundPrincipal.userId || cred.auth_version !== boundPrincipal.authVersion || cred.active !== 1 || cred.deleted_at !== null || cred.totp_enabled !== 1)) {
      markFailedAttempt(c);
      return c.json({ error: "Challenge expired" }, 401);
    }

    const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
    const { fromBase64url, getRpFromOrigin, getRegistrationOrigins } = await import("../../lib/webauthn");
    let rpID: string;
    let expectedOrigin: string | string[];
    try {
      ({ rpID, expectedOrigin } = getRpFromOrigin(c.env.APP_ORIGIN));
      if (wantsToken(c)) expectedOrigin = getRegistrationOrigins(c.env.APP_ORIGIN, c.env.ANDROID_APP_ORIGINS, true);
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
    const expiresAt = passkeyArtifactExpiresAt(cookie);
    if (!expiresAt || !(await finalizePasskeyAssertion(
      c.env.DB,
      cookie,
      expiresAt,
      response.id,
      cred.sign_count,
      result.authenticationInfo.newCounter,
      boundPrincipal ? { artifactHash: boundPrincipal.parentArtifactHash, expiresAt: boundPrincipal.expiresAt } : undefined,
    ))) {
      markFailedAttempt(c);
      return c.json({ error: "Challenge expired" }, 401);
    }

    if (cred.user_id !== 1) {
      const user = await c.env.DB.prepare("SELECT active FROM users WHERE id = ?")
        .bind(cred.user_id).first<{ active: number }>();
      if (!user || user.active === 0) return c.json({ error: "Account is disabled" }, 403);
    }

    deleteCookie(c, "__Host-passkey-challenge", { path: "/", secure: true });
    if (boundPrincipal) deleteCookie(c, "__Host-mfa-challenge", { path: "/", secure: true });
    const { token, freshAuth } = await setAuthenticatedCookies(c, cred.user_id, cred.auth_version);

    return c.json(wantsToken(c) ? { ok: true, userId: cred.user_id, token, fresh_auth: freshAuth } : { ok: true, userId: cred.user_id });
  });

  r.post("/recover/send-code", async (c) => {
    const { token } = await c.req.json<{ token: string }>().catch(() => ({ token: "" }));
    if (!token) return c.json({ error: "Invalid request" }, 400);

    const db = c.env.DB;
    const tokenHash = await recoveryDigest(c.env.SESSION_SECRET, "token", token);
    const now = Date.now();
    const user = await db.prepare(
      "SELECT id, recovery_code_sent_at, recovery_code_sends FROM users WHERE recovery_token_hash = ? AND recovery_expires_at > ? AND active = 1"
    ).bind(tokenHash, now).first<{ id: number; recovery_code_sent_at: number | null; recovery_code_sends: number }>();

    if (!user) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid or expired recovery token" }, 400);
    }
    if ((user.recovery_code_sent_at !== null && user.recovery_code_sent_at > now - 60_000) || user.recovery_code_sends >= 5) {
      markFailedAttempt(c);
      return c.json({ error: "Recovery code cannot be sent" }, 429);
    }

    const dest = await db.prepare("SELECT email FROM destinations WHERE user_id = ? AND is_default = 1").bind(user.id).first<{ email: string }>();
    if (!dest) return c.json({ error: "User has no default destination email" }, 400);

    const { decryptDestination } = await import("../../lib/crypto");
    const { sendRaw } = await import("../../lib/ses");
    const { buildMfaEmail } = await import("../../lib/emails");

    const email = await decryptDestination(dest.email, c.env.DESTINATION_ENCRYPTION_KEY);
    const code = randomSixDigitCode();
    const codeHash = await recoveryDigest(c.env.SESSION_SECRET, "code", code);
    const reserved = await db.prepare("UPDATE users SET recovery_code_hash = ?, recovery_code_expires_at = ?, recovery_code_attempts = 0, recovery_code_sent_at = ?, recovery_code_sends = recovery_code_sends + 1 WHERE id = ? AND recovery_token_hash = ? AND recovery_expires_at > ? AND active = 1 AND recovery_code_sends = ? AND (recovery_code_sent_at IS NULL OR recovery_code_sent_at <= ?)")
      .bind(codeHash, now + 10 * 60_000, now, user.id, tokenHash, now, user.recovery_code_sends, now - 60_000).run();
    if (reserved.meta.changes !== 1) return c.json({ error: "Recovery code cannot be sent" }, 429);

    const sesAccessKeyId = await getEnvWithOverride(db, c.env, "ses_access_key_id");
    const sesSecretAccessKey = await getEnvWithOverride(db, c.env, "ses_secret_access_key");
    const sesRegion = await getEnvWithOverride(db, c.env, "ses_region");

    const sesSend: typeof sendRaw = (c.env as any).__sesSend ?? sendRaw;
    if (sesAccessKeyId && sesSecretAccessKey && sesRegion) {
      const mainGlobalDomain = await getMainGlobalDomain(db, c.env);
      try { await sesSend({
        accessKeyId: sesAccessKeyId,
        secretAccessKey: sesSecretAccessKey,
        region: sesRegion
      }, {
        from: `HideMyEmail <noreply@${mainGlobalDomain}>`,
        to: email,
        rawBase64: buildMfaEmail(email, code, mainGlobalDomain)
      }); } catch {
        await db.prepare("UPDATE users SET recovery_code_hash = NULL, recovery_code_expires_at = NULL WHERE id = ? AND recovery_token_hash = ? AND recovery_code_hash = ?")
          .bind(user.id, tokenHash, codeHash).run();
        return c.json({ error: "Recovery code could not be delivered" }, 502);
      }
    } else {
      await db.prepare("UPDATE users SET recovery_code_hash = NULL, recovery_code_expires_at = NULL WHERE id = ? AND recovery_token_hash = ? AND recovery_code_hash = ?")
        .bind(user.id, tokenHash, codeHash).run();
      return c.json({ error: "Recovery email is not configured" }, 503);
    }

    return c.json({ ok: true });
  });

  r.post("/recover/verify", async (c) => {
    const { token, code } = await c.req.json<{ token: string; code: string }>().catch(() => ({ token: "", code: "" }));
    if (!token || !code) return c.json({ error: "Invalid request" }, 400);

    const db = c.env.DB;
    const tokenHash = await recoveryDigest(c.env.SESSION_SECRET, "token", token);
    const codeHash = await recoveryDigest(c.env.SESSION_SECRET, "code", code);
    const now = Date.now();
    const user = await db.prepare(
      "SELECT id, recovery_expires_at, recovery_code_expires_at, recovery_code_attempts, recovery_code_hash, auth_version FROM users WHERE recovery_token_hash = ? AND recovery_expires_at > ? AND active = 1"
    ).bind(tokenHash, now).first<{ id: number; recovery_expires_at: number; recovery_code_expires_at: number | null; recovery_code_attempts: number; recovery_code_hash: string | null; auth_version: number }>();

    if (!user || user.recovery_code_expires_at === null || user.recovery_code_expires_at <= now || user.recovery_code_attempts >= 5 ||
        !user.recovery_code_hash || !timingSafeEqual(user.recovery_code_hash, codeHash)) {
      if (user && user.recovery_code_attempts < 5) {
        await db.prepare("UPDATE users SET recovery_code_attempts = recovery_code_attempts + 1 WHERE id = ? AND recovery_token_hash = ? AND recovery_code_hash IS ? AND recovery_code_attempts < 5")
          .bind(user.id, tokenHash, user.recovery_code_hash).run();
      }
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
        "UPDATE users SET passphrase_hash = ?, passphrase_verifier = ?, recovery_codes = NULL, recovery_token = NULL, recovery_expires_at = NULL, recovery_mfa_code = NULL, recovery_token_hash = NULL, recovery_code_hash = NULL, recovery_code_expires_at = NULL, recovery_code_attempts = 0, recovery_code_sent_at = NULL, recovery_code_sends = 0, auth_version = ? WHERE id = ? AND recovery_token_hash = ? AND recovery_code_hash = ? AND recovery_expires_at = ? AND recovery_expires_at > ? AND recovery_code_expires_at = ? AND recovery_code_expires_at > ? AND recovery_code_attempts < 5 AND auth_version = ? AND active = 1"
      ).bind(hash, verifier, nextVersion, user.id, tokenHash, codeHash, user.recovery_expires_at, now, user.recovery_code_expires_at, now, user.auth_version),
      db.prepare(
        "UPDATE mfa SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL, totp_last_used_counter = NULL WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND passphrase_hash = ? AND auth_version = ?)"
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

    const { generatePassphrase } = await import("../../lib/passphrase");
    const newPassphrase = generatePassphrase();
    const newHash = await derivePassphraseHash(newPassphrase, c.env.AUTH_PASSWORD_SALT);
    const verifier = await createPassphraseVerifier(newPassphrase);
    const nextVersion = user.auth_version + 1;
    const [consumed] = await db.batch([
      db.prepare(
        "UPDATE users SET passphrase_hash = ?, passphrase_verifier = ?, recovery_codes = NULL, recovery_token = NULL, recovery_expires_at = NULL, recovery_mfa_code = NULL, recovery_token_hash = NULL, recovery_code_hash = NULL, recovery_code_expires_at = NULL, recovery_code_attempts = 0, recovery_code_sent_at = NULL, recovery_code_sends = 0, auth_version = ? WHERE id = ? AND recovery_codes = ? AND auth_version = ? AND active = 1 AND deleted_at IS NULL"
      ).bind(newHash, verifier, nextVersion, user.id, user.recovery_codes, user.auth_version),
      db.prepare(
        "UPDATE mfa SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL, totp_last_used_counter = NULL WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND passphrase_hash = ? AND auth_version = ?)"
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
      ? { ok: true, userId: user.id, passphrase: newPassphrase, codes_remaining: 0, token, fresh_auth: freshAuth }
      : { ok: true, passphrase: newPassphrase, codes_remaining: 0 });
  });

  return r;
}
