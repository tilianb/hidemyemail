const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Uint8Array {
  const s = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let buf = 0, bits = 0, idx = 0;
  for (let i = 0; i < s.length; i++) {
    const val = B32.indexOf(s[i]!);
    if (val === -1) continue;
    buf = (buf << 5) | val;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[idx++] = (buf >> bits) & 0xff;
    }
  }
  return out;
}

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buf = 0, bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    buf = (buf << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(buf >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += B32[(buf << (5 - bits)) & 0x1f];
  return out;
}

// 20 bytes = 160-bit secret, standard TOTP size
export function generateTOTPSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

async function hotp(keyBytes: Uint8Array, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const msg = new Uint8Array(8);
  const dv = new DataView(msg.buffer);
  // Write 64-bit big-endian counter (hi/lo 32 bits)
  dv.setUint32(0, Math.floor(counter / 0x100000000), false);
  dv.setUint32(4, counter >>> 0, false);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = digest[19]! & 0xf;
  const code =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

// Accepts ±1 time-step window to tolerate clock drift
export async function verifyTOTP(secret: string, token: string): Promise<boolean> {
  if (!/^\d{6}$/.test(token)) return false;
  const keyBytes = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let i = -1; i <= 1; i++) {
    if (await hotp(keyBytes, counter + i) === token) return true;
  }
  return false;
}

export function makeTOTPUri(secret: string, issuer: string, account: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function hashBackupCode(code: string): Promise<string> {
  const normalized = code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized)));
}

// 8 codes, each 5 bytes (40 bits) → 8 base32 chars displayed as XXXX-XXXX
export async function generateBackupCodes(): Promise<{ plain: string[]; hashed: string[] }> {
  const plain: string[] = [];
  for (let i = 0; i < 8; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    const encoded = base32Encode(bytes);
    plain.push(`${encoded.slice(0, 4)}-${encoded.slice(4, 8)}`);
  }
  const hashed = await Promise.all(plain.map(hashBackupCode));
  return { plain, hashed };
}

// Returns index in hashedCodes array, or -1 if not found
export async function verifyBackupCode(inputCode: string, hashedCodes: string[]): Promise<number> {
  const h = await hashBackupCode(inputCode);
  return hashedCodes.findIndex(c => c === h);
}
