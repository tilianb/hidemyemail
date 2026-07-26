// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAlias: vi.fn(),
  configure: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("../src/api", () => ({
  ApiError: class extends Error {},
  createApi: () => ({
    probe: vi.fn(async () => undefined),
    domains: vi.fn(async () => ({ domains: ["example.com"], defaultDomain: "example.com" })),
    createAlias: mocks.createAlias,
  }),
}));
vi.mock("../src/config", () => ({
  ConfigError: class extends Error {},
  chromePlatform: {},
  configure: mocks.configure,
  initializeConfig: vi.fn(async () => ({ ok: true, config: { server: "https://mail.example", key: "hme_key" } })),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function loadPopup() {
  document.body.innerHTML = `
    <span id="server-label"></span><button id="settings" hidden>Change</button>
    <section id="setup"><form id="setup-form"><input id="server"><input id="key"><button id="connect">Connect</button></form></section>
    <section id="generator" hidden><select id="domain"></select><button id="generate">Generate</button>
      <div id="result" hidden><span id="alias"></span><button id="copy">Copy</button></div></section>
    <p id="status"></p>`;
  globalThis.Option = function (text = "", value = "", _defaultSelected = false, selected = false) {
    const option = document.createElement("option");
    option.text = text; option.value = value; option.selected = selected;
    return option;
  } as unknown as typeof Option;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.writeText } });
  await import("../src/popup");
  await vi.waitFor(() => expect({ disabled: document.querySelector<HTMLButtonElement>("#generate")!.disabled, status: document.querySelector("#status")!.textContent }).toEqual({ disabled: false, status: "Ready" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

test("generation locks Change, connect, copy, and duplicate generation", async () => {
  const pending = deferred<string>();
  mocks.createAlias.mockReturnValueOnce(pending.promise);
  await loadPopup();

  document.querySelector<HTMLButtonElement>("#generate")!.click();
  document.querySelector<HTMLButtonElement>("#generate")!.click();
  document.querySelector<HTMLButtonElement>("#settings")!.click();
  document.querySelector<HTMLButtonElement>("#copy")!.click();
  document.querySelector<HTMLFormElement>("#setup-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

  expect(mocks.createAlias).toHaveBeenCalledOnce();
  expect(mocks.configure).not.toHaveBeenCalled();
  expect(mocks.writeText).not.toHaveBeenCalled();
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, button, select")) {
    expect(control.disabled).toBe(true);
  }

  pending.resolve("alias@example.com");
  await vi.waitFor(() => expect(document.querySelector("#status")!.textContent).toBe("Alias generated"));
  expect(document.querySelector<HTMLButtonElement>("#settings")!.disabled).toBe(false);
  expect(document.querySelector<HTMLButtonElement>("#generate")!.disabled).toBe(false);
  expect(document.querySelector<HTMLButtonElement>("#copy")!.disabled).toBe(false);
  expect(document.querySelector<HTMLInputElement>("#server")!.disabled).toBe(true);
  expect(document.querySelector<HTMLButtonElement>("#connect")!.disabled).toBe(true);
});

test("never displays an untrusted configuration error", async () => {
  await loadPopup();
  document.querySelector<HTMLButtonElement>("#settings")!.click();
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#setup")!.hidden).toBe(false));
  mocks.configure.mockRejectedValueOnce(new Error("chrome hme_secret https://private.example"));

  document.querySelector<HTMLFormElement>("#setup-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

  await vi.waitFor(() => expect(document.querySelector("#status")!.textContent).toBe("Something went wrong. Try again."));
  expect(document.querySelector("#status")!.textContent).not.toMatch(/hme_secret|private\.example|chrome/i);
});
