const TEXT_TYPES = new Set(["", "text", "email"]);
// Portions adapted from DuckDuckGo Autofill's ddgMatcher.emailAddress and
// selectors-css.js. Copyright (c) 2021 Duck Duck Go, Inc. Apache-2.0.
// Modified: bounded words, no Apple ID/phone inference, added French/Japanese
// labels, and exclusions before explicit email hints. See THIRD_PARTY_NOTICES.md.
const EMAIL_TOKEN = /(?:^|[^\p{L}])(?:e[\s._-]*mail|mail[\s._-]+address|posta elettronica|e.?mailadres|correo electr[oó]nico|correo-e|correo|e.?post(?:adress)?|courriel)(?:$|[^\p{L}])|メールアドレス/iu;
const NON_ADDRESS_TOKEN = /(?:^|[^a-z])(?:search|filter|subject|title|code|otp|totp)(?:$|[^a-z])/i;

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
  const root = input.getRootNode();
  const labelRoot = root instanceof ShadowRoot ? root : input.ownerDocument;
  for (const id of (input.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)) {
    labels.push(labelRoot.getElementById(id)?.textContent ?? "");
  }
  return [input.name, input.id, input.getAttribute("aria-label") ?? "", input.placeholder, ...labels]
    .map((text) => text.normalize("NFKC").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()).join(" ");
}

export function isEmailField(value: EventTarget | null): value is HTMLInputElement {
  if (!(value instanceof HTMLInputElement) || !TEXT_TYPES.has(value.type.toLowerCase()) || value.disabled || value.readOnly || ownedByExtension(value)) return false;
  const autocomplete = (value.autocomplete || "").toLowerCase().split(/\s+/);
  if (autocomplete.includes("one-time-code") || ["search", "searchbox"].includes(value.getAttribute("role")?.toLowerCase() ?? "")) return false;
  if (value.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  const rect = value.getBoundingClientRect();
  const style = getComputedStyle(value);
  if (rect.width < 16 || rect.height < 16 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight || style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || style.pointerEvents === "none") return false;
  let styledAncestor = value.parentElement?.closest<HTMLElement>("[style]") ?? null;
  while (styledAncestor) {
    if (styledAncestor.style.pointerEvents && getComputedStyle(styledAncestor).pointerEvents === "none") return false;
    styledAncestor = styledAncestor.parentElement?.closest<HTMLElement>("[style]") ?? null;
  }
  const hints = metadata(value);
  if (NON_ADDRESS_TOKEN.test(hints)) return false;
  if (value.type === "email") return true;
  if (autocomplete.includes("email")) return true;
  return EMAIL_TOKEN.test(hints);
}
