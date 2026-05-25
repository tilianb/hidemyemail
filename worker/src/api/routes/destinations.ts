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
    const { email } = await c.req.json<{ email: string }>().catch(() => ({ email: "" }));
    if (!email || !email.includes("@")) return c.json({ error: "invalid email" }, 400);

    const token = crypto.randomUUID();
    
    try {
      await c.env.DB.prepare(
        "INSERT INTO destinations (user_id, email, token, created_at) VALUES (?, ?, ?, ?)"
      ).bind(userId, email, token, Date.now()).run();
      
      // Send verification email via SES
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
    
    const dest = await c.env.DB.prepare("SELECT id FROM destinations WHERE token = ? AND verified_at IS NULL").bind(token).first<{ id: number }>();
    if (!dest) {
      return c.html(`<html><body><h1>Invalid or expired token</h1><p>This verification link has expired or the email is already verified.</p></body></html>`, 400);
    }

    await c.env.DB.prepare("UPDATE destinations SET verified_at = ? WHERE id = ?").bind(Date.now(), dest.id).run();
    
    return c.html(`<html><body><h1>Email verified!</h1><p>You can now use this email address for forwarding.</p><script>setTimeout(() => window.location.href = '/', 3000);</script></body></html>`);
  });

  return r;
}
