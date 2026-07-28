// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { fillField, mountContent, requestAliasOnClick, unmountContent } from "../src/content";

const SAFE_ERROR = "HideMyEmail could not complete the request. Try again.";
const originalInnerWidth = innerWidth;
const originalInnerHeight = innerHeight;

afterEach(() => {
  document.documentElement.querySelectorAll<HTMLDivElement>("[data-hme-extension]").forEach(unmountContent);
  document.body.replaceChildren();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
  vi.restoreAllMocks();
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function mounted(send = vi.fn(async () => ({ ok: true as const, domains: ["one.example"], defaultDomain: "one.example" }))) {
  const input = document.createElement("input"); input.type = "email";
  vi.spyOn(input, "getBoundingClientRect").mockReturnValue(rect(100, 100, 250, 40));
  document.body.append(input);
  const host = mountContent(send, "open");
  input.focus();
  await vi.waitFor(() => expect(host.hidden).toBe(false));
  return { input, host, shadow: host.shadowRoot!, send };
}

test("generation and filling occur only after an explicit click", async () => {
  const input = document.createElement("input"); input.type = "email"; vi.spyOn(input, "getBoundingClientRect").mockReturnValue(rect(10, 10, 200, 30)); document.body.append(input);
  const send = vi.fn(async () => ({ ok: true as const, alias: "new@one.example" }));
  const events: string[] = [];
  input.addEventListener("input", () => events.push("input")); input.addEventListener("change", () => events.push("change"));
  const button = document.createElement("button");
  requestAliasOnClick(button, input, "one.example", send);
  expect(send).not.toHaveBeenCalled(); expect(input.value).toBe("");
  button.click();
  await vi.waitFor(() => expect(input.value).toBe("new@one.example"));
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: "hme:generate", domain: "one.example" });
  expect(events).toEqual(["input", "change"]);
});

test("native setter fill dispatches bubbling input and change events", () => {
  const input = document.createElement("input"); document.body.append(input);
  const bubbled: string[] = []; document.body.addEventListener("input", () => bubbled.push("input")); document.body.addEventListener("change", () => bubbled.push("change"));
  fillField(input, "safe@example.com");
  expect(input.value).toBe("safe@example.com"); expect(bubbled).toEqual(["input", "change"]);
});

test.each([
  () => Promise.reject(new Error("secret server page-value")),
  () => Promise.resolve({ ok: false, error: "secret server page-value" }),
  () => Promise.resolve({ ok: true, alias: 42 }),
])("keeps the chooser open and shows a fixed safe error for failed or invalid generation", async (generate) => {
  const send = vi.fn()
    .mockResolvedValueOnce({ ok: true, domains: ["one.example"], defaultDomain: "one.example" })
    .mockImplementationOnce(generate);
  const { input, shadow } = await mounted(send);
  shadow.querySelector<HTMLButtonElement>(".trigger")!.click();
  await vi.waitFor(() => expect(shadow.querySelector("select")).not.toBeNull());
  shadow.querySelector<HTMLButtonElement>(".panel button")!.click();
  await vi.waitFor(() => expect(shadow.querySelector(".status")?.textContent).toBe(SAFE_ERROR));
  expect(shadow.querySelector(".panel")).not.toBeNull();
  expect(input.value).toBe("");
});

test("fills through native events, restores target focus, then removes the chooser on validated success", async () => {
  const send = vi.fn()
    .mockResolvedValueOnce({ ok: true, domains: ["one.example"], defaultDomain: "one.example" })
    .mockResolvedValueOnce({ ok: true, alias: "new@one.example" });
  const { input, shadow } = await mounted(send);
  const events: string[] = [];
  input.addEventListener("input", () => events.push("input")); input.addEventListener("change", () => events.push("change"));
  shadow.querySelector<HTMLButtonElement>(".trigger")!.click();
  await vi.waitFor(() => expect(shadow.querySelector("select")).not.toBeNull());
  shadow.querySelector<HTMLButtonElement>(".panel button")!.click();
  await vi.waitFor(() => expect(shadow.querySelector(".panel")).toBeNull());
  expect(input.value).toBe("new@one.example"); expect(events).toEqual(["input", "change"]); expect(document.activeElement).toBe(input);
});

test("validates generation against the domain selected in the mounted chooser", async () => {
  const send = vi.fn()
    .mockResolvedValueOnce({ ok: true, domains: ["one.example", "two.example"], defaultDomain: "one.example" })
    .mockResolvedValueOnce({ ok: true, alias: "new@two.example" });
  const { input, shadow } = await mounted(send);
  shadow.querySelector<HTMLButtonElement>(".trigger")!.click();
  await vi.waitFor(() => expect(shadow.querySelector("select")).not.toBeNull());
  shadow.querySelector<HTMLSelectElement>("select")!.value = "two.example";
  shadow.querySelector<HTMLButtonElement>(".panel button")!.click();
  await vi.waitFor(() => expect(input.value).toBe("new@two.example"));
});

test("a generation response cannot fill after its chooser closes", async () => {
  const pending = deferred<unknown>();
  const send = vi.fn()
    .mockResolvedValueOnce({ ok: true, domains: ["one.example"], defaultDomain: "one.example" })
    .mockReturnValueOnce(pending.promise);
  const { input, shadow } = await mounted(send);
  shadow.querySelector<HTMLButtonElement>(".trigger")!.click();
  await vi.waitFor(() => expect(shadow.querySelector("select")).not.toBeNull());
  shadow.querySelector<HTMLButtonElement>(".panel button")!.click();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  pending.resolve({ ok: true, alias: "stale@one.example" });
  await Promise.resolve(); await Promise.resolve();
  expect(input.value).toBe("");
});

test("a generation response cannot fill either field after retargeting", async () => {
  const pending = deferred<unknown>();
  const send = vi.fn()
    .mockResolvedValueOnce({ ok: true, domains: ["one.example"], defaultDomain: "one.example" })
    .mockReturnValueOnce(pending.promise);
  const { input: first, shadow } = await mounted(send);
  const second = visibleEmailInput();
  shadow.querySelector<HTMLButtonElement>(".trigger")!.click();
  await vi.waitFor(() => expect(shadow.querySelector("select")).not.toBeNull());
  shadow.querySelector<HTMLButtonElement>(".panel button")!.click();
  second.focus();

  pending.resolve({ ok: true, alias: "stale@one.example" });
  await Promise.resolve(); await Promise.resolve();
  expect(first.value).toBe(""); expect(second.value).toBe("");
});

test("an out-of-order domain response cannot populate a reopened chooser", async () => {
  const old = deferred<unknown>(); const current = deferred<unknown>();
  const send = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const { shadow } = await mounted(send);
  const trigger = shadow.querySelector<HTMLButtonElement>(".trigger")!;
  trigger.click();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  trigger.click();
  old.resolve({ ok: true, domains: ["old.example"], defaultDomain: "old.example" });
  await Promise.resolve(); await Promise.resolve();
  expect(shadow.querySelector("select")).toBeNull();

  current.resolve({ ok: true, domains: ["new.example"], defaultDomain: "new.example" });
  await vi.waitFor(() => expect(shadow.querySelector<HTMLSelectElement>("select")?.value).toBe("new.example"));
  expect(shadow.querySelector<HTMLSelectElement>("select")?.value).toBe("new.example");
});

test.each(["Escape", "outside"])("closes on %s and restores focus to the target", async (action) => {
  const { input, shadow } = await mounted();
  shadow.querySelector<HTMLButtonElement>(".trigger")!.click();
  await vi.waitFor(() => expect(shadow.querySelector(".panel")).not.toBeNull());
  if (action === "Escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  else document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(shadow.querySelector(".panel")).toBeNull(); expect(document.activeElement).toBe(input);
});

test("clamps the trigger and 230px chooser to the viewport and chooses the side with space", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 240 });
  const { input, host, shadow } = await mounted();
  vi.mocked(input.getBoundingClientRect).mockReturnValue(rect(290, 210, 80, 30));
  window.dispatchEvent(new Event("resize"));
  await vi.waitFor(() => expect(host.style.left).toBe("292px"));
  expect(host.style.top).toBe("211px");
  shadow.querySelector<HTMLButtonElement>(".trigger")!.click();
  await vi.waitFor(() => expect(shadow.querySelector<HTMLElement>(".panel")?.style.top).toBe("14px"));
  const panel = shadow.querySelector<HTMLElement>(".panel")!;
  expect(panel.style.left).toBe("90px"); expect(getComputedStyle(panel).width).toBe("230px");
});

test("uses the trailing edge when no other autofill control is present", async () => {
  const { host } = await mounted();

  await vi.waitFor(() => expect(host.style.left).toBe("322px"));
});

test("moves left of 1Password and Bitwarden-style inline controls without changing them", async () => {
  const onePassword = document.createElement("com-1password-button");
  vi.spyOn(onePassword, "getBoundingClientRect").mockReturnValue(rect(322, 106, 28, 28));
  document.body.append(onePassword);
  const bitwarden = document.createElement("bw-random-host"); bitwarden.setAttribute("popover", "manual");
  vi.spyOn(bitwarden, "getBoundingClientRect").mockReturnValue(rect(322, 106, 28, 28));
  document.body.append(bitwarden);

  const { host } = await mounted();

  await vi.waitFor(() => expect(host.style.left).toBe("288px"));
  expect(onePassword.isConnected).toBe(true);
  expect(bitwarden.isConnected).toBe(true);
  expect(onePassword.getAttribute("style")).toBeNull();
  expect(bitwarden.getAttribute("style")).toBeNull();
});

test("moves dynamically for late closed-shadow autofill UI with mismatched host geometry", async () => {
  vi.useFakeTimers();
  const shadowHost = document.createElement("password-manager-root");
  vi.spyOn(shadowHost, "getBoundingClientRect").mockReturnValue(rect(0, 0, 0, 0));
  const elementsFromPoint = vi.fn<(x: number, y: number) => Element[]>(() => []);
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: elementsFromPoint });
  try {
    const { host } = await mounted();
    expect(host.style.left).toBe("322px");

    elementsFromPoint.mockImplementation((x) => x >= 322 ? [host, shadowHost] : [host]);
    await vi.advanceTimersByTimeAsync(120);

    expect(host.style.left).toBe("288px");
  } finally {
    Reflect.deleteProperty(document, "elementsFromPoint");
    vi.useRealTimers();
  }
});

test("hides the trigger when a narrow field has no non-overlapping icon lane", async () => {
  const overlay = document.createElement("com-1password-button");
  vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue(rect(122, 106, 28, 28));
  document.body.append(overlay);
  const input = document.createElement("input"); input.type = "email";
  vi.spyOn(input, "getBoundingClientRect").mockReturnValue(rect(100, 100, 50, 40));
  document.body.append(input);
  const host = mountContent(vi.fn(), "open");

  input.focus();

  await vi.waitFor(() => expect(host.hidden).toBe(true));
  expect(overlay.isConnected).toBe(true);
});

test.each(["type", "class", "style", "detached"])("hides mounted controls when the target becomes ineligible via %s", async (change) => {
  vi.useFakeTimers();
  const { input, host } = await mounted();
  if (change === "type") input.type = "password";
  else if (change === "class") { vi.mocked(input.getBoundingClientRect).mockReturnValue(rect(0, 0, 0, 0)); input.className = "hidden"; }
  else if (change === "style") input.style.display = "none";
  else input.remove();
  await vi.runAllTimersAsync();
  expect(host.hidden).toBe(true);
  vi.useRealTimers();
});

test("does not schedule mutation timers or animation frames without an active target", async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(window, "setTimeout");
  const frame = vi.spyOn(window, "requestAnimationFrame");
  mountContent(vi.fn(), "open");
  document.body.append(document.createElement("div"));
  await Promise.resolve();
  expect(timeout).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("resize"));
  expect(frame).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test("uses the first eligible input in a page-owned open shadow root focus path", async () => {
  const pageHost = document.createElement("div");
  const pageShadow = pageHost.attachShadow({ mode: "open" });
  const input = document.createElement("input"); input.type = "email";
  vi.spyOn(input, "getBoundingClientRect").mockReturnValue(rect(10, 10, 200, 30));
  pageShadow.append(input); document.body.append(pageHost);
  const extensionHost = mountContent(vi.fn(), "open");
  const owned = document.createElement("input"); owned.type = "email";
  vi.spyOn(owned, "getBoundingClientRect").mockReturnValue(rect(10, 10, 200, 30));
  extensionHost.shadowRoot!.append(owned);
  const ownedFocus = new FocusEvent("focusin", { bubbles: true, composed: true });
  Object.defineProperty(ownedFocus, "composedPath", { value: () => [owned, extensionHost.shadowRoot!, extensionHost, document.documentElement, document, window] });
  extensionHost.dispatchEvent(ownedFocus);
  expect(extensionHost.hidden).toBe(true);

  const focus = new FocusEvent("focusin", { bubbles: true, composed: true });
  Object.defineProperty(focus, "composedPath", { value: () => [input, pageShadow, pageHost, document.body, document.documentElement, document, window] });
  pageHost.dispatchEvent(focus);

  await vi.waitFor(() => expect(extensionHost.hidden).toBe(false));
});

test("observes attributes only while a target is active and reverts after it closes", async () => {
  const observe = vi.spyOn(MutationObserver.prototype, "observe");
  const host = mountContent(vi.fn(), "open");
  expect(observe).toHaveBeenLastCalledWith(document.documentElement, { childList: true });

  const input = visibleEmailInput(); input.focus();
  expect(observe).toHaveBeenLastCalledWith(document.documentElement, expect.objectContaining({ attributes: true, childList: true, subtree: true }));

  document.body.focus();
  document.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  expect(host.hidden).toBe(true);
  expect(observe).toHaveBeenLastCalledWith(document.documentElement, { childList: true });
});

test("ignores extension-owned style mutations but reacts to target style mutations", async () => {
  const { input, host, shadow } = await mounted();
  await vi.waitFor(() => expect(host.style.left).not.toBe(""));
  shadow.querySelector<HTMLButtonElement>(".trigger")!.click();
  await vi.waitFor(() => expect(shadow.querySelector<HTMLElement>(".panel")?.style.left).not.toBe(""));
  const panel = shadow.querySelector<HTMLElement>(".panel")!;
  const timeout = vi.spyOn(window, "setTimeout");

  host.style.left = "1px";
  panel.style.left = "2px";
  await Promise.resolve();
  expect(timeout).not.toHaveBeenCalled();

  input.style.color = "red";
  await vi.waitFor(() => expect(timeout).toHaveBeenCalledOnce());
});

test("reattaches a removed host without scheduling work until a target is focused", async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(window, "setTimeout");
  const frame = vi.spyOn(window, "requestAnimationFrame");
  const host = mountContent(vi.fn(), "open");

  host.remove();
  document.body.append(document.createElement("div"));
  await Promise.resolve();

  expect(host.isConnected).toBe(true);
  expect(timeout).not.toHaveBeenCalled();
  expect(frame).not.toHaveBeenCalled();

  const input = visibleEmailInput();
  input.focus();
  expect(host.hidden).toBe(false);
  expect(frame).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

test("reattaches a removed host and teardown prevents listener and observer leaks", async () => {
  const first = mountContent(vi.fn(), "open");
  const active = visibleEmailInput();
  active.focus();
  first.remove();
  document.body.append(document.createElement("div"));
  await vi.waitFor(() => expect(first.isConnected).toBe(true));

  unmountContent(first);
  expect(first.isConnected).toBe(false);
  first.hidden = true;
  const input = visibleEmailInput();
  input.focus();
  expect(first.hidden).toBe(true);
  first.remove();
  document.body.append(document.createElement("div"));
  await Promise.resolve();
  expect(first.isConnected).toBe(false);
});

function visibleEmailInput(): HTMLInputElement {
  const input = document.createElement("input"); input.type = "email";
  vi.spyOn(input, "getBoundingClientRect").mockReturnValue(rect(10, 10, 200, 30));
  document.body.append(input);
  return input;
}
