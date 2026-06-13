import { base32Encode, hashBackupCode } from "./totp";

// Self-service recovery codes. One-time secrets a user saves at signup (or
// regenerates later) and uses — together with their username — to reset access
// without admin help or a destination email. Hashed with the same scheme as MFA
// backup codes; plaintext is shown once and never stored.

const CODE_COUNT = 10;

/**
 * Generate `count` recovery codes. Returns the plaintext (display once) and the
 * SHA-256 hashes (store as a JSON array in users.recovery_codes).
 * Format: XXXX-XXXX base32 (40 bits each), matching the MFA backup-code look.
 */
export async function generateRecoveryCodes(count = CODE_COUNT): Promise<{ plain: string[]; hashed: string[] }> {
  const plain: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    const encoded = base32Encode(bytes);
    plain.push(`${encoded.slice(0, 4)}-${encoded.slice(4, 8)}`);
  }
  const hashed = await Promise.all(plain.map(hashBackupCode));
  return { plain, hashed };
}
