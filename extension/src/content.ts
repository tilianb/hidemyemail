import { isEmailField, isValidDomain } from "./detection";
import type { ContentRequest, ContentResponse } from "./messages";

type Send = (message: ContentRequest) => Promise<unknown>;
const SAFE_ERROR = "HideMyEmail could not complete the request. Try again.";
const teardowns = new WeakMap<HTMLDivElement, () => void>();
const TRIGGER_SIZE = 28;
const OVERLAY_GAP = 3;
const FIELD_EDGE_PADDING = 4;
const OVERLAY_SCAN_WIDTH = 96;
const OVERLAY_SCAN_STEP = 4;
const OVERLAY_CACHE_MS = 50;

function aliasResponse(value: unknown, domain: string): value is { ok: true; alias: string } {
  if (typeof value !== "object" || value === null || !("ok" in value) || !("alias" in value)) return false;
  const response = value as Record<string, unknown>;
  return response.ok === true && typeof response.alias === "string" && response.alias.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(response.alias) && response.alias.endsWith(`@${domain}`);
}

type InlineOptions = { ok: true; domains: string[]; defaultDomain: string; destinations: { id: string; email: string; isDefault: boolean }[]; defaultDestinationId: string | null };
function domainResponse(value: unknown): value is InlineOptions {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  if (response.ok !== true || !Array.isArray(response.domains) || response.domains.length === 0 || !response.domains.every(isValidDomain) || new Set(response.domains).size !== response.domains.length || typeof response.defaultDomain !== "string" || !response.domains.includes(response.defaultDomain) || !Array.isArray(response.destinations) || !(response.defaultDestinationId === null || typeof response.defaultDestinationId === "string")) return false;
  const destinations = response.destinations as unknown[];
  return destinations.length <= 100 && destinations.every((value) => {
    if (typeof value !== "object" || value === null) return false;
    const destination = value as Record<string, unknown>;
    return typeof destination.id === "string" && /^[1-9]\d*$/.test(destination.id) && typeof destination.email === "string" && destination.email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(destination.email) && typeof destination.isDefault === "boolean";
  }) && new Set(destinations.map((value) => (value as { id: string }).id)).size === destinations.length && (response.defaultDestinationId === null || destinations.some((value) => (value as { id: string }).id === response.defaultDestinationId));
}

export function fillField(input: HTMLInputElement, alias: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, alias);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export function requestAliasOnClick(button: HTMLButtonElement, input: HTMLInputElement, selectedDomain: string | (() => string), selectedDestinationId: string | (() => string), send: Send, finished?: () => void, failed?: () => void, active: () => boolean = () => true): void {
  button.addEventListener("click", () => {
    const domain = typeof selectedDomain === "function" ? selectedDomain() : selectedDomain;
    const destinationId = typeof selectedDestinationId === "function" ? selectedDestinationId() : selectedDestinationId;
    button.disabled = true;
    void send({ type: "hme:generate", domain, destinationId }).then((response) => {
      if (!active()) return;
      if (!aliasResponse(response, domain) || !input.isConnected || !isEmailField(input)) { failed?.(); return; }
      fillField(input, response.alias);
      input.focus();
      finished?.();
    }).catch(() => { if (active()) failed?.(); }).finally(() => { if (active()) button.disabled = false; });
  });
}

function overlaps(left: number, top: number, width: number, rect: DOMRect): boolean {
  return rect.right > left && rect.left < left + width && rect.bottom > top && rect.top < top + TRIGGER_SIZE;
}

function foreignOverlayRects(input: HTMLInputElement, host: HTMLDivElement, left: number, top: number, width: number): DOMRect[] {
  const candidates = new Set<Element>(document.querySelectorAll("com-1password-button, [popover='manual']"));
  const pointHits = new Map<Element, number>();
  if (typeof document.elementsFromPoint === "function") {
    for (let x = left + 2; x < left + width; x += OVERLAY_SCAN_STEP) {
      for (const element of document.elementsFromPoint(x, top + TRIGGER_SIZE / 2)) {
        candidates.add(element);
        if (!pointHits.has(element)) pointHits.set(element, x);
      }
    }
  }
  const rects: DOMRect[] = [];
  for (const element of candidates) {
    if (!(element instanceof HTMLElement) || element === host || host.contains(element) || element === input || element.contains(input)) continue;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
    const rect = element.getBoundingClientRect();
    if (style.pointerEvents !== "none" && rect.width > 0 && rect.height > 0 && overlaps(left, top, width, rect)) rects.push(rect);
    else if (pointHits.has(element) && element.localName.includes("-")) {
      // Closed shadow content is reported as its custom-element host, whose box
      // may not match the visible control. The hit point still proves the lane is occupied.
      rects.push(new DOMRect(pointHits.get(element)!, top, OVERLAY_SCAN_STEP, TRIGGER_SIZE));
    }
  }
  return rects;
}

type OverlayRects = (input: HTMLInputElement, host: HTMLDivElement, left: number, top: number, width: number) => DOMRect[];

export function triggerLeft(input: HTMLInputElement, host: HTMLDivElement, top: number, overlayRects: OverlayRects = foreignOverlayRects): number | null {
  const field = input.getBoundingClientRect();
  const trailingEdge = field.right - FIELD_EDGE_PADDING;
  const scanLeft = Math.max(field.left, trailingEdge - OVERLAY_SCAN_WIDTH);
  const collisions = overlayRects(input, host, scanLeft, top, trailingEdge - scanLeft);
  const left = collisions.length === 0
    ? trailingEdge - TRIGGER_SIZE
    : Math.min(...collisions.map((rect) => rect.left)) - OVERLAY_GAP - TRIGGER_SIZE;
  return left >= field.left + FIELD_EDGE_PADDING ? left : null;
}

export function mountContent(send: Send, shadowMode: ShadowRootMode = "closed"): HTMLDivElement {
  const host = document.createElement("div"); host.dataset.hmeExtension = "true";
  const shadow = host.attachShadow({ mode: shadowMode });
  const style = document.createElement("style");
  style.textContent = `:host{all:initial;position:fixed;z-index:2147483647;color-scheme:dark;font:13px system-ui,sans-serif}.trigger{display:grid;place-items:center;width:28px;height:28px;padding:0;border:1px solid #7a5700;border-radius:7px;background:#ffb300;color:#111;cursor:pointer}.trigger svg{width:22px;height:22px;border-radius:5px}.trigger:focus-visible,button:focus-visible,select:focus-visible{outline:3px solid CanvasText;outline-offset:2px}.panel{box-sizing:border-box;position:fixed;width:250px;padding:14px;border:1px solid #45454f;border-radius:12px;background:#111114;color:#eee;box-shadow:0 8px 30px #0008}.brand{margin:0 0 10px;font-weight:700}.panel label{display:grid;gap:5px;margin-top:8px;color:#bbb}.panel select,.panel button{box-sizing:border-box;width:100%;min-height:38px;margin-top:5px;border:1px solid #555;border-radius:8px;padding:0 9px;background:#202026;color:#eee;font:inherit}.panel button{margin-top:10px;border-color:#ffb300;background:#ffb300;color:#111;font-weight:700;cursor:pointer}.status{min-height:16px;margin:8px 0 0;color:#ffcf5c;font-size:12px}@media(forced-colors:active){.trigger,.panel button{forced-color-adjust:none}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}`;
  const trigger = document.createElement("button"); trigger.className = "trigger"; trigger.type = "button"; trigger.setAttribute("aria-label", "Generate a HideMyEmail alias");
  trigger.innerHTML = `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#0d0d0f"/><rect x=".5" y=".5" width="31" height="31" rx="7.5" stroke="#ffb300" stroke-opacity=".15"/><path d="M6 10a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V10Z" stroke="#e8e8ec" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="m6 10 10 6.5L26 10" stroke="#e8e8ec" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><rect x="9.5" y="14" width="13" height="4.5" rx="1" fill="#ffb300"/></svg>`;
  shadow.append(style, trigger); host.hidden = true; document.documentElement.append(host);
  let target: HTMLInputElement | null = null; let panel: HTMLDivElement | null = null; let frame = 0; let generation = 0; let placementTimers: number[] = [];
  let overlayCache: { input: HTMLInputElement; left: number; top: number; scannedAt: number; rects: DOMRect[] } | null = null;
  const cachedOverlayRects: OverlayRects = (input, overlayHost, left, top, width) => {
    const now = Date.now();
    if (overlayCache?.input === input && now - overlayCache.scannedAt < OVERLAY_CACHE_MS) {
      const dx = left - overlayCache.left; const dy = top - overlayCache.top;
      return overlayCache.rects.map((rect) => new DOMRect(rect.left + dx, rect.top + dy, rect.width, rect.height));
    }
    const rects = foreignOverlayRects(input, overlayHost, left, top, width);
    overlayCache = { input, left, top, scannedAt: now, rects };
    return rects;
  };
  const invalidateOverlayCache = () => { overlayCache = null; };
  const place = () => {
    if (!target) return;
    cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      if (!target?.isConnected || !isEmailField(target)) return hide();
      const rect = target.getBoundingClientRect();
      const top = Math.min(Math.max(0, rect.top + (rect.height - TRIGGER_SIZE) / 2), Math.max(0, innerHeight - TRIGGER_SIZE));
      const left = triggerLeft(target, host, top, cachedOverlayRects);
      host.hidden = left === null;
      if (left === null) return;
      host.style.left = `${Math.min(Math.max(0, left), Math.max(0, innerWidth - TRIGGER_SIZE))}px`;
      host.style.top = `${top}px`;
      if (panel) {
        const panelWidth = 250; const panelHeight = panel.getBoundingClientRect().height || 250; const gap = 6;
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
  const hide = () => { close(false); target = null; invalidateOverlayCache(); host.hidden = true; placementTimers.forEach(clearTimeout); placementTimers = []; observe(false); };
  const open = async () => {
    if (!target || panel) return;
    panel = document.createElement("div"); panel.className = "panel"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "HideMyEmail alias generator");
    const openedPanel = panel; const openedTarget = target; const openedGeneration = generation;
    panel.innerHTML = `<p class="brand">HideMyEmail</p><p class="status" role="status">Loading domains…</p>`; shadow.append(panel);
    const response = await send({ type: "hme:domain-options" }).catch(() => null);
    if (panel !== openedPanel || target !== openedTarget || generation !== openedGeneration) return;
    if (!domainResponse(response)) { panel.querySelector(".status")!.textContent = SAFE_ERROR; return; }
    const domainLabel = document.createElement("label"); domainLabel.textContent = "Alias domain";
    const domainSelect = document.createElement("select"); domainSelect.setAttribute("aria-label", "Alias domain");
    domainSelect.replaceChildren(...response.domains.map((domain) => {
      const option = document.createElement("option"); option.value = domain; option.textContent = domain; option.selected = domain === response.defaultDomain; return option;
    })); domainLabel.append(domainSelect);
    const destinationLabel = document.createElement("label"); destinationLabel.textContent = "Forward to";
    const destinationSelect = document.createElement("select"); destinationSelect.setAttribute("aria-label", "Forward to destination");
    destinationSelect.replaceChildren(...response.destinations.map((destination) => {
      const option = document.createElement("option"); option.value = destination.id; option.textContent = destination.email; option.selected = destination.id === response.defaultDestinationId; return option;
    })); destinationLabel.append(destinationSelect);
    const generate = document.createElement("button"); generate.type = "button"; generate.textContent = "Generate & fill";
    const status = panel.querySelector<HTMLElement>(".status")!; status.textContent = ""; panel.insertBefore(domainLabel, status); panel.insertBefore(destinationLabel, status);
    if (response.destinations.length === 0) { destinationSelect.disabled = true; status.textContent = "Add and verify a destination in HideMyEmail first."; domainSelect.focus(); place(); return; }
    panel.insertBefore(generate, status);
    requestAliasOnClick(generate, openedTarget, () => domainSelect.value, () => destinationSelect.value, (message) => send(message), () => close(false), () => { status.textContent = SAFE_ERROR; }, () => panel === openedPanel && target === openedTarget && generation === openedGeneration); domainSelect.focus(); place();
  };
  const onTriggerClick = () => { void open(); };
  const onFocusIn = (event: FocusEvent) => {
    const input = event.composedPath().find(isEmailField);
    if (input) {
      target = input; invalidateOverlayCache(); host.hidden = false; close(false); observe(true); place();
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
  const onResize = () => { invalidateOverlayCache(); place(); };
  addEventListener("resize", onResize, { passive: true }); addEventListener("scroll", place, { passive: true, capture: true });
  let mutationTimer = 0;
  const onMutations: MutationCallback = (records) => {
    if (!host.isConnected) document.documentElement.append(host);
    const hasExternalMutation = records.some(({ target: mutationTarget }) => mutationTarget !== host && !host.contains(mutationTarget) && mutationTarget.getRootNode() !== shadow);
    if (!target || !hasExternalMutation) return;
    invalidateOverlayCache();
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
    removeEventListener("resize", onResize); removeEventListener("scroll", place, true);
    teardowns.delete(host); host.remove();
  });
  return host;
}

export function unmountContent(host: HTMLDivElement): void {
  teardowns.get(host)?.();
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) mountContent((message) => chrome.runtime.sendMessage(message) as Promise<ContentResponse>);
