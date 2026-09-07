import type { Alias } from "./api";
import { popupRequest, SAFE_ERROR } from "./popup-client";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const state = byId<HTMLElement>("list-state"), list = byId<HTMLUListElement>("alias-list"), retry = byId<HTMLButtonElement>("retry");
let requestId = 0;
const rowLocks = new Set<string>();
let listActive = false;
let mutationStateChanged: (pending: boolean) => void = () => {};

function button(action: string, label: string, id: string): HTMLButtonElement {
  const element = document.createElement("button"); element.type = "button"; element.dataset.action = action; element.dataset.id = id; element.textContent = label; return element;
}
function safeMessage(text: string) { state.textContent = text; }
async function copy(text: string) { try { await navigator.clipboard.writeText(text); safeMessage("Copied to clipboard"); } catch { safeMessage("Could not copy. Select the alias and copy it manually."); } }

function render(aliases: Alias[]) {
  list.replaceChildren();
  safeMessage(aliases.length ? "" : "No aliases found. Create one or try another search.");
  for (const alias of aliases) {
    const row = document.createElement("li"); row.dataset.id = alias.id;
    const info = document.createElement("div"); info.className = "alias-info";
    const address = document.createElement("strong"); address.textContent = alias.email;
    const meta = document.createElement("span"); meta.textContent = `${alias.active ? "Active" : "Inactive"}${alias.description ? ` · ${alias.description}` : ""}`;
    info.append(address, meta);
    const actions = document.createElement("div"); actions.className = "row-actions";
    actions.append(button("copy", "Copy", alias.id), button("state", alias.active ? "Deactivate" : "Activate", alias.id), button("delete", "Delete", alias.id));
    row.append(info, actions); list.append(row);
    row.addEventListener("click", (event) => { void handleRow(event, alias, row); });
  }
}

async function mutate(alias: Alias, action: "activate" | "deactivate" | "delete", row: HTMLLIElement) {
  if (rowLocks.has(alias.id)) return;
  rowLocks.add(alias.id); mutationStateChanged(true); row.querySelectorAll("button").forEach((control) => { control.disabled = true; });
  try { await popupRequest({ type: `hme:aliases:${action}` as "hme:aliases:activate", id: alias.id }); await loadAliases(); }
  catch { safeMessage(SAFE_ERROR); row.querySelectorAll("button").forEach((control) => { control.disabled = false; }); }
  finally { rowLocks.delete(alias.id); mutationStateChanged(rowLocks.size > 0); }
}
async function handleRow(event: Event, alias: Alias, row: HTMLLIElement) {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]"); if (!target) return;
  if (target.dataset.action === "copy") return copy(alias.email);
  if (target.dataset.action === "state") return mutate(alias, alias.active ? "deactivate" : "activate", row);
  if (target.dataset.action === "cancel-delete") { renderConfirmation(row, alias, false); return; }
  if (target.dataset.action === "confirm-delete") return mutate(alias, "delete", row);
  if (target.dataset.action === "delete") renderConfirmation(row, alias, true);
}
function renderConfirmation(row: HTMLLIElement, alias: Alias, show: boolean) {
  row.querySelector(".delete-confirm")?.remove();
  if (!show) return;
  const confirm = document.createElement("div"); confirm.className = "delete-confirm";
  const text = document.createElement("span"); text.textContent = `Delete ${alias.email}?`;
  confirm.append(text, button("confirm-delete", "Delete", alias.id), button("cancel-delete", "Cancel", alias.id)); row.append(confirm);
}

export async function loadAliases(): Promise<void> {
  if (!listActive) return;
  const id = ++requestId; retry.hidden = true; safeMessage("Loading aliases…");
  const search = byId<HTMLInputElement>("search").value.trim();
  try {
    const response = await popupRequest({ type: "hme:aliases:list", ...(search ? { search } : {}) });
    if (id !== requestId) return; render(response.aliases ?? []);
  } catch { if (id === requestId) { list.replaceChildren(); safeMessage(SAFE_ERROR); retry.hidden = false; } }
}

export function resetAliasList(): void {
  listActive = false; requestId++; list.replaceChildren(); safeMessage(""); retry.hidden = true;
}

export function registerAliasList(onMutationStateChanged: (pending: boolean) => void) {
  mutationStateChanged = onMutationStateChanged;
  byId<HTMLFormElement>("search-form").addEventListener("submit", (event) => { event.preventDefault(); void loadAliases(); });
  retry.addEventListener("click", () => { void loadAliases(); });
}

export function activateAliasList(): void { listActive = true; }
