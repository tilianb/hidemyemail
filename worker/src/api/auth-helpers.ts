import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv } from "./app";
import { verifyFreshAuth } from "../lib/auth";

/**
 * True when the caller holds a valid __Host-fresh-auth cookie for the
 * session's user. Gate for operations a stolen long-lived session must not
 * reach on its own: MFA/passkey changes, data export, account deletion.
 */
export async function hasFreshAuth(c: Context<AppEnv>): Promise<boolean> {
  // Web clients hold the HttpOnly cookie; native bearer clients carry the
  // fresh-auth token returned by the token-mode login response in this header.
  const token = getCookie(c, "__Host-fresh-auth") || c.req.header("X-Fresh-Auth");
  return !!token && await verifyFreshAuth(c.env.SESSION_SECRET, token, c.get("userId"));
}
