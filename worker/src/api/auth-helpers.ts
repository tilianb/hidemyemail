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
  const token = getCookie(c, "__Host-fresh-auth");
  return !!token && await verifyFreshAuth(c.env.SESSION_SECRET, token, c.get("userId"));
}
