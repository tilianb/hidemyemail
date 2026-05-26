export function toBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function fromBase64url(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  const bin = atob(padded + "=".repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Derive rpID and expected origin from the browser's Origin header.
// This automatically handles production, preview, and localhost dev environments.
export function getRpFromOrigin(origin: string | null | undefined): { rpID: string; expectedOrigin: string } {
  if (origin) {
    try {
      const url = new URL(origin);
      return { rpID: url.hostname, expectedOrigin: origin };
    } catch {}
  }
  return { rpID: "hidemyemail.dev", expectedOrigin: "https://hidemyemail.dev" };
}
