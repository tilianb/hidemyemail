// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ configure: vi.fn(), domains: vi.fn(async () => ({ domains: ["one.example"], defaultDomain: "one.example" })), writeText: vi.fn(), send: vi.fn() }));
vi.mock("../src/api", () => ({ ApiError: class extends Error {}, isValidDomain: (value: unknown) => typeof value === "string" && value.includes("."), createApi: () => ({ probe: vi.fn(), domains: mocks.domains }) }));
vi.mock("../src/config", () => ({ ConfigError: class extends Error {}, chromePlatform: {}, configure: mocks.configure, initializeConfig: vi.fn(async () => ({ ok: true, config: { server: "https://mail.example", key: "hme_key" } })) }));

const alias = (id: string, active = true) => ({ id, email: `alias${id}@one.example`, active, description: id === "1" ? "Shopping" : null, domain: "one.example", local_part: `alias${id}` });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

async function loadPopup() {
  document.body.innerHTML = `<main><span id="server-label"></span><button id="settings" hidden>Change</button>
  <section id="setup"><form id="setup-form"><input id="server"><input id="key"><button id="connect">Connect</button></form></section>
  <section id="app" hidden><div role="tablist"><button id="tab-create" role="tab" aria-controls="panel-create" aria-selected="true" tabindex="0">Create</button><button id="tab-aliases" role="tab" aria-controls="panel-aliases" aria-selected="false" tabindex="-1">Aliases</button></div>
  <section id="panel-create" role="tabpanel"><select id="domain"></select><button id="customize" aria-expanded="false">Customize</button><div id="custom-controls" hidden><select id="format"><option value="random_characters">Random</option><option value="uuid">UUID</option><option value="custom">Custom</option></select><label id="local-label" hidden>Local part<input id="local-part"></label><input id="description"></div><button id="generate">Generate alias</button><div id="result" hidden><span id="alias"></span><button id="copy">Copy</button></div><p id="create-status"></p></section>
  <section id="panel-aliases" role="tabpanel" hidden><form id="search-form"><input id="search"><button>Search</button></form><div id="list-state"></div><ul id="alias-list"></ul><button id="retry" hidden>Retry</button></section></section><p id="status"></p></main>`;
  globalThis.Option = function (text = "", value = "", _d = false, selected = false) { const option = document.createElement("option"); option.text = text; option.value = value; option.selected = selected; return option; } as unknown as typeof Option;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.writeText } });
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { runtime: { sendMessage: mocks.send } } });
  await import("../src/popup");
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#app")!.hidden).toBe(false));
}

beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); mocks.domains.mockResolvedValue({ domains: ["one.example"], defaultDomain: "one.example" }); mocks.send.mockResolvedValue({ ok: true, aliases: [alias("1")] }); });

test("tabs implement keyboard semantics and load aliases", async () => {
  await loadPopup(); const create = document.querySelector<HTMLButtonElement>("#tab-create")!; const aliases = document.querySelector<HTMLButtonElement>("#tab-aliases")!;
  create.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await vi.waitFor(() => expect(aliases.getAttribute("aria-selected")).toBe("true"));
  expect(document.querySelector<HTMLElement>("#panel-create")!.hidden).toBe(true);
  expect(mocks.send).toHaveBeenCalledWith({ type: "hme:aliases:list" });
  await vi.waitFor(() => expect(document.querySelector("#alias-list")!.textContent).toContain("alias1@one.example"));
});

test("custom controls submit a rich create payload and refresh inventory", async () => {
  mocks.send.mockResolvedValueOnce({ ok: true, alias: alias("2") }).mockResolvedValueOnce({ ok: true, aliases: [alias("2")] });
  await loadPopup(); document.querySelector<HTMLButtonElement>("#customize")!.click();
  const format = document.querySelector<HTMLSelectElement>("#format")!; format.value = "custom"; format.dispatchEvent(new Event("change"));
  expect(document.querySelector<HTMLElement>("#local-label")!.hidden).toBe(false);
  document.querySelector<HTMLInputElement>("#local-part")!.value = "orders"; document.querySelector<HTMLInputElement>("#description")!.value = "Orders";
  document.querySelector<HTMLButtonElement>("#generate")!.click();
  await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith({ type: "hme:aliases:create", input: { domain: "one.example", format: "custom", local_part: "orders", description: "Orders" } }));
  await vi.waitFor(() => expect(document.querySelector("#alias")!.textContent).toBe("alias2@one.example"));
  expect(mocks.send).toHaveBeenCalledWith({ type: "hme:aliases:list" });
});

test("invalid custom local part leaves no loading message and keeps controls unlocked", async () => {
  await loadPopup(); document.querySelector<HTMLButtonElement>("#customize")!.click();
  const format = document.querySelector<HTMLSelectElement>("#format")!; format.value = "custom"; format.dispatchEvent(new Event("change"));
  const localPart = document.querySelector<HTMLInputElement>("#local-part")!;
  const reportValidity = vi.spyOn(localPart, "reportValidity");

  document.querySelector<HTMLButtonElement>("#generate")!.click();

  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#generate")!.disabled).toBe(false));
  expect(reportValidity).toHaveBeenCalledOnce();
  expect(document.querySelector("#create-status")!.textContent).toBe("");
  expect(document.querySelector<HTMLSelectElement>("#domain")!.disabled).toBe(false);
  expect(mocks.send).not.toHaveBeenCalled();
});

test("search ignores stale responses and supports error retry", async () => {
  const old = deferred<unknown>(); mocks.send.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ok: true, aliases: [alias("2")] });
  await loadPopup(); document.querySelector<HTMLButtonElement>("#tab-aliases")!.click();
  const search = document.querySelector<HTMLInputElement>("#search")!; search.value = "new"; document.querySelector<HTMLFormElement>("#search-form")!.requestSubmit();
  await vi.waitFor(() => expect(document.querySelector("#alias-list")!.textContent).toContain("alias2"));
  old.resolve({ ok: true, aliases: [alias("1")] }); await Promise.resolve();
  expect(document.querySelector("#alias-list")!.textContent).not.toContain("alias1");
  mocks.send.mockResolvedValueOnce({ ok: false, error: "Safe error." }); document.querySelector<HTMLButtonElement>("#retry")!.click();
  await vi.waitFor(() => expect(document.querySelector("#list-state")!.textContent).toBe("HideMyEmail could not complete the request. Try again."));
  expect(document.querySelector<HTMLButtonElement>("#retry")!.hidden).toBe(false);
});

test("row copy, state action, and inline delete confirmation are independently locked", async () => {
  await loadPopup(); document.querySelector<HTMLButtonElement>("#tab-aliases")!.click(); await vi.waitFor(() => expect(document.querySelector("#alias-list")!.textContent).toContain("alias1"));
  document.querySelector<HTMLButtonElement>("[data-action=copy]")!.click(); expect(mocks.writeText).toHaveBeenCalledWith("alias1@one.example");
  const pending = deferred<unknown>(); mocks.send.mockReturnValueOnce(pending.promise); const state = document.querySelector<HTMLButtonElement>("[data-action=state]")!; state.click(); state.click();
  expect(mocks.send).toHaveBeenCalledTimes(2); // initial list + one action
  expect(document.querySelector<HTMLButtonElement>("[data-action=delete]")!.disabled).toBe(true);
  pending.resolve({ ok: true });
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("[data-action=delete]")!.disabled).toBe(false));
  document.querySelector<HTMLButtonElement>("[data-action=delete]")!.click();
  expect(document.querySelector("#alias-list")!.textContent).toContain("Delete alias1@one.example?");
  document.querySelector<HTMLButtonElement>("[data-action=cancel-delete]")!.click(); expect(document.querySelector("[data-action=confirm-delete]")).toBeNull();
});

test("shows empty state and redacts malformed privileged responses", async () => {
  mocks.send.mockResolvedValueOnce({ ok: true, aliases: [] }); await loadPopup(); document.querySelector<HTMLButtonElement>("#tab-aliases")!.click();
  await vi.waitFor(() => expect(document.querySelector("#list-state")!.textContent).toContain("No aliases"));
  mocks.send.mockResolvedValueOnce({ ok: false, error: "hme_secret https://private.example" }); document.querySelector<HTMLButtonElement>("#retry")!.click();
  await vi.waitFor(() => expect(document.querySelector("#list-state")!.textContent).toContain("could not complete"));
  expect(document.body.textContent).not.toMatch(/hme_secret|private\.example/);
});

test("accepts an overlong description in a privileged alias response", async () => {
  const { popupRequest } = await import("../src/popup-client");
  const overlong = { ...alias("1"), description: "x".repeat(256) };
  mocks.send.mockResolvedValueOnce({ ok: true, aliases: [overlong] });

  await expect(popupRequest({ type: "hme:aliases:list" })).resolves.toEqual({ aliases: [overlong] });
  mocks.send.mockResolvedValueOnce({ ok: true, alias: overlong });
  await expect(popupRequest({ type: "hme:aliases:create", input: { domain: "one.example", format: "random_characters" } })).resolves.toEqual({ alias: overlong });
});

test("Change clears aliases and stale list responses cannot restore them", async () => {
  const stale = deferred<unknown>(); mocks.send.mockReturnValueOnce(stale.promise);
  await loadPopup(); document.querySelector<HTMLButtonElement>("#tab-aliases")!.click();
  document.querySelector<HTMLButtonElement>("#settings")!.click();
  expect(document.querySelector("#alias-list")!.textContent).toBe("");
  expect(document.querySelector("#list-state")!.textContent).toBe("");
  stale.resolve({ ok: true, aliases: [alias("1")] }); await Promise.resolve(); await Promise.resolve();
  expect(document.querySelector("#alias-list")!.textContent).toBe("");
});

test("Change is disabled and ignored during a pending delete", async () => {
  await loadPopup(); document.querySelector<HTMLButtonElement>("#tab-aliases")!.click(); await vi.waitFor(() => expect(document.querySelector("#alias-list")!.textContent).toContain("alias1"));
  document.querySelector<HTMLButtonElement>("[data-action=delete]")!.click();
  const pending = deferred<unknown>(); mocks.send.mockReturnValueOnce(pending.promise);
  document.querySelector<HTMLButtonElement>("[data-action=confirm-delete]")!.click();
  const settings = document.querySelector<HTMLButtonElement>("#settings")!;
  expect(settings.disabled).toBe(true); settings.click(); expect(document.querySelector<HTMLElement>("#setup")!.hidden).toBe(true);
  pending.resolve({ ok: true });
  await vi.waitFor(() => expect(settings.disabled).toBe(false));
});

test("a new connection opens Create without old alias actions", async () => {
  await loadPopup(); document.querySelector<HTMLButtonElement>("#tab-aliases")!.click(); await vi.waitFor(() => expect(document.querySelector("#alias-list")!.textContent).toContain("alias1"));
  document.querySelector<HTMLButtonElement>("#settings")!.click();
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#connect")!.disabled).toBe(false));
  mocks.configure.mockResolvedValueOnce({ server: "https://new.example", key: "new_key" });
  document.querySelector<HTMLFormElement>("#setup-form")!.requestSubmit();
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#app")!.hidden).toBe(false));
  expect(document.querySelector("#tab-create")!.getAttribute("aria-selected")).toBe("true");
  expect(document.querySelector("#alias-list")!.textContent).toBe("");
});

test("startup failure preserves the saved self-host origin in setup", async () => {
  mocks.domains.mockRejectedValueOnce(new Error("offline"));
  await loadPopup().catch(() => undefined);

  await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#setup")!.hidden).toBe(false));
  expect(document.querySelector<HTMLInputElement>("#server")!.value).toBe("https://mail.example");
});
