import { globMatch } from "./glob";

export type SenderRule = {
  pattern: string;
  kind?: string | null;
  // Scope of the rule. alias_id wins over domain_id wins over user-wide.
  alias_id?: number | null;
  domain_id?: number | null;
};

// Specificity rank: alias (2) > subdomain (1) > user-wide (0).
function ruleScope(r: SenderRule): 0 | 1 | 2 {
  if (r.alias_id != null) return 2;
  if (r.domain_id != null) return 1;
  return 0;
}

/**
 * Resolve a set of in-scope sender rules (alias + subdomain + user-wide) into a
 * single decision for one sender, respecting scope precedence:
 *
 *  - DENY is cumulative: a matching 'block' rule at ANY scope rejects, so a
 *    user-wide block is never silently dropped when a narrower rule exists.
 *  - ALLOWLIST is scoped: allowlist mode (default-deny for non-matching senders)
 *    is decided at the MOST SPECIFIC scope that defines any 'allow' rule. An
 *    alias-level allow therefore governs that alias alone and is not diluted by
 *    a broader user-wide allow; conversely a user-wide allow only locks down
 *    aliases that have no narrower allow of their own.
 *  - Rules with no/unknown kind are treated as 'block' for safety.
 */
export function evaluateSenderRules(rules: SenderRule[], sender: string): "allow" | "block" {
  if (rules.length === 0) return "allow";

  // Deny wins, evaluated across every scope.
  const denies = rules.filter((r) => (r.kind ?? "block") === "block");
  if (denies.some((r) => globMatch(r.pattern, sender))) return "block";

  // Allowlist is evaluated only at the most-specific scope that has allow rules.
  const allows = rules.filter((r) => r.kind === "allow");
  if (allows.length === 0) return "allow";
  const allowScope = Math.max(...allows.map(ruleScope));
  const scopedAllows = allows.filter((r) => ruleScope(r) === allowScope);
  if (!scopedAllows.some((r) => globMatch(r.pattern, sender))) return "block";

  return "allow";
}
