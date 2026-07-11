// Alias local-part validation and generation, shared by the dashboard route
// (api/routes/aliases.ts) and the addy.io-compatible API (api/routes/v1.ts).

/** Validate an email local part (RFC 5321 safe subset). */
export function isValidLocalPart(s: string): boolean {
  if (!s || s.length > 64) return false;
  // Allow lowercase alphanumeric, dots, hyphens; no leading/trailing dot/hyphen, no consecutive dots
  return /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(s) && !s.includes("..");
}

/** 8 random [a-z0-9] characters — the generated-alias local part. */
export function randomLocalPart(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((x) => chars[x % chars.length]).join("");
}

/**
 * Escape %, _ and \ in user input destined for a LIKE pattern, so wildcard
 * characters match literally. Use with `LIKE ? ESCAPE '\\'`.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => "\\" + ch);
}
