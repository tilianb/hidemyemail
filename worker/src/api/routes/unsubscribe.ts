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

  // RFC 8058 requires POST. GET is provided so users who click the link in a
  // browser see a useful confirmation page instead of a 405.
  r.on(["GET", "POST"], "/unsubscribe", async (c) => {
    const a = c.req.query("a");
    const s = c.req.query("s");
    if (!a || !s) return c.text("Bad request", 400);

    const aliasId = parseInt(a, 10);
    if (!Number.isFinite(aliasId) || aliasId <= 0) return c.text("Bad request", 400);

    const expected = await signAction("disable", String(aliasId), c.env);
    if (!constantTimeEqual(s, expected)) return c.text("Forbidden", 403);

    const alias = await q.getAliasById(c.env.DB, aliasId);
    if (!alias) return c.text("Unsubscribed", 200); // don't leak existence

    if (alias.active === 1) {
      await c.env.DB.prepare("UPDATE aliases SET active = 0 WHERE id = ?").bind(aliasId).run();
      await q.insertEvent(c.env.DB, {
        alias_id: aliasId,
        type: "block",
        detail: "disabled via https one-click unsubscribe",
        ts: Date.now(),
      });
    }

    // MUAs ignore the body on POST; humans on GET get a plain confirmation.
    return c.text("Unsubscribed. This alias will no longer forward mail.", 200);
  });

  return r;
}

function constantTimeEqual(a: string, b: string): boolean {
  let match = a.length === b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) match = false;
  }
  return match;
}
