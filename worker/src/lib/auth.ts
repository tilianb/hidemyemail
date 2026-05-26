const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export function timingSafeEqual(a: string, b: string): boolean {
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

export async function verifyPassword(password: string, saltHex: string, hashHex: string): Promise<boolean> {
  const computed = await pbkdf2(password, fromHex(saltHex));
  return timingSafeEqual(computed, hashHex);
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function signMfaChallenge(secret: string, userId: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 300; // 5 minutes
  const payload = `mfa.${userId}.${exp}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyMfaChallenge(secret: string, token: string): Promise<number | null> {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "mfa") return null;
  const [, userIdStr, expStr, sig] = parts;
  const payload = `mfa.${userIdStr}.${expStr}`;
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(sig!, expected)) return null;
  if (Number(expStr) > Math.floor(Date.now() / 1000)) return Number(userIdStr);
  return null;
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

// Passkey registration challenge (userId included, user already authenticated)
// Format: preg.{userId}.{exp}.{challengeB64url}.{hmac}
export async function signPasskeyRegChallenge(secret: string, userId: number, challenge: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 300;
  const payload = `preg.${userId}.${exp}.${challenge}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyPasskeyRegChallenge(secret: string, token: string): Promise<{ userId: number; challenge: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "preg") return null;
  const [, userIdStr, expStr, challenge, sig] = parts;
  const payload = `preg.${userIdStr}.${expStr}.${challenge}`;
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(sig!, expected)) return null;
  if (Number(expStr) > Math.floor(Date.now() / 1000)) return { userId: Number(userIdStr), challenge: challenge! };
  return null;
}

export async function signSession(secret: string, userId: number, ttlSeconds: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `v2.${userId}.${exp}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifySession(secret: string, token: string): Promise<number | null> {
  const parts = token.split(".");
  if (parts.length === 3) {
    const [v, expStr, sig] = parts;
    if (v !== "v1") return null;
    const payload = `${v}.${expStr}`;
    const expected = await hmac(secret, payload);
    if (!timingSafeEqual(sig!, expected)) return null;
    if (Number(expStr) > Math.floor(Date.now() / 1000)) return 1;
    return null;
  }
  if (parts.length === 4) {
    const [v, userIdStr, expStr, sig] = parts;
    if (v !== "v2") return null;
    const payload = `${v}.${userIdStr}.${expStr}`;
    const expected = await hmac(secret, payload);
    if (!timingSafeEqual(sig!, expected)) return null;
    if (Number(expStr) > Math.floor(Date.now() / 1000)) return Number(userIdStr);
    return null;
  }
  return null;
}
