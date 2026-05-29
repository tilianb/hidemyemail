import { Hono } from "hono";
import type { AppEnv } from "../app";
import * as q from "../../db/queries";
import { signAction } from "../../email/action";

// RFC 8058 one-click unsubscribe.
//
// The List-Unsubscribe header in forwarded mail points here as the HTTPS
// alternative to the mailto: action+disable address. MUAs (Gmail, Outlook,
// Yahoo) post to this URL when the user clicks "Unsubscribe" in the message
// surface — no session, no challenge, no body required by the spec.
//
// We reuse the existing `signAction("disable", aliasId)` HMAC so the link is
// stable for as long as ACTION_SECRET is unchanged, and a leaked signature
// only ever disables the alias it was minted for.
export function unsubscribeRoutes() {
  const r = new Hono<AppEnv>();

  // SECURITY: the HMAC signature travels inside the URL embedded in the
  // List-Unsubscribe header, so any agent that *fetches* the link already holds
  // a valid signature. Mail-security scanners, link-safety prefetchers and
  // browser preconnects routinely issue GET against URLs in mail — performing
  // the disable on GET lets those automated fetches silently stop forwarding
  // without the recipient ever intending it. Per RFC 8058 the state change MUST
  // happen on POST. GET only renders a confirmation form (no DB write); the
  // form POSTs back to perform the disable. One-click MUAs (Gmail, Outlook,
  // Yahoo) POST directly via List-Unsubscribe-Post and never see the form.
  r.get("/unsubscribe", async (c) => {
    const parsed = await parseSignedRequest(c);
    if (parsed.error) return c.text(parsed.error.body, parsed.error.status);
    return c.html(confirmPage(parsed.a!, parsed.s!), 200);
  });

  r.post("/unsubscribe", async (c) => {
    const parsed = await parseSignedRequest(c);
    if (parsed.error) return c.text(parsed.error.body, parsed.error.status);
    const aliasId = parsed.aliasId!;

    const alias = await q.getAliasById(c.env.DB, aliasId);
    if (!alias) return c.text("Unsubscribed. This alias will no longer forward mail.", 200); // don't leak existence

    if (alias.active === 1) {
      await c.env.DB.prepare("UPDATE aliases SET active = 0 WHERE id = ?").bind(aliasId).run();
      await q.insertEvent(c.env.DB, {
        alias_id: aliasId,
        type: "block",
        detail: "disabled via https one-click unsubscribe",
        ts: Date.now(),
      });
    }

    return c.text("Unsubscribed. This alias will no longer forward mail.", 200);
  });

  return r;
}

// Validate the ?a=&s= query params and the HMAC signature. Returns the raw
// params (for re-embedding in the confirmation form) and the parsed aliasId,
// or an error response to return verbatim. No DB write happens here.
async function parseSignedRequest(
  c: { req: { query: (k: string) => string | undefined }; env: AppEnv["Bindings"] }
): Promise<{ a?: string; s?: string; aliasId?: number; error?: { body: string; status: 400 | 403 } }> {
  const a = c.req.query("a");
  const s = c.req.query("s");
  if (!a || !s) return { error: { body: "Bad request", status: 400 } };

  const aliasId = parseInt(a, 10);
  if (!Number.isFinite(aliasId) || aliasId <= 0) return { error: { body: "Bad request", status: 400 } };

  const expected = await signAction("disable", String(aliasId), c.env);
  if (!constantTimeEqual(s, expected)) return { error: { body: "Forbidden", status: 403 } };

  return { a, s, aliasId };
}

// Minimal self-submitting confirmation page. Escapes the signed params (they are
// already constrained — `a` is a positive int, `s` an HMAC hex — but escape
// defensively before interpolating into HTML attributes).
function confirmPage(a: string, s: string): string {
  const ea = escapeAttr(a);
  const es = escapeAttr(s);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>Unsubscribe</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:30rem;margin:4rem auto;padding:0 1rem;line-height:1.5}` +
    `button{font-size:1rem;padding:.6rem 1.2rem;border:0;border-radius:.4rem;background:#b91c1c;color:#fff;cursor:pointer}</style>` +
    `</head><body><h1>Stop forwarding?</h1>` +
    `<p>Confirm to disable this alias. It will no longer forward incoming mail. You can re-enable it from your dashboard.</p>` +
    `<form method="POST" action="/api/unsubscribe?a=${ea}&amp;s=${es}">` +
    `<button type="submit">Unsubscribe</button></form></body></html>`;
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function constantTimeEqual(a: string, b: string): boolean {
  let match = a.length === b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) match = false;
  }
  return match;
}
