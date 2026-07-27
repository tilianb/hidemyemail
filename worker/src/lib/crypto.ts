import { toBase64, fromBase64, utf8 } from "./bytes";

function looksLikeLegacyPlaintextEmail(value: string): boolean {
  return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(value);
}

function encryptionKey(keyBase64: string): Uint8Array {
  try {
    if (typeof keyBase64 !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(keyBase64)) {
      throw new Error();
    }
    const keyData = fromBase64(keyBase64);
    if (keyData.length !== 32 || toBase64(keyData) !== keyBase64) throw new Error();
    return keyData;
  } catch {
    throw new Error("Invalid encryption key configuration");
  }
}

/**
 * Hash an email using HMAC-SHA256 for deterministic lookups.
 */
export async function hashDestination(email: string, keyBase64: string): Promise<string> {
  const keyData = encryptionKey(keyBase64);
  try {
    const key = await crypto.subtle.importKey(
      "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, utf8(email.toLowerCase()));
    return toBase64(new Uint8Array(signature));
  } catch (err) {
    console.error("hashDestination error:", err);
    throw new Error("Invalid encryption key configuration");
  }
}

/**
 * Encrypt a destination email using AES-GCM with a random IV.
 * Returns a base64 string containing the IV prepended to the ciphertext.
 */
export async function encryptDestination(email: string, keyBase64: string): Promise<string> {
  const keyData = encryptionKey(keyBase64);
  try {
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
  } catch (err) {
    console.error("encryptDestination error:", err);
    throw new Error("Invalid encryption key configuration");
  }
}

/**
 * Decrypt a base64 destination email using AES-GCM.
 */
export async function decryptDestination(encryptedBase64: string, keyBase64: string): Promise<string> {
  const keyData = encryptionKey(keyBase64);
  try {
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
  } catch (err) {
    if (looksLikeLegacyPlaintextEmail(encryptedBase64)) {
      console.warn("Using legacy plaintext destination row");
      return encryptedBase64;
    }
    throw new Error("Unable to decrypt stored value");
  }
}
