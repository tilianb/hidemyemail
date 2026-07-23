import { deleteCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv } from "./app";
import { signFreshAuth, signSession } from "../lib/auth";

const SESSION_TTL = 60 * 60 * 24 * 7;
const FRESH_AUTH_TTL = 60 * 10;

export function wantsToken(c: Context<AppEnv>): boolean {
  return c.req.header("X-Auth-Mode") === "token" && !c.req.header("Origin");
}

export async function setAuthenticatedCookies(
  c: Context<AppEnv>,
  userId: number,
  authVersion: number,
): Promise<{ token: string; freshAuth: string }> {
  const sessionToken = await signSession(c.env.SESSION_SECRET, userId, SESSION_TTL, authVersion);
  const freshAuthToken = await signFreshAuth(c.env.SESSION_SECRET, userId, FRESH_AUTH_TTL, authVersion);
  setCookie(c, "__Host-session", sessionToken, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_TTL });
  setCookie(c, "__Host-fresh-auth", freshAuthToken, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: FRESH_AUTH_TTL });
  return { token: sessionToken, freshAuth: freshAuthToken };
}

export function clearAuthenticatedCookies(c: Context<AppEnv>): void {
  deleteCookie(c, "__Host-session", { path: "/", secure: true });
  deleteCookie(c, "__Host-fresh-auth", { path: "/", secure: true });
}

export function randomSixDigitCode(): string {
  const max = 1_000_000;
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while (values[0]! >= limit);
  return (values[0]! % max).toString().padStart(6, "0");
}
