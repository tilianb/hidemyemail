import { toHex } from "./bytes";

const enc = new TextEncoder();
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export function timingSafeEqual(a: string, b: string): boolean {
  // Fail closed if either side is missing (e.g. an unconfigured hash/salt)
  // rather than throwing on undefined.length.
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, key, 256);
  return toHex(bits);
}

export async function hashPassword(password: string): Promise<{ saltHex: string; hashHex: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { saltHex: toHex(salt.buffer), hashHex: await pbkdf2(password, salt) };
}

export async function derivePassphraseHash(passphrase: string, globalSaltHex: string): Promise<string> {
  return await pbkdf2(passphrase, fromHex(globalSaltHex));
}

export async function createPassphraseVerifier(passphrase: string): Promise<string> {
  const { saltHex, hashHex } = await hashPassword(passphrase);
  return `v1$${saltHex}$${hashHex}`;
}

export async function verifyPassphraseVerifier(passphrase: string, verifier: string): Promise<boolean> {
  if (!/^v1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(verifier)) return false;
  const [version, saltHex, hashHex] = verifier.split("$");
  return version === "v1" && !!saltHex && !!hashHex && await verifyPassword(passphrase, saltHex, hashHex);
}

export async function updatePasskeySignCount(db: D1Database, credentialId: string, oldCounter: number, newCounter: number): Promise<boolean> {
  const result = await db.prepare(
    "UPDATE passkey_credentials SET sign_count = ? WHERE id = ? AND sign_count = ?"
  ).bind(newCounter, credentialId, oldCounter).run();
  return result.meta.changes === 1;
}

export function passkeyArtifactExpiresAt(token: string): number | null {
  const parts = token.split(".");
  let index: number;
  switch (parts[0]) {
    case "pauth":
      index = 1;
      break;
    case "pauthmfa2":
      index = 3;
      break;
    case "mfa-passkey1":
      index = 4;
      break;
    default:
      return null;
  }
  const value = Number(parts[index]);
  return Number.isSafeInteger(value) ? value : null;
}

export async function verifyPassword(password: string, saltHex: string, hashHex: string): Promise<boolean> {
  // No configured credential → no match (fail closed, never throw).
  if (!saltHex || !hashHex) return false;
  const computed = await pbkdf2(password, fromHex(saltHex));
  return timingSafeEqual(computed, hashHex);
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function signMfaChallenge(secret: string, userId: number, authVersion: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 300; // 5 minutes
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const payload = `mfa3.${userId}.${authVersion}.${exp}.${nonce}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyMfaChallenge(secret: string, token: string): Promise<{ userId: number; authVersion: number; expiresAt: number } | null> {
  const parts = token.split(".");
  if (parts.length !== 6 || parts[0] !== "mfa3") return null;
  const [, userIdStr, authVersionStr, expStr, nonce, sig] = parts;
  const payload = `mfa3.${userIdStr}.${authVersionStr}.${expStr}.${nonce}`;
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(sig!, expected)) return null;
  const userId = Number(userIdStr);
  const authVersion = Number(authVersionStr);
  const expiresAt = Number(expStr);
  if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(authVersion) || authVersion < 0 ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000) || !/^[a-f0-9]{32}$/.test(nonce!)) return null;
  return { userId, authVersion, expiresAt };
}

// Passkey auth challenge (no userId — discoverable credential flow)
// Format: pauth.{exp}.{challengeB64url}.{hmac}
export async function signPasskeyAuthChallenge(secret: string, challenge: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 300;
  const payload = `pauth.${exp}.${challenge}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyPasskeyAuthChallenge(secret: string, token: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "pauth") return null;
  const [, expStr, challenge, sig] = parts;
  const payload = `pauth.${expStr}.${challenge}`;
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(sig!, expected)) return null;
  if (Number(expStr) > Math.floor(Date.now() / 1000)) return challenge!;
  return null;
}

// Account-bound passkey MFA challenge. This is deliberately a distinct
// artifact from the discoverable, standalone `pauth` login token: the server
// derives MFA mode and its principal exclusively from this signed payload. The
// parent artifact hash binds admission to one password-authenticated login.
// Format: pauthmfa2.{userId}.{authVersion}.{exp}.{challengeB64url}.{parentHash}.{hmac}
export async function signPasskeyMfaChallenge(
  secret: string,
  userId: number,
  authVersion: number,
  challenge: string,
  parentArtifactHash: string,
  parentExpiresAt: number,
): Promise<string> {
  const exp = Math.min(Math.floor(Date.now() / 1000) + 300, parentExpiresAt);
  const payload = `pauthmfa2.${userId}.${authVersion}.${exp}.${challenge}.${parentArtifactHash}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyPasskeyMfaChallenge(secret: string, token: string): Promise<{
  userId: number;
  authVersion: number;
  challenge: string;
  parentArtifactHash: string;
  expiresAt: number;
} | null> {
  const parts = token.split(".");
  if (parts.length !== 7 || parts[0] !== "pauthmfa2") return null;
  const [, userIdStr, authVersionStr, expStr, challenge, parentArtifactHash, sig] = parts;
  const payload = `pauthmfa2.${userIdStr}.${authVersionStr}.${expStr}.${challenge}.${parentArtifactHash}`;
  if (!timingSafeEqual(sig!, await hmac(secret, payload))) return null;
  const userId = Number(userIdStr);
  const authVersion = Number(authVersionStr);
  const exp = Number(expStr);
  if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(authVersion) || authVersion < 0 ||
      !Number.isSafeInteger(exp) || exp <= Math.floor(Date.now() / 1000) || !challenge ||
      !/^[A-Za-z0-9_-]{43}$/.test(parentArtifactHash!)) return null;
  return { userId, authVersion, challenge, parentArtifactHash: parentArtifactHash!, expiresAt: exp };
}

export type ReauthChannel = "web" | "native";
export async function signReauthPasskeyChallenge(secret: string, userId: number, authVersion: number, channel: ReauthChannel, challenge: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 300;
  const payload = `reauthpk1.${userId}.${authVersion}.${channel}.${exp}.${challenge}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyReauthPasskeyChallenge(secret: string, token: string): Promise<{ userId: number; authVersion: number; channel: ReauthChannel; challenge: string; expiresAt: number } | null> {
  const parts = token.split(".");
  if (parts.length !== 7 || parts[0] !== "reauthpk1") return null;
  const [, userId, version, channel, expiration, challenge, signature] = parts;
  if (channel !== "web" && channel !== "native") return null;
  const payload = `reauthpk1.${userId}.${version}.${channel}.${expiration}.${challenge}`;
  if (!timingSafeEqual(signature!, await hmac(secret, payload))) return null;
  const expiresAt = Number(expiration);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return null;
  return { userId: Number(userId), authVersion: Number(version), channel, challenge: challenge!, expiresAt };
}

// Passkey registration challenge (userId included, user already authenticated)
// Format: preg.{userId}.{exp}.{challengeB64url}.{hmac}
export async function signPasskeyRegChallenge(secret: string, userId: number, challenge: string, authVersion = 0): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 300;
  const payload = `preg2.${userId}.${authVersion}.${exp}.${challenge}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyPasskeyRegChallenge(secret: string, token: string): Promise<{ userId: number; authVersion: number; challenge: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 6 || parts[0] !== "preg2") return null;
  const [, userIdStr, authVersionStr, expStr, challenge, sig] = parts;
  const payload = `preg2.${userIdStr}.${authVersionStr}.${expStr}.${challenge}`;
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(sig!, expected)) return null;
  if (Number(expStr) > Math.floor(Date.now() / 1000)) {
    return { userId: Number(userIdStr), authVersion: Number(authVersionStr), challenge: challenge! };
  }
  return null;
}

export async function signSecurityHandoff(secret: string, userId: number, authVersion: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 120;
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const payload = `security1.${userId}.${authVersion}.${exp}.${nonce}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifySecurityHandoff(secret: string, token: string): Promise<{ userId: number; authVersion: number; expiresAt: number } | null> {
  const parts = token.split(".");
  if (parts.length !== 6 || parts[0] !== "security1") return null;
  const [, userIdStr, authVersionStr, expStr, nonce, sig] = parts;
  const payload = `security1.${userIdStr}.${authVersionStr}.${expStr}.${nonce}`;
  if (!timingSafeEqual(sig!, await hmac(secret, payload))) return null;
  const expiresAt = Number(expStr);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return null;
  return { userId: Number(userIdStr), authVersion: Number(authVersionStr), expiresAt };
}

export async function signSession(secret: string, userId: number, ttlSeconds: number, authVersion = 0): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `v3.${userId}.${authVersion}.${exp}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function signFreshAuth(secret: string, userId: number, ttlSeconds: number, authVersion = 0): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `fresh2.${userId}.${authVersion}.${exp}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyFreshAuth(secret: string, token: string, userId: number, authVersion = 0): Promise<boolean> {
  const parts = token.split(".");
  const legacy = parts.length === 4 && parts[0] === "fresh";
  if (!legacy && (parts.length !== 5 || parts[0] !== "fresh2")) return false;
  const [v, userIdStr, versionOrExp, expOrSig, newSig] = parts;
  const tokenVersion = legacy ? 0 : Number(versionOrExp);
  const expStr = legacy ? versionOrExp : expOrSig;
  const sig = legacy ? expOrSig : newSig;
  if (Number(userIdStr) !== userId || tokenVersion !== authVersion) return false;
  const payload = legacy ? `${v}.${userIdStr}.${expStr}` : `${v}.${userIdStr}.${versionOrExp}.${expStr}`;
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(sig!, expected)) return false;
  return Number(expStr) > Math.floor(Date.now() / 1000);
}

export type MfaPasskeyAction = "disable" | "backup-codes";

export async function signMfaPasskeyChallenge(
  secret: string,
  userId: number,
  authVersion: number,
  action: MfaPasskeyAction,
  challenge: string,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 300;
  const payload = `mfa-passkey1.${userId}.${authVersion}.${action}.${exp}.${challenge}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyMfaPasskeyChallenge(
  secret: string,
  token: string,
): Promise<{ userId: number; authVersion: number; action: MfaPasskeyAction; challenge: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 7 || parts[0] !== "mfa-passkey1") return null;
  const [, userIdStr, authVersionStr, action, expStr, challenge, sig] = parts;
  if (action !== "disable" && action !== "backup-codes") return null;
  const payload = `mfa-passkey1.${userIdStr}.${authVersionStr}.${action}.${expStr}.${challenge}`;
  if (!timingSafeEqual(sig!, await hmac(secret, payload))) return null;
  if (Number(expStr) <= Math.floor(Date.now() / 1000)) return null;
  return { userId: Number(userIdStr), authVersion: Number(authVersionStr), action, challenge: challenge! };
}

// App-auth handoff codes (web-session login → native bearer token).
//
// The native app opens the dashboard login in an ASWebAuthenticationSession
// with a PKCE-style challenge (= base64url SHA-256 of a verifier the app keeps
// secret). After the web login succeeds, the dashboard asks the (session-
// authenticated) Worker for a short-lived code bound to that challenge, and
// redirects back to the app's custom URL scheme. The app exchanges
// code + verifier for a bearer token. A leaked or replayed code is useless
// without the verifier, which never leaves the app.
const APP_AUTH_CODE_TTL = 120; // seconds

export async function signAppAuthCode(secret: string, userId: number, authVersion: number, challenge: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + APP_AUTH_CODE_TTL;
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const payload = `appauth2.${userId}.${authVersion}.${exp}.${challenge}.${nonce}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyAppAuthCode(secret: string, code: string): Promise<{ userId: number; authVersion: number; challenge: string } | null> {
  const parts = code.split(".");
  if (parts.length !== 7 || parts[0] !== "appauth2") return null;
  const [, userIdStr, authVersionStr, expStr, challenge, nonce, sig] = parts;
  const payload = `appauth2.${userIdStr}.${authVersionStr}.${expStr}.${challenge}.${nonce}`;
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(sig!, expected)) return null;
  if (Number(expStr) <= Math.floor(Date.now() / 1000)) return null;
  return { userId: Number(userIdStr), authVersion: Number(authVersionStr), challenge: challenge! };
}

/// base64url (no padding) SHA-256 — the PKCE challenge derivation.
export async function sha256Base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  let s = "";
  for (const b of new Uint8Array(digest)) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function verifySession(secret: string, token: string): Promise<{ userId: number; authVersion: number } | null> {
  const parts = token.split(".");
  const legacy = parts.length === 4 && parts[0] === "v2";
  if (legacy || (parts.length === 5 && parts[0] === "v3")) {
    const [v, userIdStr, versionOrExp, expOrSig, newSig] = parts;
    const authVersion = legacy ? 0 : Number(versionOrExp);
    const expStr = legacy ? versionOrExp : expOrSig;
    const sig = legacy ? expOrSig : newSig;
    const payload = legacy ? `${v}.${userIdStr}.${expStr}` : `${v}.${userIdStr}.${versionOrExp}.${expStr}`;
    const expected = await hmac(secret, payload);
    if (!timingSafeEqual(sig!, expected)) return null;
    if (Number(expStr) > Math.floor(Date.now() / 1000)) return { userId: Number(userIdStr), authVersion };
    return null;
  }
  return null;
}
