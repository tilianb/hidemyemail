import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../app";
import { freshAuthRequired, hasFreshAuth, isAuthenticatedNative } from "../auth-helpers";
import { finalizePasskeyAssertion, markFailedAttempt, rateLimitFailures } from "../../lib/auth-security";
import { derivePassphraseHash, timingSafeEqual, verifyPassphraseVerifier, verifyPassword, signSecurityHandoff, signReauthPasskeyChallenge, verifyReauthPasskeyChallenge, type ReauthChannel } from "../../lib/auth";
import { decryptDestination } from "../../lib/crypto";
import { verifyBackupCode, verifyTOTP } from "../../lib/totp";
import { fromBase64url, getRegistrationOrigins, getRpFromOrigin } from "../../lib/webauthn";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { issueFreshAuth } from "../auth-route-helpers";

function reauthChannel(c: Context<AppEnv>): ReauthChannel | null {
  let canonical: string;
  try { canonical = getRpFromOrigin(c.env.APP_ORIGIN).expectedOrigin; } catch { return null; }
  if (c.get("authSource") === "cookie") return c.req.header("Origin") === canonical && c.req.header("X-Auth-Mode") !== "token" ? "web" : null;
  return c.get("authSource") === "bearer" && c.req.header("X-Auth-Mode") === "token" && !c.req.header("Origin") ? "native" : null;
}

export function nativeSecurityRoutes() {
  const r = new Hono<AppEnv>();
  r.use("/reauth", rateLimitFailures());
  r.use("/reauth/passkey/complete", rateLimitFailures());

  r.post("/reauth", async c => {
    const channel = reauthChannel(c);
    if (!channel) return c.json({ error: "Invalid authentication channel" }, 400);
    const body: { passphrase?: unknown; code?: unknown } = await c.req.json().catch(() => ({}));
    if (typeof body.passphrase !== "string" || body.passphrase.length < 1 ||
        (body.code !== undefined && (typeof body.code !== "string" || body.code.length > 64))) {
      return c.json({ error: "Invalid request" }, 400);
    }
    const userId = c.get("userId");
    const user = await c.env.DB.prepare("SELECT passphrase_hash, passphrase_verifier FROM users WHERE id = ?")
      .bind(userId).first<{ passphrase_hash: string | null; passphrase_verifier: string | null }>();
    const passphraseValid = userId === 1
      ? await verifyPassword(body.passphrase, c.env.AUTH_PASSWORD_SALT, c.env.AUTH_PASSWORD_HASH)
      : !!user?.passphrase_hash && timingSafeEqual(await derivePassphraseHash(body.passphrase, c.env.AUTH_PASSWORD_SALT), user.passphrase_hash) &&
        (!user.passphrase_verifier || await verifyPassphraseVerifier(body.passphrase, user.passphrase_verifier));

    const mfa = await c.env.DB.prepare("SELECT totp_secret, totp_backup_codes FROM mfa WHERE user_id = ? AND totp_enabled = 1")
      .bind(userId).first<{ totp_secret: string; totp_backup_codes: string | null }>();
    let mfaValid = !mfa;
    let remainingBackupCodes: string[] | null = null;
    if (mfa && typeof body.code === "string") {
      const secret = await decryptDestination(mfa.totp_secret, c.env.DESTINATION_ENCRYPTION_KEY);
      if (/^\d{6}$/.test(body.code)) mfaValid = await verifyTOTP(secret, body.code);
      if (!mfaValid) {
        const normalized = body.code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
        const hashes: string[] = mfa.totp_backup_codes ? JSON.parse(mfa.totp_backup_codes) : [];
        const index = normalized.length === 8 ? await verifyBackupCode(normalized, hashes) : -1;
        if (index !== -1) {
          hashes.splice(index, 1);
          remainingBackupCodes = hashes;
          mfaValid = true;
        }
      }
    }
    if (!passphraseValid || !mfaValid) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid credentials" }, 401);
    }
    if (remainingBackupCodes && mfa) {
      const consumed = await c.env.DB.prepare("UPDATE mfa SET totp_backup_codes = ? WHERE user_id = ? AND totp_backup_codes = ?")
        .bind(JSON.stringify(remainingBackupCodes), userId, mfa.totp_backup_codes).run();
      if (consumed.meta.changes !== 1) {
        markFailedAttempt(c);
        return c.json({ error: "Invalid credentials" }, 401);
      }
    }
    return issueFreshAuth(c, channel);
  });

  r.post("/reauth/passkey/challenge", async c => {
    const channel = reauthChannel(c);
    if (!channel) return c.json({ error: "Invalid authentication channel" }, 400);
    const credentials = await c.env.DB.prepare("SELECT id, transports FROM passkey_credentials WHERE user_id = ? ORDER BY created_at")
      .bind(c.get("userId")).all<{ id: string; transports: string | null }>();
    if (!credentials.results.length) return c.json({ error: "No passkeys registered" }, 400);
    let rpID: string;
    try { ({ rpID } = getRpFromOrigin(c.env.APP_ORIGIN)); } catch { return c.json({ error: "Passkey authentication is not configured" }, 500); }
    const { generateAuthenticationOptions } = await import("@simplewebauthn/server");
    const options = await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: credentials.results.map(x => ({ id: x.id, transports: x.transports ? JSON.parse(x.transports) : undefined })) });
    const token = await signReauthPasskeyChallenge(c.env.SESSION_SECRET, c.get("userId"), c.get("authVersion"), channel, options.challenge);
    c.header("Cache-Control", "no-store");
    if (channel === "native") return c.json({ ...options, passkey_token: token });
    setCookie(c, "__Host-reauth-passkey", token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 300 });
    return c.json(options);
  });

  r.post("/reauth/passkey/complete", async c => {
    const channel = reauthChannel(c);
    if (!channel) return c.json({ error: "Invalid authentication channel" }, 400);
    const body = await c.req.json<{ response?: AuthenticationResponseJSON; passkey_token?: string }>().catch(() => null);
    if (!body?.response?.id) return c.json({ error: "Invalid request" }, 400);
    const token = channel === "web" ? getCookie(c, "__Host-reauth-passkey") : body.passkey_token;
    if (!token || (channel === "web" && body.passkey_token) || (channel === "native" && getCookie(c, "__Host-reauth-passkey"))) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid or expired passkey challenge" }, 401);
    }
    const signed = await verifyReauthPasskeyChallenge(c.env.SESSION_SECRET, token);
    if (!signed || signed.channel !== channel || signed.userId !== c.get("userId") || signed.authVersion !== c.get("authVersion")) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid or expired passkey challenge" }, 401);
    }
    const credential = await c.env.DB.prepare("SELECT public_key, sign_count, transports FROM passkey_credentials WHERE id = ? AND user_id = ?")
      .bind(body.response.id, signed.userId).first<{ public_key: string; sign_count: number; transports: string | null }>();
    if (!credential) { markFailedAttempt(c); return c.json({ error: "Unknown credential" }, 401); }
    let rpID: string; let expectedOrigin: string | string[];
    try { ({ rpID } = getRpFromOrigin(c.env.APP_ORIGIN)); expectedOrigin = getRegistrationOrigins(c.env.APP_ORIGIN, c.env.ANDROID_APP_ORIGINS, channel === "native"); }
    catch { return c.json({ error: "Passkey authentication is not configured" }, 500); }
    const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
    const result = await verifyAuthenticationResponse({ response: body.response, expectedChallenge: signed.challenge, expectedOrigin, expectedRPID: rpID, requireUserVerification: true, credential: { id: body.response.id, publicKey: fromBase64url(credential.public_key), counter: credential.sign_count, transports: credential.transports ? JSON.parse(credential.transports) : undefined } }).catch(() => ({ verified: false as const, authenticationInfo: undefined }));
    if (!result.verified || !result.authenticationInfo) { markFailedAttempt(c); return c.json({ error: "Verification failed" }, 401); }
    if (!(await finalizePasskeyAssertion(c.env.DB, token, signed.expiresAt, body.response.id, credential.sign_count, result.authenticationInfo.newCounter))) {
      markFailedAttempt(c);
      return c.json({ error: "Invalid or expired passkey challenge" }, 401);
    }
    if (channel === "web") deleteCookie(c, "__Host-reauth-passkey", { path: "/", secure: true });
    return issueFreshAuth(c, channel);
  });

  r.post("/security-handoff", async c => {
    if (!isAuthenticatedNative(c)) return c.json({ error: "Native token mode required" }, 400);
    if (!(await hasFreshAuth(c))) return freshAuthRequired(c);
    let origin: string;
    try { origin = getRpFromOrigin(c.env.APP_ORIGIN).expectedOrigin; }
    catch { return c.json({ error: "Application origin is not configured" }, 500); }
    const code = await signSecurityHandoff(c.env.SESSION_SECRET, c.get("userId"), c.get("authVersion"));
    return c.json({ url: `${origin}/security-handoff?code=${encodeURIComponent(code)}` });
  });
  return r;
}
