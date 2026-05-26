import { Hono } from "hono";
import type { AppEnv } from "../app";

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
    const { generateTOTPSecret, makeTOTPUri } = await import("../../lib/totp");
    const { encryptDestination } = await import("../../lib/crypto");

    const secret = generateTOTPSecret();
    const encryptedSecret = await encryptDestination(secret, c.env.DESTINATION_ENCRYPTION_KEY);

    // Store pending (not yet enabled) secret
    await c.env.DB.prepare(
      "INSERT INTO mfa (user_id, totp_secret, totp_enabled) VALUES (?, ?, 0) ON CONFLICT(user_id) DO UPDATE SET totp_secret = excluded.totp_secret, totp_enabled = 0, totp_backup_codes = NULL"
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
    const userId = c.get("userId");
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

    if (!verified) return c.json({ error: "Invalid code" }, 401);

    await c.env.DB.prepare(
      "UPDATE mfa SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL WHERE user_id = ?"
    ).bind(userId).run();

    return c.json({ ok: true });
  });

  // Regenerate backup codes — requires current TOTP code
  r.post("/mfa/backup-codes", async (c) => {
    const userId = c.get("userId");
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
      return c.json({ error: "Invalid code" }, 401);
    }

    const { plain, hashed } = await generateBackupCodes();

    await c.env.DB.prepare(
      "UPDATE mfa SET totp_backup_codes = ? WHERE user_id = ?"
    ).bind(JSON.stringify(hashed), userId).run();

    return c.json({ ok: true, backupCodes: plain });
  });

  return r;
}
