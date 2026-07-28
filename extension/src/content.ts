import { isEmailField, isValidDomain } from "./detection";
import type { ContentRequest, ContentResponse } from "./messages";

type Send = (message: ContentRequest) => Promise<unknown>;
const SAFE_ERROR = "HideMyEmail could not complete the request. Try again.";
const teardowns = new WeakMap<HTMLDivElement, () => void>();
const TRIGGER_SIZE = 28;
const OVERLAY_GAP = 6;

function aliasResponse(value: unknown, domain: string): value is { ok: true; alias: string } {
  if (typeof value !== "object" || value === null || !("ok" in value) || !("alias" in value)) return false;
  const response = value as Record<string, unknown>;
  return response.ok === true && typeof response.alias === "string" && response.alias.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(response.alias) && response.alias.endsWith(`@${domain}`);
}

function domainResponse(value: unknown): value is { ok: true; domains: string[]; defaultDomain: string } {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return response.ok === true && Array.isArray(response.domains) && response.domains.length > 0 && response.domains.every(isValidDomain) && new Set(response.domains).size === response.domains.length && typeof response.defaultDomain === "string" && response.domains.includes(response.defaultDomain);
}

export function fillField(input: HTMLInputElement, alias: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, alias);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export function requestAliasOnClick(button: HTMLButtonElement, input: HTMLInputElement, selectedDomain: string | (() => string), send: Send, finished?: () => void, failed?: () => void, active: () => boolean = () => true): void {
  button.addEventListener("click", () => {
    const domain = typeof selectedDomain === "function" ? selectedDomain() : selectedDomain;
    button.disabled = true;
    void send({ type: "hme:generate", domain }).then((response) => {
      if (!active()) return;
      if (!aliasResponse(response, domain) || !input.isConnected || !isEmailField(input)) { failed?.(); return; }
      fillField(input, response.alias);
      input.focus();
      finished?.();
    }).catch(() => { if (active()) failed?.(); }).finally(() => { if (active()) button.disabled = false; });
  });
}

function overlaps(left: number, top: number, rect: DOMRect): boolean {
  return rect.right > left && rect.left < left + TRIGGER_SIZE && rect.bottom > top && rect.top < top + TRIGGER_SIZE;
}

function foreignOverlayRects(input: HTMLInputElement, host: HTMLDivElement, left: number, top: number): DOMRect[] {
  const candidates = new Set<Element>(document.querySelectorAll("com-1password-button, [popover='manual']"));
  const pointHits = new Set<Element>();
  if (typeof document.elementsFromPoint === "function") {
    for (const x of [left + 2, left + TRIGGER_SIZE / 2, left + TRIGGER_SIZE - 2]) {
      for (const element of document.elementsFromPoint(x, top + TRIGGER_SIZE / 2)) {
        candidates.add(element); pointHits.add(element);
      }
    }
  }
  const rects: DOMRect[] = [];
  for (const element of candidates) {
    if (!(element instanceof HTMLElement) || element === host || host.contains(element) || element === input || element.contains(input)) continue;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
    const rect = element.getBoundingClientRect();
    if (style.pointerEvents !== "none" && rect.width > 0 && rect.height > 0 && overlaps(left, top, rect)) rects.push(rect);
    else if (pointHits.has(element) && element.localName.includes("-")) {
      // Closed shadow content is reported as its custom-element host, whose box
      // may not match the visible control. The hit point still proves the lane is occupied.
      rects.push(new DOMRect(left, top, TRIGGER_SIZE, TRIGGER_SIZE));
    }
  }
  return rects;
}

export function triggerLeft(input: HTMLInputElement, host: HTMLDivElement, top: number): number | null {
  const field = input.getBoundingClientRect();
  let left = field.right - TRIGGER_SIZE;
  for (let attempt = 0; attempt < 4; attempt++) {
    const collisions = foreignOverlayRects(input, host, left, top);
    if (collisions.length === 0) return left >= field.left ? left : null;
    left = Math.min(...collisions.map((rect) => rect.left)) - OVERLAY_GAP - TRIGGER_SIZE;
  }
  return null;
}

export function mountContent(send: Send, shadowMode: ShadowRootMode = "closed"): HTMLDivElement {
  const host = document.createElement("div"); host.dataset.hmeExtension = "true";
  const shadow = host.attachShadow({ mode: shadowMode });
  const style = document.createElement("style");
  style.textContent = `:host{all:initial;position:fixed;z-index:2147483647;color-scheme:dark;font:13px system-ui,sans-serif}.trigger{width:28px;height:28px;padding:0;border:1px solid #7a5700;border-radius:7px;background:#ffb300;color:#111;cursor:pointer;font-size:16px;line-height:26px}.trigger:focus-visible,button:focus-visible,select:focus-visible{outline:3px solid CanvasText;outline-offset:2px}.panel{box-sizing:border-box;position:fixed;width:230px;padding:14px;border:1px solid #45454f;border-radius:12px;background:#111114;color:#eee;box-shadow:0 8px 30px #0008}.brand{margin:0 0 10px;font-weight:700}.panel label{display:grid;gap:5px;color:#bbb}.panel select,.panel button{box-sizing:border-box;width:100%;min-height:38px;margin-top:5px;border:1px solid #555;border-radius:8px;padding:0 9px;background:#202026;color:#eee;font:inherit}.panel button{margin-top:10px;border-color:#ffb300;background:#ffb300;color:#111;font-weight:700;cursor:pointer}.status{min-height:16px;margin:8px 0 0;color:#ffcf5c;font-size:12px}@media(forced-colors:active){.trigger,.panel button{forced-color-adjust:none}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}`;
  const trigger = document.createElement("button"); trigger.className = "trigger"; trigger.type = "button"; trigger.setAttribute("aria-label", "Generate a HideMyEmail alias"); trigger.textContent = "✉";
  shadow.append(style, trigger); host.hidden = true; document.documentElement.append(host);
  let target: HTMLInputElement | null = null; let panel: HTMLDivElement | null = null; let frame = 0; let generation = 0; let placementTimers: number[] = [];
  const place = () => {
    if (!target) return;
    cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      if (!target?.isConnected || !isEmailField(target)) return hide();
      const rect = target.getBoundingClientRect();
      const top = Math.min(Math.max(0, rect.top + (rect.height - TRIGGER_SIZE) / 2), Math.max(0, innerHeight - TRIGGER_SIZE));
      const left = triggerLeft(target, host, top);
      host.hidden = left === null;
      if (left === null) return;
      host.style.left = `${Math.min(Math.max(0, left), Math.max(0, innerWidth - TRIGGER_SIZE))}px`;
      host.style.top = `${top}px`;
      if (panel) {
        const panelWidth = 230; const panelHeight = panel.getBoundingClientRect().height || 190; const gap = 6;
        const below = innerHeight - rect.bottom; const top = below >= panelHeight + gap || below >= rect.top ? rect.bottom + gap : rect.top - panelHeight - gap;
        panel.style.left = `${Math.min(Math.max(0, rect.right - panelWidth), Math.max(0, innerWidth - panelWidth))}px`;
        panel.style.top = `${Math.min(Math.max(0, top), Math.max(0, innerHeight - panelHeight))}px`;
      }
    });
  };
  const close = (restore = true) => {
    generation++;
    panel?.remove(); panel = null;
    if (restore && target?.isConnected) target.focus();
  };
  const inactiveObservation = { childList: true } as const;
  const activeObservation: MutationObserverInit = { attributes: true, childList: true, subtree: true, attributeFilter: ["type", "disabled", "readonly", "autocomplete", "name", "id", "aria-label", "placeholder", "class", "style", "hidden", "inert", "aria-hidden"] };
  let recoveryObserver: MutationObserver; let attributeObserver: MutationObserver;
  const observe = (active: boolean) => {
    if (active) attributeObserver.observe(document.documentElement, activeObservation);
    else { attributeObserver.disconnect(); recoveryObserver.observe(document.documentElement, inactiveObservation); }
  };
  const hide = () => { close(false); target = null; host.hidden = true; placementTimers.forEach(clearTimeout); placementTimers = []; observe(false); };
  const open = async () => {
    if (!target || panel) return;
    panel = document.createElement("div"); panel.className = "panel"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "HideMyEmail alias generator");
    const openedPanel = panel; const openedTarget = target; const openedGeneration = generation;
    panel.innerHTML = `<p class="brand">HideMyEmail</p><p class="status" role="status">Loading domains…</p>`; shadow.append(panel);
    const response = await send({ type: "hme:domain-options" }).catch(() => null);
    if (panel !== openedPanel || target !== openedTarget || generation !== openedGeneration) return;
    if (!domainResponse(response)) { panel.querySelector(".status")!.textContent = SAFE_ERROR; return; }
    const label = document.createElement("label"); label.textContent = "Alias domain";
    const select = document.createElement("select"); select.setAttribute("aria-label", "Alias domain");
    select.replaceChildren(...response.domains.map((domain) => {
      const option = document.createElement("option"); option.value = domain; option.textContent = domain; option.selected = domain === response.defaultDomain; return option;
    })); label.append(select);
    const generate = document.createElement("button"); generate.type = "button"; generate.textContent = "Generate & fill";
    const status = panel.querySelector<HTMLElement>(".status")!; status.textContent = ""; panel.insertBefore(label, status); panel.insertBefore(generate, status);
    requestAliasOnClick(generate, openedTarget, () => select.value, (message) => send(message), () => close(false), () => { status.textContent = SAFE_ERROR; }, () => panel === openedPanel && target === openedTarget && generation === openedGeneration); select.focus(); place();
  };
  const onTriggerClick = () => { void open(); };
  const onFocusIn = (event: FocusEvent) => {
    const input = event.composedPath().find(isEmailField);
    if (input) {
      target = input; host.hidden = false; close(false); observe(true); place();
      placementTimers.forEach(clearTimeout);
      placementTimers = [100, 300, 1000].map((delay) => window.setTimeout(place, delay));
    }
    else if (event.composedPath().includes(host)) return;
    else if (!panel) hide();
  };
  const onPointerDown = (event: PointerEvent) => { if (panel && !event.composedPath().includes(host)) close(true); };
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && panel) { event.preventDefault(); close(true); } };
  trigger.addEventListener("click", onTriggerClick);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  addEventListener("resize", place, { passive: true }); addEventListener("scroll", place, { passive: true, capture: true });
  let mutationTimer = 0;
  const onMutations: MutationCallback = (records) => {
    if (!host.isConnected) document.documentElement.append(host);
    const hasExternalMutation = records.some(({ target: mutationTarget }) => mutationTarget !== host && !host.contains(mutationTarget) && mutationTarget.getRootNode() !== shadow);
    if (!target || !hasExternalMutation) return;
    clearTimeout(mutationTimer); mutationTimer = window.setTimeout(place, 100);
  };
  recoveryObserver = new MutationObserver(onMutations);
  attributeObserver = new MutationObserver(onMutations);
  observe(false);
  teardowns.set(host, () => {
    generation++;
    recoveryObserver.disconnect(); attributeObserver.disconnect(); clearTimeout(mutationTimer); placementTimers.forEach(clearTimeout); cancelAnimationFrame(frame);
    trigger.removeEventListener("click", onTriggerClick);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    removeEventListener("resize", place); removeEventListener("scroll", place, true);
    teardowns.delete(host); host.remove();
  });
  return host;
}

export function unmountContent(host: HTMLDivElement): void {
  teardowns.get(host)?.();
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) mountContent((message) => chrome.runtime.sendMessage(message) as Promise<ContentResponse>);
