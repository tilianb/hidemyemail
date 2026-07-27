import { toBase64, fromBase64, utf8 } from "./bytes";

/**
 * Determines whether a value resembles a legacy plaintext email address.
 *
 * @param value - The value to inspect
 * @returns `true` if the value matches the expected plaintext email format, `false` otherwise.
 */
function looksLikeLegacyPlaintextEmail(value: string): boolean {
  return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(value);
}

/**
 * Validates and decodes a base64-encoded 32-byte encryption key.
 *
 * @param keyBase64 - The base64-encoded encryption key
 * @returns The decoded 32-byte encryption key
 * @throws An error if the key is invalid
 */
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
 * Encrypts a destination email with AES-GCM using a randomly generated initialization vector.
 *
 * @param email - The destination email to encrypt.
 * @param keyBase64 - The base64-encoded 32-byte encryption key.
 * @returns A base64-encoded value containing the initialization vector followed by the ciphertext.
 * @throws Error If the encryption key is invalid or encryption fails.
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
 * Decrypts an encrypted destination value or preserves a legacy plaintext email.
 *
 * @param encryptedBase64 - The base64-encoded IV and AES-GCM ciphertext, or a legacy plaintext email
 * @param keyBase64 - The base64-encoded AES-GCM key
 * @returns The decrypted destination email or the unchanged legacy plaintext email
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
