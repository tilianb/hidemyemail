const TEXT_TYPES = new Set(["", "text", "search", "email"]);
const EMAIL_TOKEN = /(?:^|[^a-z])(?:e[\s._-]*mail|mail[\s._-]+address)(?:$|[^a-z])/i;

export const isValidDomain = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 253) return false;
  const labels = value.split(".");
  return labels.length > 1 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
};

function ownedByExtension(element: Element): boolean {
  let root: Node = element;
  while (root.getRootNode() instanceof ShadowRoot) root = (root.getRootNode() as ShadowRoot).host;
  return root instanceof Element && Boolean(root.closest("[data-hme-extension='true']"));
}

function metadata(input: HTMLInputElement): string {
  const labels = input.labels ? [...input.labels].map((label) => label.textContent ?? "") : [];
  return [input.name, input.id, input.getAttribute("aria-label") ?? "", input.placeholder, ...labels].join(" ").normalize("NFKC").toLowerCase();
}

export function isEmailField(value: EventTarget | null): value is HTMLInputElement {
  if (!(value instanceof HTMLInputElement) || !TEXT_TYPES.has(value.type.toLowerCase()) || value.disabled || value.readOnly || ownedByExtension(value)) return false;
  if (value.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  const rect = value.getBoundingClientRect();
  const style = getComputedStyle(value);
  if (rect.width < 16 || rect.height < 16 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight || style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || style.pointerEvents === "none") return false;
  let styledAncestor = value.parentElement?.closest<HTMLElement>("[style]") ?? null;
  while (styledAncestor) {
    if (styledAncestor.style.pointerEvents && getComputedStyle(styledAncestor).pointerEvents === "none") return false;
    styledAncestor = styledAncestor.parentElement?.closest<HTMLElement>("[style]") ?? null;
  }
  if (value.type === "email") return true;
  if ((value.autocomplete || "").toLowerCase().split(/\s+/).includes("email")) return true;
  return EMAIL_TOKEN.test(metadata(value));
}
