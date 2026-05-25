import { expect, test } from "vitest";
import { globMatch } from "../src/lib/glob";
import { isBlocked } from "../src/lib/blocks";

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
