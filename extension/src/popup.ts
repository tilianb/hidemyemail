import { ApiError, createApi } from "./api";
import { chromePlatform, ConfigError, configure, initializeConfig, type ExtensionConfig } from "./config";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const setup = byId<HTMLElement>("setup"), generator = byId<HTMLElement>("generator"), status = byId<HTMLElement>("status");
const serverInput = byId<HTMLInputElement>("server"), keyInput = byId<HTMLInputElement>("key"), domainSelect = byId<HTMLSelectElement>("domain");
const generateButton = byId<HTMLButtonElement>("generate"), result = byId<HTMLElement>("result"), aliasText = byId<HTMLElement>("alias");
const connectButton = byId<HTMLButtonElement>("connect"), copyButton = byId<HTMLButtonElement>("copy");
const settingsButton = byId<HTMLButtonElement>("settings"), serverLabel = byId<HTMLElement>("server-label");
let current: ExtensionConfig | null = null;
let allowedDomains: string[] = [];
let busy = true, permanentlyLocked = false, actionId = 0;

function syncControls() {
  const locked = busy || permanentlyLocked;
  serverInput.disabled = locked || Boolean(setup.hidden);
  keyInput.disabled = locked || Boolean(setup.hidden);
  connectButton.disabled = locked || Boolean(setup.hidden);
  settingsButton.disabled = locked || Boolean(generator.hidden);
  domainSelect.disabled = locked || Boolean(generator.hidden);
  generateButton.disabled = locked || Boolean(generator.hidden);
  copyButton.disabled = locked || Boolean(generator.hidden) || Boolean(result.hidden);
}
async function runAction(action: (active: () => boolean) => Promise<void>) {
  if (busy || permanentlyLocked) return;
  busy = true; const id = ++actionId; syncControls();
  const active = () => id === actionId && !permanentlyLocked;
  try { await action(active); }
  finally { if (active()) { busy = false; syncControls(); } }
}

function message(text = "", kind: "error" | "success" | "" = "") { status.textContent = text; status.className = kind; }
function explain(error: unknown): string {
  if (error instanceof ApiError && error.kind === "auth") return "API key rejected. Create a new dedicated key in Settings → API Keys.";
  if (error instanceof ApiError) return error.message;
  if (error instanceof ConfigError) return error.message;
  return "Something went wrong. Try again.";
}
type DomainOptions = Awaited<ReturnType<ReturnType<typeof createApi>["domains"]>>;
async function ready(config: ExtensionConfig, validatedOptions?: DomainOptions) {
  message("Checking your deployment…");
  let options = validatedOptions;
  if (!options) {
    const api = createApi(config);
    await api.probe();
    options = await api.domains();
  }
  current = config;
  allowedDomains = [...options.domains];
  domainSelect.replaceChildren(...options.domains.map((domain) => new Option(domain, domain, false, domain === options.defaultDomain)));
  setup.hidden = true; generator.hidden = false; settingsButton.hidden = false;
  serverLabel.textContent = new URL(config.server).host; message("Ready"); generateButton.focus();
}
function showSetup() {
  setup.hidden = false; generator.hidden = true; settingsButton.hidden = true; result.hidden = true; message(); serverInput.focus();
}

function registerSecretActions() {
  byId<HTMLFormElement>("setup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    void runAction(async (active) => {
      message("Requesting permission…");
      let options: DomainOptions | undefined;
      try {
        const config = await configure(chromePlatform, serverInput.value, keyInput.value, async (candidate) => {
          const api = createApi(candidate);
          await api.probe();
          options = await api.domains();
        });
        if (!active()) return;
        await ready(config, options); if (active()) keyInput.value = "";
      }
      catch (error) { if (active()) message(explain(error), "error"); }
    });
  });
  settingsButton.addEventListener("click", () => { void runAction(async (active) => { if (!active()) return; if (current) serverInput.value = current.server; keyInput.value = ""; showSetup(); }); });
  generateButton.addEventListener("click", async () => {
    void runAction(async (active) => {
      if (!current) return;
      result.hidden = true; message("Generating alias…");
      try { const alias = await createApi(current).createAlias(domainSelect.value, allowedDomains); if (!active()) return; aliasText.textContent = alias; result.hidden = false; message("Alias generated", "success"); copyButton.focus(); }
      catch (error) { if (active()) message(explain(error), "error"); }
    });
  });
  copyButton.addEventListener("click", () => { void runAction(async (active) => {
    try { await navigator.clipboard.writeText(aliasText.textContent ?? ""); if (active()) message("Copied to clipboard", "success"); }
    catch { if (active()) message("Could not copy. Select the alias and copy it manually.", "error"); }
  }); });
}

void (async () => {
  registerSecretActions();
  const initialized = await initializeConfig(chromePlatform);
  if (!initialized.ok) {
    showSetup();
    permanentlyLocked = true; actionId++; syncControls();
    message(initialized.error, "error");
    return;
  }
  const saved = initialized.config;
  if (saved.server && saved.key) await ready(saved as ExtensionConfig).catch((error) => { showSetup(); message(explain(error), "error"); });
  else showSetup();
  busy = false; syncControls();
})();
