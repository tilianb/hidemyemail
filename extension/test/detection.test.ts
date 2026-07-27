// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { isEmailField } from "../src/detection";

function visible(input: HTMLInputElement) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
  input.getBoundingClientRect = () => ({ x: 10, y: 10, top: 10, left: 10, right: 210, bottom: 40, width: 200, height: 30, toJSON() {} });
  Object.defineProperty(input, "offsetParent", { configurable: true, value: document.body });
  return input;
}

test.each([
  ["email type", '<input type="email">'],
  ["autocomplete token", '<input type="text" autocomplete="section-login email">'],
  ["name metadata", '<input type="text" name="billing_email_address">'],
  ["associated label", '<label for="account">E-mail address</label><input id="account" type="search">'],
  ["accessible label", '<input type="text" aria-label="Mail address">'],
])("detects %s without inspecting values", (_name, html) => {
  document.body.innerHTML = html;
  const input = visible(document.querySelector("input")!);
  input.value = "private page value";
  expect(isEmailField(input)).toBe(true);
});

test.each([
  '<input type="password" name="email">',
  '<input type="text" name="email" disabled>',
  '<input type="text" name="email" readonly>',
  '<input type="hidden" name="email">',
  '<input type="text" name="username">',
])("rejects excluded field %s", (html) => {
  document.body.innerHTML = html;
  expect(isEmailField(visible(document.querySelector("input")!))).toBe(false);
});

test("rejects invisible, tiny, offscreen, and extension-owned fields", () => {
  const input = document.createElement("input"); input.type = "email"; document.body.append(input);
  input.getBoundingClientRect = () => ({ x: -20, y: 0, top: 0, left: -20, right: -10, bottom: 10, width: 10, height: 10, toJSON() {} });
  expect(isEmailField(input)).toBe(false);
  const host = document.createElement("div"); host.dataset.hmeExtension = "true"; document.body.append(host);
  const owned = host.attachShadow({ mode: "open" }).appendChild(document.createElement("input")); owned.type = "email";
  expect(isEmailField(owned)).toBe(false);
});

test.each([
  ["hidden", "<div hidden><input type=\"email\"></div>"],
  ["inert", "<div inert><input type=\"email\"></div>"],
  ["aria-hidden", "<div aria-hidden=\"true\"><input type=\"email\"></div>"],
  ["ancestor pointer events", "<div style=\"pointer-events: none\"><input type=\"email\"></div>"],
  ["control pointer events", "<input type=\"email\" style=\"pointer-events: none\">"],
])("rejects fields inside %s UI", (_name, html) => {
  document.body.innerHTML = html;
  expect(isEmailField(visible(document.querySelector("input")!))).toBe(false);
});
