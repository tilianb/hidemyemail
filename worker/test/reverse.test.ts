import { expect, test } from "vitest";
import { reverseAddress, parseReverse } from "../src/lib/reverse";

test("reverseAddress encodes alias + external sender (addy style)", () => {
  expect(reverseAddress("shop", "alice@store.com", "hidemyemail.dev"))
    .toBe("shop+alice=store.com@hidemyemail.dev");
});

test("parseReverse decodes alias + external sender", () => {
  expect(parseReverse("shop+alice=store.com")).toEqual({ aliasLocal: "shop", externalSender: "alice@store.com" });
  expect(parseReverse("shop")).toBeNull();          // plain inbound, no '+'
  expect(parseReverse("shop+tag")).toBeNull();      // plus-addressing, no '='
  expect(parseReverse("r.abcd")).toBeNull();        // old r.TOKEN format gone
});

test("round-trips a sender whose local part contains + and =", () => {
  const addr = reverseAddress("shop", "a+b=c@store.com", "d.com");
  const local = addr.slice(0, addr.lastIndexOf("@"));
  expect(parseReverse(local)).toEqual({ aliasLocal: "shop", externalSender: "a+b=c@store.com" });
});
