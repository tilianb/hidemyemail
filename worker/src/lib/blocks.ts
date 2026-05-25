import { globMatch } from "./glob";

export function isBlocked(rules: { pattern: string }[], sender: string): boolean {
  return rules.some((r) => globMatch(r.pattern, sender));
}
