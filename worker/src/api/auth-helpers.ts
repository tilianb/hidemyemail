import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv } from "./app";
import { verifyFreshAuth } from "../lib/auth";

/**
 * Determines whether the request includes valid fresh authentication credentials.
 *
 * @returns `true` if the fresh-auth credential is valid for the current user and authentication version, `false` otherwise.
 */
export async function hasFreshAuth(c: Context<AppEnv>): Promise<boolean> {
  // Web clients hold the HttpOnly cookie; native bearer clients carry the
  // fresh-auth token returned by the token-mode login response in this header.
  const token = c.get("authSource") === "bearer"
    ? c.req.header("X-Fresh-Auth")
    : getCookie(c, "__Host-fresh-auth");
  return !!token && await verifyFreshAuth(c.env.SESSION_SECRET, token, c.get("userId"), c.get("authVersion"));
}

/**
 * Determines whether the request uses native bearer-token authentication.
 *
 * @returns `true` when the request uses bearer authentication with token mode and has no `Origin` header, `false` otherwise.
 */
export function isAuthenticatedNative(c: Context<AppEnv>): boolean {
  return c.get("authSource") === "bearer" && c.req.header("X-Auth-Mode") === "token" && !c.req.header("Origin");
}
