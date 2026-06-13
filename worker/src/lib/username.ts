// Username validation. A username is a PUBLIC handle: it replaces the
// "User #N" display label and identifies which account to recover. It is never
// a secret and never a login credential, so the only real constraints are
// uniqueness (enforced by the DB index) and being safe to display.

const MIN = 3;
const MAX = 32;

// Charset: letters, digits, underscore, hyphen. No spaces, no leading/trailing
// separator (keeps display tidy and avoids "  " or "--" lookalikes).
const SHAPE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]*[a-zA-Z0-9])?$/;

// Reserved so a user can't impersonate the system or a role address. Compared
// case-insensitively against the normalized (lowercased) value.
const RESERVED = new Set([
  "admin", "administrator", "root", "system", "support", "help",
  "security", "abuse", "postmaster", "noreply", "no-reply", "mailer-daemon",
  "hidemyemail", "null", "undefined", "anonymous", "me",
]);

export interface UsernameResult {
  ok: boolean;
  /** Trimmed, case preserved for display. */
  value?: string;
  error?: string;
}

export function validateUsername(raw: unknown): UsernameResult {
  if (typeof raw !== "string") return { ok: false, error: "Username must be a string" };
  const value = raw.trim();
  if (value.length < MIN) return { ok: false, error: `Username must be at least ${MIN} characters` };
  if (value.length > MAX) return { ok: false, error: `Username must be at most ${MAX} characters` };
  if (!SHAPE.test(value)) {
    return { ok: false, error: "Username may only contain letters, numbers, _ and -, and can't start or end with _ or -" };
  }
  if (RESERVED.has(value.toLowerCase())) return { ok: false, error: "That username is reserved" };
  return { ok: true, value };
}
