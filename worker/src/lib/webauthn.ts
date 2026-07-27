export function toBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function fromBase64url(b64url: string): Uint8Array<ArrayBuffer> {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  const bin = atob(padded + "=".repeat(pad));
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Parse the canonical configured application origin. Plain HTTP is permitted
// only for loopback development; paths, credentials, query and fragments are
// never valid WebAuthn origins.
export function getRpFromOrigin(origin: string | null | undefined): { rpID: string; expectedOrigin: string } {
  if (!origin) throw new Error("APP_ORIGIN is required");
  const url = new URL(origin);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("APP_ORIGIN must be an HTTPS origin (HTTP is allowed only for localhost)");
  }
  return { rpID: url.hostname, expectedOrigin: url.origin };
}

export function getAndroidAssociations(config: string | null | undefined): { origins: string[]; fingerprints: string[] } {
  if (!config?.trim()) return { origins: [], fingerprints: [] };
  const origins = config.split(",").map(value => value.trim());
  if (origins.some(value => !/^android:apk-key-hash:[A-Za-z0-9_-]{43}$/.test(value))) {
    throw new Error("Invalid Android association configuration");
  }
  const unique = [...new Set(origins)];
  const fingerprints = unique.map(origin => {
    const encoded = origin.slice("android:apk-key-hash:".length).replaceAll("-", "+").replaceAll("_", "/") + "=";
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    if (bytes.length !== 32) throw new Error("Invalid Android association configuration");
    return [...bytes].map(byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(":");
  });
  return { origins: unique, fingerprints };
}

export function getRegistrationOrigins(
  appOrigin: string | null | undefined,
  androidOrigins: string | null | undefined,
  native: boolean,
): string | string[] {
  const canonical = getRpFromOrigin(appOrigin).expectedOrigin;
  if (!native) return canonical;
  const android = getAndroidAssociations(androidOrigins).origins;
  return android.length ? [canonical, ...android] : canonical;
}
