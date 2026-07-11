// Shared admin-passphrase derivation for the bootstrap scripts
// (hash-password.mjs, setup.mjs). Must stay in lockstep with the Worker's
// verifier in worker/src/lib/auth.ts (PBKDF2-SHA256, 100k iterations,
// 16-byte salt, 256-bit output, hex encoding).

const toHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** @returns {Promise<{salt: string, hash: string}>} hex salt + hex PBKDF2 hash */
export async function hashPassphrase(passphrase) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, key, 256
  );
  return { salt: toHex(salt.buffer), hash: toHex(bits) };
}
