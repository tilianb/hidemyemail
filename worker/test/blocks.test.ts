import { expect, test } from "vitest";
import { globMatch } from "../src/lib/glob";
import { evaluateSenderRules } from "../src/lib/blocks";

test("glob: wildcard and exact", () => {
  expect(globMatch("*@spam.com", "a@spam.com")).toBe(true);
  expect(globMatch("*@spam.com", "a@ok.com")).toBe(false);
  expect(globMatch("Boss@X.com", "boss@x.com")).toBe(true);
});

test("evaluateSenderRules: no rules → allow", () => {
  expect(evaluateSenderRules([], "anyone@x.com")).toBe("allow");
});

test("evaluateSenderRules: block rule wins, missing kind treated as block", () => {
  const rules = [{ pattern: "*@spam.com", kind: "block" }, { pattern: "evil@x.com" }];
  expect(evaluateSenderRules(rules, "bot@spam.com")).toBe("block");
  expect(evaluateSenderRules(rules, "evil@x.com")).toBe("block");
  expect(evaluateSenderRules(rules, "friend@x.com")).toBe("allow");
});

test("evaluateSenderRules: allow rule enables allowlist (default-deny)", () => {
  const rules = [{ pattern: "bank@trusted.com", kind: "allow" }];
  expect(evaluateSenderRules(rules, "bank@trusted.com")).toBe("allow");
  expect(evaluateSenderRules(rules, "anyone@else.com")).toBe("block");
});

test("evaluateSenderRules: block overrides allow for the same sender", () => {
  const rules = [
    { pattern: "*@trusted.com", kind: "allow" },
    { pattern: "spammer@trusted.com", kind: "block" },
  ];
  expect(evaluateSenderRules(rules, "ok@trusted.com")).toBe("allow");
  expect(evaluateSenderRules(rules, "spammer@trusted.com")).toBe("block");
  expect(evaluateSenderRules(rules, "outsider@other.com")).toBe("block");
});

test("evaluateSenderRules: deny is cumulative across scopes", () => {
  // A user-wide block must still apply even when a narrower alias rule exists,
  // so adding an alias-scoped rule can never silently drop a broad block.
  const rules = [
    { pattern: "*@spam.com", kind: "block", alias_id: null, domain_id: null }, // user-wide
    { pattern: "ads@x.com", kind: "block", alias_id: 7 },                       // alias-scoped
  ];
  expect(evaluateSenderRules(rules, "bot@spam.com")).toBe("block"); // user-wide still wins
  expect(evaluateSenderRules(rules, "ads@x.com")).toBe("block");
  expect(evaluateSenderRules(rules, "friend@x.com")).toBe("allow");
});

test("evaluateSenderRules: alias-scoped allow takes precedence over user-wide allow", () => {
  // A user-wide allow would otherwise lock every alias into allowlist mode.
  // The most-specific allow scope governs, so the alias allow alone applies.
  const rules = [
    { pattern: "friend@a.com", kind: "allow", alias_id: null, domain_id: null }, // user-wide
    { pattern: "colleague@b.com", kind: "allow", alias_id: 7 },                   // alias-scoped
  ];
  expect(evaluateSenderRules(rules, "colleague@b.com")).toBe("allow");
  expect(evaluateSenderRules(rules, "friend@a.com")).toBe("block"); // diluted out by narrower scope
  expect(evaluateSenderRules(rules, "stranger@c.com")).toBe("block");
});

test("evaluateSenderRules: user-wide allow only governs aliases with no narrower allow", () => {
  const rules = [{ pattern: "friend@a.com", kind: "allow", alias_id: null, domain_id: null }];
  expect(evaluateSenderRules(rules, "friend@a.com")).toBe("allow");
  expect(evaluateSenderRules(rules, "stranger@c.com")).toBe("block");
});
