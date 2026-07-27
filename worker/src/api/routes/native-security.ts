import { Hono } from "hono";
import type { AppEnv } from "../app";
import { hasFreshAuth, isAuthenticatedNative } from "../auth-helpers";
import { markFailedAttempt, rateLimitFailures } from "../../lib/auth-security";
import { derivePassphraseHash, signFreshAuth, timingSafeEqual, verifyPassphraseVerifier, verifyPassword, signSecurityHandoff } from "../../lib/auth";
import { decryptDestination } from "../../lib/crypto";
import { verifyBackupCode, verifyTOTP } from "../../lib/totp";
import { getRpFromOrigin } from "../../lib/webauthn";

const FRESH_AUTH_TTL = 600;

/**
 * Creates a router for native-token reauthentication and security handoff.
 *
 * @returns A configured Hono router with native security routes.
 */
export function nativeSecurityRoutes() {
  const r = new Hono<AppEnv>();
  r.use("/reauth", rateLimitFailures());

  r.post("/reauth", async c => {
    if (!isAuthenticatedNative(c)) return c.json({ error: "Native token mode required" }, 400);
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
    return c.json({ fresh_auth: await signFreshAuth(c.env.SESSION_SECRET, userId, FRESH_AUTH_TTL, c.get("authVersion")) });
  });

  r.post("/security-handoff", async c => {
    if (!isAuthenticatedNative(c)) return c.json({ error: "Native token mode required" }, 400);
    if (!(await hasFreshAuth(c))) return c.json({ error: "Fresh authentication required" }, 401);
    let origin: string;
    try { origin = getRpFromOrigin(c.env.APP_ORIGIN).expectedOrigin; }
    catch { return c.json({ error: "Application origin is not configured" }, 500); }
    const code = await signSecurityHandoff(c.env.SESSION_SECRET, c.get("userId"), c.get("authVersion"));
    return c.json({ url: `${origin}/security-handoff?code=${encodeURIComponent(code)}` });
  });
  return r;
}
