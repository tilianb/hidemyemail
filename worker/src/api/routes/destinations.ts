import { Hono } from "hono";
import type { AppEnv } from "../app";
import { sendRaw } from "../../lib/ses";
import { hashDestination, encryptDestination, decryptDestination } from "../../lib/crypto";
import { getEnvWithOverride, getMainGlobalDomain } from "../../lib/settings";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function destinationRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/destinations", async (c) => {
    const userId = c.get("userId");
    let rows;
    try {
      rows = await c.env.DB.prepare(
        "SELECT id, email, is_default, verified_at, created_at, suppressed_at, suppression_reason, suppression_class FROM destinations WHERE user_id = ? ORDER BY created_at DESC"
      ).bind(userId).all<{ id: number, email: string, is_default: number, verified_at: number | null, created_at: number, suppressed_at: number | null, suppression_reason: string | null, suppression_class: string | null }>();
    } catch {
      // is_default column may be missing if migration 0002 hasn't been applied yet
      rows = await c.env.DB.prepare(
        "SELECT id, email, 0 as is_default, verified_at, created_at, NULL as suppressed_at, NULL as suppression_reason, NULL as suppression_class FROM destinations WHERE user_id = ? ORDER BY created_at DESC"
      ).bind(userId).all<{ id: number, email: string, is_default: number, verified_at: number | null, created_at: number, suppressed_at: number | null, suppression_reason: string | null, suppression_class: string | null }>();
    }

    const results = [];
    for (const row of rows.results ?? []) {
      const email = await decryptDestination(row.email, c.env.DESTINATION_ENCRYPTION_KEY);
      results.push({ ...row, email });
    }
    return c.json(results);
  });

  r.post("/destinations", async (c) => {
    const userId = c.get("userId");
    let { email } = await c.req.json<{ email: string }>().catch(() => ({ email: "" }));
    if (!email || !email.includes("@")) return c.json({ error: "Invalid email" }, 400);
    email = email.toLowerCase();

    const emailHash = await hashDestination(email, c.env.DESTINATION_ENCRYPTION_KEY);
    const existing = await c.env.DB.prepare("SELECT id FROM destinations WHERE user_id = ? AND email_hash = ?").bind(userId, emailHash).first();
    if (existing) return c.json({ error: "Already added" }, 409);

    const token = crypto.randomUUID();
    
    try {
      // Save destination first so the verification link exists before the
      // outbound send is handed off to SES in the background.
      const encryptedEmail = await encryptDestination(email, c.env.DESTINATION_ENCRYPTION_KEY);
      const countRes = await c.env.DB.prepare("SELECT COUNT(*) as c FROM destinations WHERE user_id = ?").bind(userId).first<{ c: number }>();
      const isDefault = countRes?.c === 0 ? 1 : 0;
      await c.env.DB.prepare(
        "INSERT INTO destinations (user_id, email, email_hash, token, created_at, is_default) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(userId, encryptedEmail, emailHash, token, Date.now(), isDefault).run();

      const sesAccessKeyId = await getEnvWithOverride(c.env.DB, c.env, "ses_access_key_id");
      const sesSecretAccessKey = await getEnvWithOverride(c.env.DB, c.env, "ses_secret_access_key");
      const sesRegion = await getEnvWithOverride(c.env.DB, c.env, "ses_region");

      if (sesAccessKeyId && sesSecretAccessKey && sesRegion) {
        const verifyUrl = new URL(`/api/verify?token=${token}`, c.req.url).toString();
        const mainGlobalDomain = await getMainGlobalDomain(c.env.DB, c.env);
        const rawBase64 = buildVerificationEmail(email, verifyUrl, mainGlobalDomain);
        const sesSend: typeof sendRaw = (c.env as any).__sesSend ?? sendRaw;

        const startedAt = Date.now();
        const sendTask = sesSend({
            accessKeyId: sesAccessKeyId,
            secretAccessKey: sesSecretAccessKey,
            region: sesRegion
          }, {
            from: `HideMyEmail <noreply@${mainGlobalDomain}>`,
            to: email,
            rawBase64
          })
          .then((messageId) => {
            console.log("Verification email sent", { messageId, ms: Date.now() - startedAt });
          })
          .catch(async (err) => {
            console.error("Verification email send failed", err);
            await c.env.DB.prepare("DELETE FROM destinations WHERE token = ? AND verified_at IS NULL")
              .bind(token)
              .run();
          });

        try {
          c.executionCtx.waitUntil(sendTask);
        } catch {
          void sendTask;
        }
      }

      return c.json({ ok: true });
    } catch (err: any) {
      if (err.message && err.message.includes("UNIQUE constraint failed")) {
        return c.json({ error: "Already added" }, 409);
      }
      return c.json({ error: "Internal error" }, 500);
    }
  });

  r.post("/destinations/:id/resend", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid id" }, 400);

    const dest = await c.env.DB.prepare(
      "SELECT email, token, verified_at FROM destinations WHERE id = ? AND user_id = ?"
    ).bind(id, userId).first<{ email: string; token: string; verified_at: number | null }>();
    if (!dest) return c.json({ error: "Destination not found" }, 404);
    if (dest.verified_at !== null) return c.json({ error: "Destination is already verified" }, 409);

    const sesAccessKeyId = await getEnvWithOverride(c.env.DB, c.env, "ses_access_key_id");
    const sesSecretAccessKey = await getEnvWithOverride(c.env.DB, c.env, "ses_secret_access_key");
    const sesRegion = await getEnvWithOverride(c.env.DB, c.env, "ses_region");

    if (!sesAccessKeyId || !sesSecretAccessKey || !sesRegion) {
      return c.json({ error: "Email sending is not configured" }, 503);
    }

    const email = await decryptDestination(dest.email, c.env.DESTINATION_ENCRYPTION_KEY);
    const verifyUrl = new URL(`/api/verify?token=${dest.token}`, c.req.url).toString();
    const mainGlobalDomain = await getMainGlobalDomain(c.env.DB, c.env);
    const rawBase64 = buildVerificationEmail(email, verifyUrl, mainGlobalDomain);
    const cooldownKey = `destination-resend:${userId}:${id}`;
    const now = Date.now();
    const newReset = now + 60_000;
    const claimed = await c.env.DB.prepare(
      "INSERT INTO rate_limits (ip, attempts, reset_at) VALUES (?, 1, ?) " +
      "ON CONFLICT(ip) DO UPDATE SET reset_at = excluded.reset_at " +
      "WHERE rate_limits.reset_at <= ? RETURNING reset_at"
    ).bind(cooldownKey, newReset, now).first<{ reset_at: number }>();
    if (!claimed) {
      return c.json({ error: "Please wait before resending verification email" }, 429);
    }

    const sesSend: typeof sendRaw = (c.env as any).__sesSend ?? sendRaw;
    const startedAt = Date.now();
    const sendTask = sesSend({
        accessKeyId: sesAccessKeyId,
        secretAccessKey: sesSecretAccessKey,
        region: sesRegion
      }, {
        from: `HideMyEmail <noreply@${mainGlobalDomain}>`,
        to: email,
        rawBase64
      }).then((messageId) => {
        console.log("Verification email resent", { messageId, ms: Date.now() - startedAt });
      }).catch((err) => {
        console.error("Verification email resend failed", err);
      });

    try {
      c.executionCtx.waitUntil(sendTask);
    } catch {
      void sendTask;
    }

    return c.json({ ok: true });
  });

  r.delete("/destinations/:id", async (c) => {
    const userId = c.get("userId");
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

    // Ensure we don't delete if it's currently in use by an alias or domain
    const dest = await c.env.DB.prepare("SELECT email_hash FROM destinations WHERE id = ? AND user_id = ?").bind(id, userId).first<{ email_hash: string }>();
    if (!dest) return c.json({ ok: true });

    const inUseAlias = await c.env.DB.prepare("SELECT id FROM aliases WHERE destination_hash = ? AND user_id = ?").bind(dest.email_hash, userId).first();
    if (inUseAlias) return c.json({ error: "Destination in use by aliases" }, 400);
    
    const inUseDomain = await c.env.DB.prepare("SELECT id FROM domains WHERE default_destination_hash = ? AND user_id = ?").bind(dest.email_hash, userId).first();
    if (inUseDomain) return c.json({ error: "Destination in use by domains" }, 400);

    await c.env.DB.prepare("DELETE FROM destinations WHERE id = ? AND user_id = ?").bind(id, userId).run();
    return c.json({ ok: true });
  });

  r.patch("/destinations/:id/default", async (c) => {
    const userId = c.get("userId");
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

    const dest = await c.env.DB.prepare("SELECT verified_at FROM destinations WHERE id = ? AND user_id = ?").bind(id, userId).first<{ verified_at: number | null }>();
    if (!dest) return c.json({ error: "Destination not found" }, 404);
    if (!dest.verified_at) return c.json({ error: "Destination must be verified to be set as default" }, 400);

    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE destinations SET is_default = 0 WHERE user_id = ?").bind(userId),
      c.env.DB.prepare("UPDATE destinations SET is_default = 1 WHERE id = ? AND user_id = ?").bind(id, userId)
    ]);

    return c.json({ ok: true });
  });

  r.post("/destinations/:id/unsuppress", async (c) => {
    const userId = c.get("userId");
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

    const dest = await c.env.DB.prepare(
      "SELECT suppressed_at, suppression_class FROM destinations WHERE id = ? AND user_id = ?"
    ).bind(id, userId).first<{ suppressed_at: number | null; suppression_class: string | null }>();

    if (!dest) return c.json({ error: "Destination not found" }, 404);
    if (!dest.suppressed_at) return c.json({ ok: true }); // Already not suppressed

    // Hard suppressions (permanent bounce, complaint) cannot be self-served
    if (dest.suppression_class === "hard") {
      return c.json({ error: "Hard-suppressed destinations cannot be unsuppressed by the user" }, 403);
    }

    const { clearSuppression } = await import("../../db/queries");
    await clearSuppression(c.env.DB, id);
    return c.json({ ok: true });
  });

  return r;
}

export function verificationRoute() {
  const r = new Hono<AppEnv>();
  
  r.get("/verify", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.text("Missing token", 400);
    
    const dest = await c.env.DB.prepare(
      "SELECT id, email FROM destinations WHERE token = ? AND verified_at IS NULL"
    ).bind(token).first<{ id: number; email: string }>();
    
    if (!dest) {
      return c.html(renderErrorPage(), 400);
    }

    const email = await decryptDestination(dest.email, c.env.DESTINATION_ENCRYPTION_KEY);
    return c.html(renderConfirmationPage(email, token));
  });

  r.post("/verify", async (c) => {
    const body = await c.req.parseBody().catch(() => ({}));
    const token = typeof (body as any).token === "string" ? (body as any).token : undefined;
    if (!token) {
      return c.html(renderErrorPage(), 400);
    }

    const dest = await c.env.DB.prepare(
      "SELECT id, email FROM destinations WHERE token = ? AND verified_at IS NULL"
    ).bind(token).first<{ id: number; email: string }>();

    if (!dest) {
      return c.html(renderErrorPage(), 400);
    }

    await c.env.DB.prepare("UPDATE destinations SET verified_at = ? WHERE id = ?")
      .bind(Date.now(), dest.id)
      .run();

    const email = await decryptDestination(dest.email, c.env.DESTINATION_ENCRYPTION_KEY);
    return c.html(renderSuccessPage(email));
  });

  return r;
}

function renderBaseHtml(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - HideMyEmail</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'none'; frame-ancestors 'none';">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=Inter:wght@400;500&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
  <style>
    :root {
      --canvas:        #0d0d0f;
      --surface-0:     #111114;
      --surface-1:     #18181d;
      --surface-2:     #1f1f26;
      --border:        rgba(255,255,255,0.07);
      --border-strong: rgba(255,255,255,0.13);
      --accent:        #ffb300;
      --accent-dim:    rgba(255, 179, 0, 0.15);
      --accent-glow:   rgba(255, 179, 0, 0.08);
      --accent-hover:  #ffc933;
      --text-primary:  #e8e8ec;
      --text-secondary:#9898a8;
      --text-muted:    #55555f;
      --green:         #3ddc84;
      --green-dim:     rgba(61,220,132,0.12);
      --red:           #ff5050;
      --red-dim:       rgba(255,80,80,0.12);
      --font-display:  'Bricolage Grotesque', sans-serif;
      --font-body:     'Inter', system-ui, sans-serif;
      --font-mono:     'JetBrains Mono', 'Menlo', monospace;
      --shadow-sm:     0 1px 3px rgba(0,0,0,0.5);
      --shadow-md:     0 4px 16px rgba(0,0,0,0.6), 0 1px 3px rgba(0,0,0,0.4);
      --shadow-accent: 0 0 0 1px var(--accent), 0 0 16px var(--accent-glow);
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background: var(--canvas);
      color: var(--text-primary);
      font-family: var(--font-body);
      line-height: 1.6;
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      -webkit-font-smoothing: antialiased;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.028'/%3E%3C/svg%3E");
      background-attachment: fixed;
    }

    .card {
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 40px 32px;
      width: 100%;
      max-width: 440px;
      text-align: center;
      box-shadow: var(--shadow-md);
      position: relative;
      animation: fade-up 350ms ease both;
    }

    @keyframes fade-up {
      from { opacity: 0; transform: translateY(12px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .logo-container {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 56px;
      height: 56px;
      background: var(--surface-2);
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      margin-bottom: 24px;
      color: var(--text-primary);
    }

    .logo-container svg {
      width: 24px;
      height: 24px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    h1 {
      font-family: var(--font-display);
      font-size: 1.6rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
      color: var(--text-primary);
      line-height: 1.15;
    }

    .subtitle {
      font-size: 0.9rem;
      color: var(--text-secondary);
      line-height: 1.5;
      margin-bottom: 24px;
    }

    .email-badge {
      display: inline-block;
      background: var(--surface-0);
      border: 1px dashed rgba(255, 255, 255, 0.08);
      padding: 8px 16px;
      border-radius: 4px;
      font-family: var(--font-mono);
      font-size: 0.82rem;
      color: var(--text-primary);
      margin-bottom: 32px;
      word-break: break-all;
    }

    .btn {
      width: 100%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 14px;
      border-radius: 4px;
      border: 1px solid var(--accent);
      background: var(--accent);
      color: #0d0d0f;
      font-family: var(--font-display);
      font-size: 0.9rem;
      font-weight: 600;
      letter-spacing: 0.02em;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
      text-decoration: none;
    }

    .btn:hover {
      background: var(--accent-hover);
      border-color: var(--accent-hover);
    }

    .btn:focus-visible {
      outline: none;
      box-shadow: var(--shadow-accent);
    }
    
    .btn-secondary {
      background: var(--surface-2);
      border: 1px solid var(--border-strong);
      color: var(--text-primary);
    }
    .btn-secondary:hover {
      background: var(--surface-3);
      border-color: var(--border-strong);
    }

    .icon-accent { color: var(--accent); background: var(--accent-dim); border-color: rgba(255, 179, 0, 0.3); }
    .icon-success { color: var(--green); background: var(--green-dim); border-color: rgba(61, 220, 132, 0.2); }
    .icon-error { color: var(--red); background: var(--red-dim); border-color: rgba(255, 80, 80, 0.2); }

    /* Redact Motif Title Decoration */
    .brand-redact {
      background: var(--accent-dim);
      color: var(--accent);
      border-radius: 4px;
      padding: 0 5px;
      margin: 0 1px;
      border: 1px solid rgba(255, 179, 0, 0.2);
      font-weight: 700;
      display: inline-block;
      user-select: none;
    }

    /* Redirect progress bar */
    .progress-bar-container {
      width: 100%;
      height: 4px;
      background: var(--surface-2);
      border-radius: 2px;
      overflow: hidden;
      margin-top: 24px;
    }
    .progress-bar {
      height: 100%;
      background: var(--green);
      width: 0%;
      animation: fillProgress 3s linear forwards;
    }
    @keyframes fillProgress {
      to { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="card">
    ${content}
  </div>
</body>
</html>`;
}

function renderConfirmationPage(email: string, token: string): string {
  const content = `
    <div class="logo-container icon-accent">
      <svg viewBox="0 0 24 24">
        <rect x="2" y="4" width="20" height="16" rx="2"></rect>
        <path d="M22 6l-10 7L2 6"></path>
      </svg>
    </div>
    <h1>Verify <span class="brand-redact">Destination</span></h1>
    <p class="subtitle">Confirm that you want to verify this destination email address for forwarding.</p>
    <div class="email-badge">${escapeHtml(email)}</div>
    <form method="POST" action="/api/verify">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
      <button type="submit" class="btn">
        Confirm Verification
      </button>
    </form>
  `;
  return renderBaseHtml("Verify Destination", content);
}

function renderSuccessPage(email: string): string {
  const content = `
    <div class="logo-container icon-success">
      <svg viewBox="0 0 24 24">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    </div>
    <h1>Verification Successful</h1>
    <p class="subtitle">Your email address has been verified successfully. You can now use it to forward email aliases.</p>
    <div class="email-badge">${escapeHtml(email)}</div>
    <a href="/" class="btn btn-secondary">Return to Dashboard</a>
  `;
  return renderBaseHtml("Email Verified", content);
}

function renderErrorPage(): string {
  const content = `
    <div class="logo-container icon-error">
      <svg viewBox="0 0 24 24">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
    </div>
    <h1>Link Expired or Invalid</h1>
    <p class="subtitle">This verification link has expired, is invalid, or the email address has already been verified.</p>
    <a href="/" class="btn btn-secondary">Go to Dashboard</a>
  `;
  return renderBaseHtml("Verification Failed", content);
}

// ---------------------------------------------------------------------------
// Outbound verification email builder
// ---------------------------------------------------------------------------

function buildVerificationEmail(to: string, verifyUrl: string, mainGlobalDomain: string = "example.com"): string {
  const boundary = `----=_Part_${Date.now().toString(36)}`;

  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark light">
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
  <title>Verify your email address</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background-color:#0d0d0f;background-image:url('data:image/svg+xml,%3Csvg viewBox=%270 0 256 256%27 xmlns=%27http://www.w3.org/2000/svg%27%3E%3Cfilter id=%27n%27%3E%3CfeTurbulence type=%27fractalNoise%27 baseFrequency=%270.9%27 numOctaves=%274%27 stitchTiles=%27stitch%27/%3E%3C/filter%3E%3Crect width=%27100%25%27 height=%27100%25%27 filter=%27url(%23n)%27 opacity=%270.028%27/%3E%3C/svg%3E');background-attachment:fixed;font-family:'Inter',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">

  <!-- Outer wrapper -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="min-height:100vh;">
    <tr>
      <td align="center" style="padding:48px 16px;">

        <!-- Card -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
          <tr>
            <td style="background:#18181d;border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:48px 40px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.7);">

              <!-- Brand Logo Wordmark matching website -->
              <div style="font-size:22px;font-weight:700;color:#e8e8ec;letter-spacing:-0.03em;margin-bottom:28px;font-family:'Bricolage Grotesque','Inter',sans-serif;text-align:center;user-select:none;">
                hide<span style="background:rgba(255,179,0,0.15);color:#ffb300;border-radius:4px;padding:0 5px;margin:0 2px;border:1px solid rgba(255,179,0,0.2);font-size:0.85em;font-weight:700;vertical-align:middle;display:inline-block;">my</span>email
              </div>

              <!-- Heading -->
              <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;line-height:1.2;letter-spacing:-0.02em;color:#e8e8ec;font-family:'Bricolage Grotesque','Inter',sans-serif;">
                Verify <span style="background:rgba(255,179,0,0.15);color:#ffb300;border-radius:4px;padding:0 5px;margin:0 1px;border:1px solid rgba(255,179,0,0.2);font-weight:700;display:inline-block;">Destination</span>
              </h1>

              <!-- Body copy -->
              <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#9898a8;font-family:'Inter',sans-serif;">
                Confirm that you want to verify this destination email address for forwarding.
              </p>

              <!-- Email badge styling matching dashboard -->
              <div style="display:inline-block;background:#111114;border:1px dashed rgba(255,255,255,0.08);padding:8px 16px;border-radius:4px;font-family:'JetBrains Mono','Menlo',monospace;font-size:13px;color:#e8e8ec;margin-bottom:32px;word-break:break-all;text-align:center;">
                ${escapeHtml(to)}
              </div>

              <!-- CTA button matching var(--radius-sm) (4px) and primary theme -->
              <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto 32px;width:100%;">
                <tr>
                  <td style="border-radius:4px;background:#ffb300;text-align:center;">
                    <a href="${escapeHtml(verifyUrl)}" target="_blank"
                       style="display:block;padding:11px 20px;font-size:14px;font-weight:600;letter-spacing:0.02em;color:#0d0d0f;text-decoration:none;border-radius:4px;font-family:'Bricolage Grotesque','Inter',sans-serif;background:#ffb300;border:1px solid #ffb300;">
                      Confirm Verification
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Divider -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                <tr>
                  <td style="border-top:1px solid rgba(255,255,255,0.07);font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Fallback URL section -->
              <p style="margin:0 0 8px;font-size:12px;color:#55555f;font-family:'Inter',sans-serif;text-align:left;">
                If the button doesn't work, copy and paste this link into your browser:
              </p>
              <p style="margin:0;font-size:11px;font-family:'JetBrains Mono','Menlo',monospace;color:#9898a8;word-break:break-all;background:#111114;border:1px dashed rgba(255,255,255,0.08);border-radius:4px;padding:10px 12px;text-align:left;">
                ${escapeHtml(verifyUrl)}
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 0 0;text-align:center;">
              <p style="margin:0 0 6px;font-size:11px;color:#55555f;font-family:'Inter',sans-serif;line-height:1.5;">
                This link was requested for HideMyEmail. If you did not request this, you can safely ignore this email.
              </p>
              <p style="margin:0;font-size:11px;color:#55555f;font-family:'Inter',sans-serif;">
                &copy; ${new Date().getFullYear()} HideMyEmail &middot; <a href="https://${escapeHtml(mainGlobalDomain)}" style="color:#ffb300;text-decoration:none;font-weight:500;">${escapeHtml(mainGlobalDomain)}</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;

  const textBody = `Verify your email address — HideMyEmail
===========================================

You added ${to} as a destination for email forwarding.
Click the link below to confirm this address:

${verifyUrl}

This link expires in 24 hours. If you did not request this, you can safely ignore this email.

— HideMyEmail (https://${mainGlobalDomain})`;

  // Build a MIME multipart/alternative message
  const msgLines = [
    `From: HideMyEmail <noreply@${mainGlobalDomain}>`,
    `To: ${to}`,
    `Subject: Verify your email address`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${mainGlobalDomain}>`,
    `Reply-To: HideMyEmail <noreply@${mainGlobalDomain}>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    textBody,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    btoa(unescape(encodeURIComponent(htmlBody))),
    ``,
    `--${boundary}--`,
  ];

  const rawMsg = msgLines.join("\r\n");
  return btoa(unescape(encodeURIComponent(rawMsg)));
}
