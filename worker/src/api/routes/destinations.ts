import { Hono } from "hono";
import type { AppEnv } from "../app";
import { sendRaw } from "../../lib/ses";

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
  <title>${escapeHtml(title)} - HideMyEmail</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; frame-ancestors 'none';">
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
