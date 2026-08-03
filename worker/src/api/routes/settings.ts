import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import type { AppEnv } from "../app";
import { signMfaPasskeyChallenge, signPasskeyRegChallenge, verifyMfaPasskeyChallenge, verifyPasskeyRegChallenge, passkeyArtifactExpiresAt, type MfaPasskeyAction } from "../../lib/auth";
import { freshAuthRequired, hasFreshAuth, isAuthenticatedNative } from "../auth-helpers";
import { fromBase64url, toBase64url, getAndroidAssociations, getRegistrationOrigins, getRpFromOrigin } from "../../lib/webauthn";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { consumeAuthArtifact, finalizePasskeyAssertion, markFailedAttempt, rateLimitFailures } from "../../lib/auth-security";

export function settingsRoutes() {
  const r = new Hono<AppEnv>();

  r.use("/mfa/disable", rateLimitFailures());
  r.use("/mfa/backup-codes", rateLimitFailures());
  r.use("/mfa/passkey/complete", rateLimitFailures());

  r.get("/preferences", async (c) => {
    const userId = c.get("userId");
    const row = await c.env.DB.prepare(
      "SELECT inline_actions_pref, inline_actions_position FROM users WHERE id = ?"
    ).bind(userId).first<{ inline_actions_pref: string | null; inline_actions_position: string | null }>();
    const { getBoolSetting, getSetting } = await import("../../lib/settings");
    const defaultEnabled = await getBoolSetting(c.env.DB, "inline_actions_default_enabled");
    const defaultPosition = (await getSetting(c.env.DB, "inline_actions_default_position")) || "footer";
    return c.json({
      inline_actions_pref: row?.inline_actions_pref ?? null, // 'on' | 'off' | null
      inline_actions_position: row?.inline_actions_position ?? null, // null = inherit
      defaults: { inline_actions_enabled: defaultEnabled, inline_actions_position: defaultPosition },
    });
  });

  r.patch("/preferences", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json<{ inline_actions_pref?: string | null; inline_actions_position?: string | null }>()
      .catch(() => ({} as { inline_actions_pref?: string | null; inline_actions_position?: string | null }));

    const sets: string[] = [];
    const binds: any[] = [];

    if ("inline_actions_pref" in body) {
      const v = body.inline_actions_pref;
      if (v !== null && v !== "on" && v !== "off") {
        return c.json({ error: "Invalid inline_actions_pref" }, 400);
      }
      sets.push("inline_actions_pref = ?");
      binds.push(v);
    }

    if ("inline_actions_position" in body) {
      const v = body.inline_actions_position;
      if (v !== null && v !== "header" && v !== "footer") {
        return c.json({ error: "Invalid inline_actions_position" }, 400);
      }
      sets.push("inline_actions_position = ?");
      binds.push(v);
    }

    if (sets.length === 0) return c.json({ error: "No fields to update" }, 400);
    binds.push(userId);
    await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
    return c.json({ ok: true });
  });

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
    if (!(await hasFreshAuth(c))) return freshAuthRequired(c);
    const { generateTOTPSecret, makeTOTPUri } = await import("../../lib/totp");
    const { encryptDestination } = await import("../../lib/crypto");

    // SECURITY: refuse to overwrite an already-enabled MFA enrolment. /mfa/disable
    // requires a fresh TOTP/backup code; allowing /mfa/setup to silently flip
    // totp_enabled back to 0 (and wipe backup codes) would bypass that gate and
    // let an attacker with a stolen session pivot the account onto their own TOTP.
    const current = await c.env.DB.prepare(
      "SELECT totp_enabled FROM mfa WHERE user_id = ?"
    ).bind(userId).first<{ totp_enabled: number }>();
    if (current?.totp_enabled === 1) {
      return c.json({ error: "MFA already enabled — disable it first to re-enroll" }, 409);
    }

    const secret = generateTOTPSecret();
    const encryptedSecret = await encryptDestination(secret, c.env.DESTINATION_ENCRYPTION_KEY);

    // Store pending (not yet enabled) secret. Conditional ON CONFLICT keeps an
    // enabled row immutable as a second line of defence against races between
    // the check above and the write.
    const stored = await c.env.DB.prepare(
      "INSERT INTO mfa (user_id, totp_secret, totp_enabled) SELECT ?, ?, 0 FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL AND auth_version = ? ON CONFLICT(user_id) DO UPDATE SET totp_secret = excluded.totp_secret, totp_enabled = 0, totp_backup_codes = NULL WHERE totp_enabled = 0"
    ).bind(userId, encryptedSecret, userId, c.get("authVersion")).run();
    if (stored.meta.changes !== 1) return c.json({ error: "Session expired" }, 401);

    const user = await c.env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(userId).first<{ name: string | null }>();
    const account = user?.name || (userId === 1 ? "Admin" : `User ${userId}`);
    const uri = makeTOTPUri(secret, "HideMyEmail", account);

    return c.json({ secret, uri });
  });

  // Verify code from authenticator app and activate MFA
  r.post("/mfa/verify", async (c) => {
    const userId = c.get("userId");
    if (!(await hasFreshAuth(c))) return freshAuthRequired(c);
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

    const counter = await verifyTOTP(secret, code);
    if (counter === null) {
      return c.json({ error: "Code does not match — check your authenticator app clock" }, 400);
    }

    const { plain, hashed } = await generateBackupCodes();

    const activated = await c.env.DB.prepare(
      "UPDATE mfa SET totp_enabled = 1, totp_backup_codes = ?, totp_last_used_counter = ? WHERE user_id = ? AND totp_enabled = 0 AND EXISTS (SELECT 1 FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL AND auth_version = ?)"
    ).bind(JSON.stringify(hashed), counter, userId, userId, c.get("authVersion")).run();
    if (activated.meta.changes !== 1) return c.json({ error: "No pending setup found" }, 400);

    return c.json({ ok: true, backupCodes: plain });
  });

  // Disable TOTP — requires a valid TOTP code or backup code for confirmation
  r.post("/mfa/disable", async (c) => {
    const userId = c.get("userId");
    if (!(await hasFreshAuth(c))) return freshAuthRequired(c);
    const { code } = await c.req.json<{ code: string }>().catch(() => ({ code: "" }));

    if (!code) return c.json({ error: "Code required" }, 400);

    const mfa = await c.env.DB.prepare(
      "SELECT totp_secret, totp_backup_codes, totp_last_used_counter FROM mfa WHERE user_id = ? AND totp_enabled = 1"
    ).bind(userId).first<{ totp_secret: string; totp_backup_codes: string | null; totp_last_used_counter: number | null }>();

    if (!mfa) return c.json({ error: "MFA not enabled" }, 400);

    const { decryptDestination } = await import("../../lib/crypto");
    const { verifyTOTP, verifyBackupCode } = await import("../../lib/totp");

    const secret = await decryptDestination(mfa.totp_secret, c.env.DESTINATION_ENCRYPTION_KEY);

    let verified = false;
    let counter: number | null = null;

    if (/^\d{6}$/.test(code)) {
      counter = await verifyTOTP(secret, code);
      const lastCounter = mfa.totp_last_used_counter;
      verified = counter !== null && (lastCounter === null || counter > lastCounter);
    } else {
      const normalized = code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
      const hashedCodes: string[] = mfa.totp_backup_codes ? JSON.parse(mfa.totp_backup_codes) : [];
      verified = normalized.length === 26 && (await verifyBackupCode(normalized, hashedCodes)) !== -1;
    }

    if (!verified) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid code" }, 401);
    }

    const disabled = await c.env.DB.prepare(
      "UPDATE mfa SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL, totp_last_used_counter = ? WHERE user_id = ? AND totp_enabled = 1 AND totp_backup_codes IS ? AND (? IS NULL OR totp_last_used_counter IS NULL OR totp_last_used_counter < ?) AND EXISTS (SELECT 1 FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL AND auth_version = ?)"
    ).bind(counter, userId, mfa.totp_backup_codes, counter, counter, userId, c.get("authVersion")).run();
    if (disabled.meta.changes !== 1) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid code" }, 401);
    }

    return c.json({ ok: true });
  });

  // Regenerate backup codes — requires current TOTP code
  r.post("/mfa/backup-codes", async (c) => {
    const userId = c.get("userId");
    if (!(await hasFreshAuth(c))) return freshAuthRequired(c);
    const { code } = await c.req.json<{ code: string }>().catch(() => ({ code: "" }));

    if (!code || !/^\d{6}$/.test(code)) {
      return c.json({ error: "Enter a 6-digit code to regenerate backup codes" }, 400);
    }

    const mfa = await c.env.DB.prepare(
      "SELECT totp_secret, totp_last_used_counter FROM mfa WHERE user_id = ? AND totp_enabled = 1"
    ).bind(userId).first<{ totp_secret: string; totp_last_used_counter: number | null }>();

    if (!mfa) return c.json({ error: "MFA not enabled" }, 400);

    const { decryptDestination } = await import("../../lib/crypto");
    const { verifyTOTP, generateBackupCodes } = await import("../../lib/totp");

    const secret = await decryptDestination(mfa.totp_secret, c.env.DESTINATION_ENCRYPTION_KEY);

    const counter = await verifyTOTP(secret, code);
    const lastCounter = mfa.totp_last_used_counter;
    if (counter === null || (lastCounter !== null && counter <= lastCounter)) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid code" }, 401);
    }

    const { plain, hashed } = await generateBackupCodes();

    const regenerated = await c.env.DB.prepare(
      "UPDATE mfa SET totp_backup_codes = ?, totp_last_used_counter = ? WHERE user_id = ? AND totp_enabled = 1 AND (totp_last_used_counter IS NULL OR totp_last_used_counter < ?) AND EXISTS (SELECT 1 FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL AND auth_version = ?)"
    ).bind(JSON.stringify(hashed), counter, userId, counter, userId, c.get("authVersion")).run();
    if (regenerated.meta.changes !== 1) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid code" }, 401);
    }

    return c.json({ ok: true, backupCodes: plain });
  });

  // Passkey confirmation for MFA mutations. The challenge is bound to the
  // current account, auth version, and one action, then consumed exactly once.
  r.post("/mfa/passkey/challenge", async (c) => {
    const userId = c.get("userId");
    const { action } = await c.req.json<{ action?: MfaPasskeyAction }>()
      .catch(() => ({} as { action?: MfaPasskeyAction }));
    if (action !== "disable" && action !== "backup-codes") {
      return c.json({ error: "Invalid MFA action" }, 400);
    }
    const mfa = await c.env.DB.prepare(
      "SELECT 1 FROM mfa WHERE user_id = ? AND totp_enabled = 1"
    ).bind(userId).first();
    if (!mfa) return c.json({ error: "MFA not enabled" }, 400);
    const credentials = await c.env.DB.prepare(
      "SELECT id, transports FROM passkey_credentials WHERE user_id = ?"
    ).bind(userId).all<{ id: string; transports: string | null }>();
    if (!credentials.results?.length) return c.json({ error: "No passkeys registered" }, 400);

    const { generateAuthenticationOptions } = await import("@simplewebauthn/server");
    let rpID: string;
    try {
      ({ rpID } = getRpFromOrigin(c.env.APP_ORIGIN));
    } catch {
      return c.json({ error: "Passkey authentication is not configured" }, 500);
    }
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      allowCredentials: credentials.results.map((credential) => ({
        id: credential.id,
        transports: credential.transports ? JSON.parse(credential.transports) : undefined,
      })),
    });
    const passkeyToken = await signMfaPasskeyChallenge(
      c.env.SESSION_SECRET, userId, c.get("authVersion"), action, options.challenge,
    );
    return c.json({ ...options, passkey_token: passkeyToken });
  });

  r.post("/mfa/passkey/complete", async (c) => {
    const body = await c.req.json<{
      action?: MfaPasskeyAction;
      response?: AuthenticationResponseJSON;
      passkey_token?: string;
    }>().catch(() => null);
    if (!body?.response?.id || !body.passkey_token) return c.json({ error: "Invalid request" }, 400);
    const signed = await verifyMfaPasskeyChallenge(c.env.SESSION_SECRET, body.passkey_token);
    if (!signed || signed.userId !== c.get("userId") || signed.authVersion !== c.get("authVersion") || signed.action !== body.action) {
      return c.json({ error: "Invalid or expired passkey challenge" }, 401);
    }
    const mfa = await c.env.DB.prepare(
      "SELECT totp_backup_codes FROM mfa WHERE user_id = ? AND totp_enabled = 1"
    ).bind(signed.userId).first<{ totp_backup_codes: string | null }>();
    if (!mfa) return c.json({ error: "MFA not enabled" }, 400);
    const credential = await c.env.DB.prepare(
      "SELECT public_key, sign_count, transports FROM passkey_credentials WHERE id = ? AND user_id = ?"
    ).bind(body.response.id, signed.userId).first<{ public_key: string; sign_count: number; transports: string | null }>();
    if (!credential) {
      markFailedAttempt(c);
      return c.json({ error: "Unknown credential" }, 401);
    }

    const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
    let rpID: string;
    let expectedOrigin: string | string[];
    try {
      ({ rpID } = getRpFromOrigin(c.env.APP_ORIGIN));
      expectedOrigin = getRegistrationOrigins(
        c.env.APP_ORIGIN,
        c.env.ANDROID_APP_ORIGINS,
        isAuthenticatedNative(c),
      );
    } catch {
      return c.json({ error: "Passkey authentication is not configured" }, 500);
    }
    const result = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: signed.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: body.response.id,
        publicKey: fromBase64url(credential.public_key),
        counter: credential.sign_count,
        transports: credential.transports ? JSON.parse(credential.transports) : undefined,
      },
    }).catch(() => ({ verified: false as const, authenticationInfo: undefined }));
    if (!result.verified || !result.authenticationInfo) {
      markFailedAttempt(c);
      return c.json({ error: "Verification failed" }, 401);
    }
    const expiresAt = passkeyArtifactExpiresAt(body.passkey_token);
    if (!expiresAt || !(await finalizePasskeyAssertion(c.env.DB, body.passkey_token, expiresAt, body.response.id, credential.sign_count, result.authenticationInfo.newCounter))) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid or expired passkey challenge" }, 401);
    }

    if (signed.action === "disable") {
      const disabled = await c.env.DB.prepare(
        "UPDATE mfa SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL, totp_last_used_counter = NULL WHERE user_id = ? AND totp_enabled = 1 AND EXISTS (SELECT 1 FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL AND auth_version = ?)"
      ).bind(signed.userId, signed.userId, signed.authVersion).run();
      if (disabled.meta.changes !== 1) return c.json({ error: "MFA not enabled" }, 400);
      return c.json({ ok: true });
    }

    const { plain, hashed } = await (await import("../../lib/totp")).generateBackupCodes();
    const regenerated = await c.env.DB.prepare(
      "UPDATE mfa SET totp_backup_codes = ? WHERE user_id = ? AND totp_enabled = 1 AND totp_backup_codes IS ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL AND auth_version = ?)"
    ).bind(JSON.stringify(hashed), signed.userId, mfa.totp_backup_codes, signed.userId, signed.authVersion).run();
    if (regenerated.meta.changes !== 1) return c.json({ error: "MFA not enabled" }, 400);
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
    const tokenMode = c.req.header("X-Auth-Mode") === "token" && !c.req.header("Origin");
    if (tokenMode && !isAuthenticatedNative(c)) return c.json({ error: "Native token mode required" }, 400);
    if (!(await hasFreshAuth(c))) return freshAuthRequired(c);
    const { generateRegistrationOptions } = await import("@simplewebauthn/server");
    let rpID: string;
    try {
      ({ rpID } = getRpFromOrigin(c.env.APP_ORIGIN));
      if (isAuthenticatedNative(c)) getAndroidAssociations(c.env.ANDROID_APP_ORIGINS);
    } catch {
      return c.json({ error: "Passkey authentication is not configured" }, 500);
    }

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

    const cookie = await signPasskeyRegChallenge(c.env.SESSION_SECRET, userId, options.challenge, c.get("authVersion"));
    const native = isAuthenticatedNative(c);
    if (native) return c.json({ ...options, challengeToken: cookie });
    setCookie(c, "__Host-passkey-reg", cookie, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 300 });

    return c.json(options);
  });

  // Verify attestation and persist the new credential
  r.post("/passkeys/register", async (c) => {
    const sessionUserId = c.get("userId");
    const tokenMode = c.req.header("X-Auth-Mode") === "token" && !c.req.header("Origin");
    if (tokenMode && !isAuthenticatedNative(c)) return c.json({ error: "Native token mode required" }, 400);
    if (!(await hasFreshAuth(c))) return freshAuthRequired(c);

    const body = await c.req.json<{ response: RegistrationResponseJSON; deviceName?: string; challengeToken?: unknown }>()
      .catch(() => ({ response: null as unknown as RegistrationResponseJSON, deviceName: undefined, challengeToken: undefined }));
    const native = isAuthenticatedNative(c);
    const regCookie = native && typeof body.challengeToken === "string" ? body.challengeToken : getCookie(c, "__Host-passkey-reg");
    if (!regCookie) return c.json({ error: "No registration challenge" }, 401);

    const verified = await verifyPasskeyRegChallenge(c.env.SESSION_SECRET, regCookie);
    if (!verified || verified.userId !== sessionUserId || verified.authVersion !== c.get("authVersion")) {
      return c.json({ error: "Invalid or expired challenge" }, 401);
    }

    const { response, deviceName } = body;

    if (!response?.id) return c.json({ error: "Invalid request" }, 400);
    if (!(await consumeAuthArtifact(c.env.DB, regCookie, Math.floor(Date.now() / 1000) + 300))) {
      return c.json({ error: "Invalid or expired challenge" }, 401);
    }

    const { verifyRegistrationResponse } = await import("@simplewebauthn/server");
    let rpID: string;
    let expectedOrigin: string | string[];
    try {
      ({ rpID } = getRpFromOrigin(c.env.APP_ORIGIN));
      expectedOrigin = getRegistrationOrigins(c.env.APP_ORIGIN, c.env.ANDROID_APP_ORIGINS, native);
    } catch {
      return c.json({ error: "Passkey authentication is not configured" }, 500);
    }

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

    const inserted = await c.env.DB.prepare(
      "INSERT INTO passkey_credentials (id, user_id, public_key, sign_count, transports, device_name, created_at) SELECT ?, ?, ?, ?, ?, ?, ? FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL AND auth_version = ?"
    ).bind(credId, sessionUserId, toBase64url(credential.publicKey), credential.counter, JSON.stringify(transports), deviceName || null, Date.now(), sessionUserId, c.get("authVersion")).run();
    if (inserted.meta.changes !== 1) return c.json({ error: "Session expired" }, 401);

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
    if (!(await hasFreshAuth(c))) return freshAuthRequired(c);
    const id = c.req.param("id");

    await c.env.DB.prepare(
      "DELETE FROM passkey_credentials WHERE id = ? AND user_id = ?"
    ).bind(id, userId).run();

    return c.json({ ok: true });
  });

  return r;
}
