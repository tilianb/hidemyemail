import type { Env } from "../types";
import { fromBase64, toBase64, utf8 } from "./bytes";

// Token-based APNs (HTTP/2) sender. We sign a short-lived ES256 provider JWT
// with the .p8 key and POST the alert. Cloudflare's fetch negotiates HTTP/2 to
// api.push.apple.com, which is what APNs requires.

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  authKey: string;   // .p8 PEM contents
  bundleId: string;  // apns-topic
  host: string;      // e.g. api.push.apple.com
}

export interface ApnsAlert {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface ApnsResult {
  ok: boolean;
  status: number;
  // True when APNs says the token is dead and should be pruned (410, or a
  // 400/403 with an Unregistered/BadDeviceToken reason).
  dead: boolean;
  reason?: string;
}

// Resolve config from env, deriving teamId/bundleId from APPLE_APP_ID
// ("<TeamID>.<bundleId>") when the dedicated vars are not set. Returns null when
// push is not configured — callers then no-op.
export function apnsConfig(env: Env): ApnsConfig | null {
  const authKey = env.APNS_AUTH_KEY;
  const keyId = env.APNS_KEY_ID;
  if (!authKey || !keyId) return null;

  let teamId = env.APNS_TEAM_ID;
  let bundleId = env.APNS_BUNDLE_ID;
  if ((!teamId || !bundleId) && env.APPLE_APP_ID) {
    const dot = env.APPLE_APP_ID.indexOf(".");
    if (dot > 0) {
      teamId = teamId || env.APPLE_APP_ID.slice(0, dot);
      bundleId = bundleId || env.APPLE_APP_ID.slice(dot + 1);
    }
  }
  if (!teamId || !bundleId) return null;

  return { keyId, teamId, authKey, bundleId, host: env.APNS_HOST || "api.push.apple.com" };
}

function base64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Import the EC P-256 private key from the .p8 PEM body (PKCS#8 DER, base64).
async function importSigningKey(authKey: string): Promise<CryptoKey> {
  const der = fromBase64(authKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  return crypto.subtle.importKey(
    "pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
}

// Mint a provider JWT. APNs accepts these for up to an hour; we mint one per
// dispatch (reused across that dispatch's tokens) which keeps signing cheap
// without risking the "too many provider token updates" 429.
export async function buildProviderToken(cfg: ApnsConfig, nowSeconds: number): Promise<string> {
  const header = base64url(utf8(JSON.stringify({ alg: "ES256", kid: cfg.keyId })));
  const claims = base64url(utf8(JSON.stringify({ iss: cfg.teamId, iat: nowSeconds })));
  const signingInput = `${header}.${claims}`;
  const key = await importSigningKey(cfg.authKey);
  // WebCrypto ECDSA returns the raw r||s concatenation — already JOSE format.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

export async function sendApns(
  cfg: ApnsConfig,
  jwt: string,
  token: string,
  alert: ApnsAlert,
  doFetch: typeof fetch = fetch,
): Promise<ApnsResult> {
  const payload = {
    aps: { alert: { title: alert.title, body: alert.body }, sound: "default" },
    ...(alert.data ?? {}),
  };
  const res = await doFetch(`https://${cfg.host}/3/device/${token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": cfg.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 200) return { ok: true, status: 200, dead: false };

  let reason: string | undefined;
  try { reason = (await res.json<{ reason?: string }>())?.reason; } catch { /* no body */ }
  const dead = res.status === 410
    || reason === "Unregistered"
    || reason === "BadDeviceToken"
    || reason === "DeviceTokenNotForTopic";
  return { ok: false, status: res.status, dead, reason };
}
