import type { ParsedReverse } from "../types";

// addy-style reverse address: "shop+alice=store.com@example.com".
// The external sender is encoded inline (local=domain) — self-describing, no DB token.
export function reverseAddress(aliasLocal: string, externalSender: string, domain: string): string {
  const at = externalSender.lastIndexOf("@");
  const extLocal = externalSender.slice(0, at);
  const extDomain = externalSender.slice(at + 1);
  return `${aliasLocal}+${extLocal}=${extDomain}@${domain}`;
}

// Parse "shop+alice=store.com" → { aliasLocal: "shop", externalSender: "alice@store.com" }.
// Alias splits on the FIRST '+'; the external local/domain split on the LAST '='
// so senders whose own address contains '+' or '=' still round-trip.
export function parseReverse(localPart: string): ParsedReverse | null {
  const plus = localPart.indexOf("+");
  if (plus <= 0) return null;
  const aliasLocal = localPart.slice(0, plus);
  const rest = localPart.slice(plus + 1); // e.g. "alice=store.com"
  const eq = rest.lastIndexOf("=");
  if (eq <= 0 || eq === rest.length - 1) return null;
  const extLocal = rest.slice(0, eq);
  const extDomain = rest.slice(eq + 1);
  if (!extDomain.includes(".")) return null; // require a real domain, not a stray '='
  return { aliasLocal, externalSender: `${extLocal}@${extDomain}` };
}
