import { ApiError, createApi, type AliasFormat } from "./api";
import { chromePlatform, ConfigError, configure, initializeConfig, type ExtensionConfig } from "./config";
import { createInput, popupRequest, SAFE_ERROR } from "./popup-client";
import { activateAliasList, loadAliases, registerAliasList, resetAliasList } from "./popup-list";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const setup = byId<HTMLElement>("setup"), app = byId<HTMLElement>("app"), status = byId<HTMLElement>("status");
const serverInput = byId<HTMLInputElement>("server"), keyInput = byId<HTMLInputElement>("key"), domain = byId<HTMLSelectElement>("domain"), destination = byId<HTMLSelectElement>("destination");
const format = byId<HTMLSelectElement>("format"), customFormat = format.querySelector<HTMLOptionElement>('option[value="custom"]')!, localLabel = byId<HTMLElement>("local-label"), localPart = byId<HTMLInputElement>("local-part");
const settings = byId<HTMLButtonElement>("settings"), generate = byId<HTMLButtonElement>("generate"), result = byId<HTMLElement>("result");
let current: ExtensionConfig | null = null, busy = true, mutationPending = false, permanentlyLocked = false, destinationsAvailable = false, customAliasDomains = new Set<string>(), actionId = 0;

function message(text = "", kind: "error" | "success" | "" = "") { status.textContent = text; status.className = kind; }
function explain(error: unknown): string {
  if (error instanceof ApiError && error.kind === "auth") return "API key rejected. Create a new dedicated key in Settings → API Keys.";
  if (error instanceof ApiError || error instanceof ConfigError) return error.message;
  return "Something went wrong. Try again.";
}
function syncControls() {
  const locked = Boolean(busy || permanentlyLocked);
  setup.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((control) => { control.disabled = Boolean(locked || setup.hidden); });
  settings.disabled = Boolean(locked || mutationPending || app.hidden); generate.disabled = Boolean(locked || app.hidden || !destinationsAvailable); domain.disabled = Boolean(locked || app.hidden); destination.disabled = Boolean(locked || app.hidden || !destinationsAvailable);
}
async function run(action: (active: () => boolean) => Promise<void>) {
  if (busy || permanentlyLocked) return; busy = true; const id = ++actionId; syncControls(); const active = () => id === actionId && !permanentlyLocked;
  try { await action(active); } finally { if (active()) { busy = false; syncControls(); } }
}

type ReadyOptions = {
  domains: Awaited<ReturnType<ReturnType<typeof createApi>["domains"]>>;
  destinations: Awaited<ReturnType<ReturnType<typeof createApi>["destinations"]>>;
};
async function loadReadyOptions(config: ExtensionConfig): Promise<ReadyOptions> {
  const api = createApi(config);
  const [domains, destinations] = await Promise.all([api.domains(), api.destinations()]);
  return { domains, destinations };
}
function syncFormatOptions() {
  const customAllowed = customAliasDomains.has(domain.value);
  if (customAllowed && !customFormat.isConnected) format.append(customFormat);
  if (!customAllowed) { if (format.value === "custom") format.value = "random_characters"; customFormat.remove(); }
  const customSelected = format.value === "custom";
  localLabel.hidden = !customSelected;
  localPart.required = customSelected;
}
async function ready(config: ExtensionConfig, options?: ReadyOptions) {
  serverInput.value = config.server;
  message("Checking your deployment…");
  const resolved = options ?? await loadReadyOptions(config);
  current = config;
  domain.replaceChildren(...resolved.domains.domains.map((item) => new Option(item, item, false, item === resolved.domains.defaultDomain)));
  customAliasDomains = new Set(resolved.domains.customAliasDomains);
  syncFormatOptions();
  destination.replaceChildren(...resolved.destinations.destinations.map((item) => new Option(item.email, item.id, false, item.id === resolved.destinations.defaultDestinationId)));
  destinationsAvailable = resolved.destinations.destinations.length > 0;
  byId<HTMLElement>("create-status").textContent = destinationsAvailable ? "" : "Add and verify a destination in HideMyEmail first.";
  setup.hidden = true; app.hidden = false; settings.hidden = false; activateAliasList(); byId<HTMLElement>("server-label").textContent = new URL(config.server).host; message("Ready"); selectTab(byId<HTMLButtonElement>("tab-create"));
}
function showSetup() { resetAliasList(); destinationsAvailable = false; setup.hidden = false; app.hidden = true; settings.hidden = true; result.hidden = true; message(); serverInput.focus(); }

function selectTab(tab: HTMLButtonElement) {
  for (const candidate of document.querySelectorAll<HTMLButtonElement>("[role=tab]")) {
    const selected = candidate === tab; candidate.setAttribute("aria-selected", String(selected)); candidate.tabIndex = selected ? 0 : -1;
    byId<HTMLElement>(candidate.getAttribute("aria-controls")!).hidden = !selected;
  }
  tab.focus(); if (tab.id === "tab-aliases") { activateAliasList(); void loadAliases(); }
}
function registerTabs() {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>("[role=tab]")];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      let next = index; if (event.key === "ArrowRight") next = (index + 1) % tabs.length; else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length; else if (event.key === "Home") next = 0; else if (event.key === "End") next = tabs.length - 1; else return;
      event.preventDefault(); selectTab(tabs[next]!);
    });
  });
}
function registerCreate() {
  const customize = byId<HTMLButtonElement>("customize"), controls = byId<HTMLElement>("custom-controls");
  customize.addEventListener("click", () => { const expanded = customize.getAttribute("aria-expanded") !== "true"; customize.setAttribute("aria-expanded", String(expanded)); controls.hidden = !expanded; });
  domain.addEventListener("change", syncFormatOptions);
  format.addEventListener("change", syncFormatOptions);
  generate.addEventListener("click", () => { void run(async (active) => {
    const input = createInput(domain.value, destination.value, format.value as AliasFormat, byId<HTMLInputElement>("description").value, localPart.value);
    if (input.format === "custom" && !localPart.checkValidity()) { localPart.reportValidity(); return; }
    result.hidden = true; byId<HTMLElement>("create-status").textContent = "Creating alias…";
    try { const response = await popupRequest({ type: "hme:aliases:create", input }); if (!active()) return; byId<HTMLElement>("alias").textContent = response.alias!.email; result.hidden = false; byId<HTMLElement>("create-status").textContent = "Alias created"; void loadAliases(); byId<HTMLButtonElement>("copy").focus(); }
    catch { if (active()) byId<HTMLElement>("create-status").textContent = SAFE_ERROR; }
  }); });
  byId<HTMLButtonElement>("copy").addEventListener("click", () => { void navigator.clipboard.writeText(byId<HTMLElement>("alias").textContent ?? "").then(() => { byId<HTMLElement>("create-status").textContent = "Copied to clipboard"; }).catch(() => { byId<HTMLElement>("create-status").textContent = "Could not copy. Select the alias and copy it manually."; }); });
}
function registerSetup() {
  byId<HTMLFormElement>("setup-form").addEventListener("submit", (event) => { event.preventDefault(); void run(async (active) => {
    message("Requesting permission…"); let options: ReadyOptions | undefined;
    try { const config = await configure(chromePlatform, serverInput.value, keyInput.value, async (candidate) => { await createApi(candidate).probe(); options = await loadReadyOptions(candidate); }); if (active()) { await ready(config, options); keyInput.value = ""; } }
    catch (error) { if (active()) message(explain(error), "error"); }
  }); });
  settings.addEventListener("click", () => { void run(async (active) => { if (active()) { if (current) serverInput.value = current.server; keyInput.value = ""; showSetup(); } }); });
}

void (async () => {
  registerSetup(); registerTabs(); registerCreate(); registerAliasList((pending) => { mutationPending = pending; syncControls(); });
  const initialized = await initializeConfig(chromePlatform);
  if (!initialized.ok) { showSetup(); permanentlyLocked = true; actionId++; syncControls(); message(initialized.error, "error"); return; }
  const saved = initialized.config;
  if (saved.server && saved.key) await ready(saved as ExtensionConfig).catch((error) => { showSetup(); message(explain(error), "error"); }); else showSetup();
  busy = false; syncControls();
})();
