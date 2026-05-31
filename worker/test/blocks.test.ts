import { expect, test } from "vitest";
import { globMatch } from "../src/lib/glob";
import { isBlocked, evaluateSenderRules } from "../src/lib/blocks";

test("glob: wildcard and exact", () => {
  expect(globMatch("*@spam.com", "a@spam.com")).toBe(true);
  expect(globMatch("*@spam.com", "a@ok.com")).toBe(false);
  expect(globMatch("Boss@X.com", "boss@x.com")).toBe(true);
});

test("isBlocked: any rule matches", () => {
  const rules = [{ pattern: "*@spam.com" }, { pattern: "evil@x.com" }];
  expect(isBlocked(rules, "anyone@spam.com")).toBe(true);
  expect(isBlocked(rules, "evil@x.com")).toBe(true);
  expect(isBlocked(rules, "friend@x.com")).toBe(false);
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
