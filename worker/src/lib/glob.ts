export function globMatch(pattern: string, value: string): boolean {
  // Limit pattern length and collapse consecutive wildcards to prevent ReDoS
  if (pattern.length > 256) return false;
  const p = pattern.toLowerCase().replace(/\*{2,}/g, "*");
  const v = value.toLowerCase();
  const re = new RegExp("^" + p.split("*").map(escapeRe).join(".*") + "$");
  return re.test(v);
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
