import { Hono } from "hono";
import type { AppEnv } from "../app";
import { sendRaw } from "../../lib/ses";

export function destinationRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/destinations", async (c) => {
    const userId = c.get("userId");
    const rows = await c.env.DB.prepare(
      "SELECT id, email, verified_at, created_at FROM destinations WHERE user_id = ? ORDER BY created_at DESC"
    ).bind(userId).all();
    return c.json(rows.results ?? []);
  });

  r.post("/destinations", async (c) => {
    const userId = c.get("userId");
    let { email } = await c.req.json<{ email: string }>().catch(() => ({ email: "" }));
    if (!email || !email.includes("@")) return c.json({ error: "invalid email" }, 400);
    email = email.toLowerCase();

    const existing = await c.env.DB.prepare("SELECT id FROM destinations WHERE user_id = ? AND email = ?").bind(userId, email).first();
    if (existing) return c.json({ error: "already added" }, 409);

    const token = crypto.randomUUID();
    
    try {
      // Send verification email via SES first
      if (c.env.SES_ACCESS_KEY_ID && c.env.SES_SECRET_ACCESS_KEY && c.env.SES_REGION) {
        const verifyUrl = new URL(`/api/verify?token=${token}`, c.req.url).toString();
        const rawMsg = `From: noreply@hidemyemail.dev\r\nTo: ${email}\r\nSubject: Verify your email address\r\n\r\nPlease click the following link to verify your email address:\r\n${verifyUrl}\r\n`;
        const rawBase64 = btoa(unescape(encodeURIComponent(rawMsg)));
        
        await sendRaw({
          accessKeyId: c.env.SES_ACCESS_KEY_ID,
          secretAccessKey: c.env.SES_SECRET_ACCESS_KEY,
          region: c.env.SES_REGION
        }, {
          from: "noreply@hidemyemail.dev",
          to: email,
          rawBase64
        });
      }

      // Save destination to DB after successful send
      await c.env.DB.prepare(
        "INSERT INTO destinations (user_id, email, token, created_at) VALUES (?, ?, ?, ?)"
      ).bind(userId, email, token, Date.now()).run();

      return c.json({ ok: true });
    } catch (err: any) {
      if (err.message && err.message.includes("UNIQUE constraint failed")) {
        return c.json({ error: "already added" }, 409);
      }
      return c.json({ error: "internal error" }, 500);
    }
  });

  r.delete("/destinations/:id", async (c) => {
    const userId = c.get("userId");
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400);

    // Ensure we don't delete if it's currently in use by an alias or domain
    const dest = await c.env.DB.prepare("SELECT email FROM destinations WHERE id = ? AND user_id = ?").bind(id, userId).first<{ email: string }>();
    if (!dest) return c.json({ ok: true });

    const inUseAlias = await c.env.DB.prepare("SELECT id FROM aliases WHERE destination = ? AND user_id = ?").bind(dest.email, userId).first();
    if (inUseAlias) return c.json({ error: "destination in use by aliases" }, 400);
    
    const inUseDomain = await c.env.DB.prepare("SELECT id FROM domains WHERE default_destination = ? AND user_id = ?").bind(dest.email, userId).first();
    if (inUseDomain) return c.json({ error: "destination in use by domains" }, 400);

    await c.env.DB.prepare("DELETE FROM destinations WHERE id = ? AND user_id = ?").bind(id, userId).run();
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

    return c.html(renderConfirmationPage(dest.email, token));
  });

  r.post("/verify", async (c) => {
    const body = await c.req.parseBody().catch(() => ({}));
    const token = typeof body.token === "string" ? body.token : undefined;
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

    return c.html(renderSuccessPage(dest.email));
  });

  return r;
}

function renderBaseHtml(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - HideMyEmail</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Outfit:wght@500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-gradient: linear-gradient(135deg, #090d16 0%, #05070f 100%);
      --card-bg: rgba(17, 24, 39, 0.7);
      --border-color: rgba(255, 255, 255, 0.08);
      --text-primary: #f3f4f6;
      --text-secondary: #9ca3af;
      --primary-color: #6366f1;
      --primary-gradient: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
      --primary-hover: linear-gradient(135deg, #818cf8 0%, #6366f1 100%);
      --shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.5);
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background: var(--bg-gradient);
      color: var(--text-primary);
      font-family: 'Inter', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      overflow: hidden;
      position: relative;
    }

    /* Background glow elements */
    .glow {
      position: absolute;
      width: 400px;
      height: 400px;
      background: radial-gradient(circle, rgba(99, 102, 241, 0.07) 0%, rgba(99, 102, 241, 0) 70%);
      border-radius: 50%;
      z-index: 1;
      filter: blur(40px);
    }
    .glow-1 { top: -100px; left: -100px; }
    .glow-2 { bottom: -100px; right: -100px; }

    .card {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border-color);
      border-radius: 24px;
      padding: 40px 32px;
      width: 100%;
      max-width: 440px;
      text-align: center;
      box-shadow: var(--shadow);
      z-index: 10;
      position: relative;
      animation: floatIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }

    @keyframes floatIn {
      from {
        opacity: 0;
        transform: translateY(20px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .logo-container {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 64px;
      height: 64px;
      background: rgba(99, 102, 241, 0.1);
      border: 1px solid rgba(99, 102, 241, 0.2);
      border-radius: 20px;
      margin-bottom: 24px;
      box-shadow: 0 0 20px rgba(99, 102, 241, 0.1);
    }

    .logo-container svg {
      width: 32px;
      height: 32px;
      fill: none;
      stroke: var(--primary-color);
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    h1 {
      font-family: 'Outfit', sans-serif;
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 12px;
      background: linear-gradient(135deg, #ffffff 0%, #e2e8f0 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .subtitle {
      font-size: 15px;
      color: var(--text-secondary);
      line-height: 1.5;
      margin-bottom: 28px;
    }

    .email-badge {
      display: inline-block;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 8px 16px;
      border-radius: 12px;
      font-family: 'Outfit', sans-serif;
      font-weight: 500;
      font-size: 15px;
      color: #818cf8;
      margin-bottom: 28px;
      word-break: break-all;
    }

    .btn {
      width: 100%;
      padding: 14px 24px;
      font-size: 15px;
      font-weight: 600;
      font-family: 'Inter', sans-serif;
      color: #ffffff;
      background: var(--primary-gradient);
      border: none;
      border-radius: 12px;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      text-decoration: none;
    }

    .btn:hover {
      background: var(--primary-hover);
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(99, 102, 241, 0.4);
    }

    .btn:active {
      transform: translateY(1px);
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
    }

    .btn:focus {
      outline: none;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.5);
    }

    /* Success Theme override */
    .success-icon {
      background: rgba(16, 185, 129, 0.1);
      border-color: rgba(16, 185, 129, 0.2);
    }
    .success-icon svg {
      stroke: #10b981;
    }
    .success-title {
      background: linear-gradient(135deg, #34d399 0%, #059669 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    /* Error Theme override */
    .error-icon {
      background: rgba(239, 68, 68, 0.1);
      border-color: rgba(239, 68, 68, 0.2);
    }
    .error-icon svg {
      stroke: #ef4444;
    }
    .error-title {
      background: linear-gradient(135deg, #f87171 0%, #dc2626 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--text-primary);
      box-shadow: none;
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.08);
      box-shadow: none;
    }

    /* Redirect progress bar */
    .progress-bar-container {
      width: 100%;
      height: 4px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 2px;
      overflow: hidden;
      margin-top: 24px;
    }
    .progress-bar {
      height: 100%;
      background: #10b981;
      width: 0%;
      animation: fillProgress 3s linear forwards;
    }
    @keyframes fillProgress {
      to { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="glow glow-1"></div>
  <div class="glow glow-2"></div>
  
  <div class="card">
    ${content}
  </div>
</body>
</html>`;
}

function renderConfirmationPage(email: string, token: string): string {
  const content = `
    <div class="logo-container">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <rect x="2" y="4" width="20" height="16" rx="2"></rect>
        <path d="M22 6l-10 7L2 6"></path>
      </svg>
    </div>
    <h1>Verify Email</h1>
    <p class="subtitle">Confirm that you want to verify this destination email address for forwarding.</p>
    <div class="email-badge">${email}</div>
    <form method="POST" action="/api/verify">
      <input type="hidden" name="token" value="${token}" />
      <button type="submit" class="btn">
        Confirm Verification
      </button>
    </form>
  `;
  return renderBaseHtml("Verify Destination", content);
}

function renderSuccessPage(email: string): string {
  const content = `
    <div class="logo-container success-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    </div>
    <h1 class="success-title">Verification Successful</h1>
    <p class="subtitle">Your email address has been verified successfully. You can now use it to forward email aliases.</p>
    <div class="email-badge">${email}</div>
    <a href="/" class="btn">Return to Dashboard</a>
    <div class="progress-bar-container">
      <div class="progress-bar"></div>
    </div>
    <script>
      setTimeout(() => {
        window.location.href = '/';
      }, 3000);
    </script>
  `;
  return renderBaseHtml("Email Verified", content);
}

function renderErrorPage(): string {
  const content = `
    <div class="logo-container error-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
        <line x1="12" y1="9" x2="12" y2="13"></line>
        <line x1="12" y1="17" x2="12.01" y2="17"></line>
      </svg>
    </div>
    <h1 class="error-title">Link Expired or Invalid</h1>
    <p class="subtitle">This verification link has expired, is invalid, or the email address has already been verified.</p>
    <a href="/" class="btn btn-secondary">Go to Dashboard</a>
  `;
  return renderBaseHtml("Verification Failed", content);
}
