/** Mask a secret: show first 3 + "•••" + last 3, or just "•••" if too short */
export function maskSecret(val: string): string {
  if (val.length <= 8) return "•••";
  return `${val.slice(0, 3)}•••${val.slice(-3)}`;
}

export function normalizeDomain(input: string): string | null {
  const domain = input.trim().toLowerCase();
  if (!domain || domain.length > 253 || !domain.includes(".")) return null;
  if (/[\s\r\n/:]/.test(domain)) return null;
  const labels = domain.split(".");
  if (labels.some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-") || !/^[a-z0-9-]+$/.test(label))) {
    return null;
  }
  return domain;
}

export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (!email || email.length > 254 || /[\s\r\n]/.test(email)) return null;
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return null;
  return email;
}
