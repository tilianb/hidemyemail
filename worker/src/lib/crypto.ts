import { toBase64, fromBase64, utf8 } from "./bytes";

/**
 * Hash an email using HMAC-SHA256 for deterministic lookups.
 */
export async function hashDestination(email: string, keyBase64: string): Promise<string> {
  const keyData = fromBase64(keyBase64);
  const key = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, utf8(email.toLowerCase()));
  return toBase64(new Uint8Array(signature));
}

/**
 * Encrypt a destination email using AES-GCM with a random IV.
 * Returns a base64 string containing the IV prepended to the ciphertext.
 */
export async function encryptDestination(email: string, keyBase64: string): Promise<string> {
  const keyData = fromBase64(keyBase64);
  const key = await crypto.subtle.importKey(
    "raw", keyData, "AES-GCM", false, ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, utf8(email.toLowerCase())
  );
  const ciphertext = new Uint8Array(ciphertextBuf);
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return toBase64(combined);
}

/**
 * Decrypt a base64 destination email using AES-GCM.
 */
export async function decryptDestination(encryptedBase64: string, keyBase64: string): Promise<string> {
  const keyData = fromBase64(keyBase64);
  const key = await crypto.subtle.importKey(
    "raw", keyData, "AES-GCM", false, ["decrypt"]
  );
  const combined = fromBase64(encryptedBase64);
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const plaintextBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv }, key, ciphertext
  );
  return new TextDecoder().decode(plaintextBuf);
}
