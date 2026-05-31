import { globMatch } from "./glob";

export function isBlocked(rules: { pattern: string }[], sender: string): boolean {
  return rules.some((r) => globMatch(r.pattern, sender));
}

export type SenderRule = { pattern: string; kind?: string | null };

/**
 * Resolve a set of in-scope sender rules (alias + subdomain + user-wide) into a
 * single decision for one sender:
 *  - any matching 'block' rule rejects (deny wins, evaluated first);
 *  - if any 'allow' rule is in scope, the sender must match one of them
 *    (allowlist mode → default-deny);
 *  - otherwise the sender is allowed.
 * Rules with no/unknown kind are treated as 'block' for backward compatibility.
 */
export function evaluateSenderRules(rules: SenderRule[], sender: string): "allow" | "block" {
  const denies = rules.filter((r) => (r.kind ?? "block") === "block");
  if (denies.some((r) => globMatch(r.pattern, sender))) return "block";

  const allows = rules.filter((r) => r.kind === "allow");
  if (allows.length > 0 && !allows.some((r) => globMatch(r.pattern, sender))) return "block";

  return "allow";
}
