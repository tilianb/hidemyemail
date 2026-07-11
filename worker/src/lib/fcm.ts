import type { Env } from "../types";
import { fromBase64, toBase64, utf8 } from "./bytes";
import type { ApnsAlert } from "./apns";

// FCM HTTP v1 sender for Android push. Unlike APNs (a per-request ES256 JWT),
// FCM v1 uses a Google service account: we mint a short-lived RS256 JWT, trade
// it for an OAuth2 access token, then POST messages with that bearer token.
// Cloudflare's fetch handles the HTTPS calls to googleapis.com.

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string; // service-account private key (PEM)
  tokenUri: string;   // OAuth2 token endpoint
}

// FCM result mirrors ApnsResult so the dispatcher can treat both uniformly.
export interface FcmResult {
  ok: boolean;
  status: number;
  // True only when FCM definitively reports the token as gone: HTTP 404 or an
  // `UNREGISTERED` / `NOT_FOUND` error status (app uninstalled, token rotated).
  // Other failures (auth, quota, transient) keep the token.
  dead: boolean;
  reason?: string;
}

// Resolve config from env. `FCM_SERVICE_ACCOUNT` is the full service-account
// JSON (a secret); `FCM_PROJECT_ID` overrides the project id if needed. Returns
// null when push is not configured or the JSON is unusable — callers then
// treat Android push as a no-op, exactly like the APNs path.
export function fcmConfig(env: Env): FcmConfig | null {
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  let sa: { project_id?: string; client_email?: string; private_key?: string; token_uri?: string };
  try {
    sa = JSON.parse(raw);
  } catch {
    console.warn("FCM_SERVICE_ACCOUNT is not valid JSON — Android push disabled");
    return null;
  }
  const projectId = env.FCM_PROJECT_ID || sa.project_id;
  const clientEmail = sa.client_email;
  const privateKey = sa.private_key;
  if (!projectId || !clientEmail || !privateKey) return null;
  return {
    projectId,
    clientEmail,
    privateKey,
    tokenUri: sa.token_uri || "https://oauth2.googleapis.com/token",
  };
}

function base64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Import the RSA private key from the service-account PEM (PKCS#8 DER, base64).
async function importSigningKey(privateKey: string): Promise<CryptoKey> {
  const der = fromBase64(privateKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  return crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
}

// Mint the service-account assertion JWT used to request an access token.
async function buildAssertion(cfg: FcmConfig, nowSeconds: number): Promise<string> {
  const header = base64url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64url(utf8(JSON.stringify({
    iss: cfg.clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: cfg.tokenUri,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  })));
  const signingInput = `${header}.${claims}`;
  const key = await importSigningKey(cfg.privateKey);
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, utf8(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

// Access-token cache. Google tokens last ~1h; we reuse for 50 minutes. Module
// global (per isolate) — best-effort, but collapses the per-dispatch token
// exchange. Mirrors the APNs provider-token cache.
const ACCESS_TOKEN_TTL_SECONDS = 50 * 60;
let cachedAccessToken: { key: string; token: string; iat: number } | null = null;

// Get an OAuth2 access token, reusing a recent one for the same service account.
export async function getAccessToken(cfg: FcmConfig, nowSeconds: number, doFetch: typeof fetch = fetch): Promise<string> {
  const key = cfg.clientEmail;
  if (cachedAccessToken
      && cachedAccessToken.key === key
      && nowSeconds - cachedAccessToken.iat < ACCESS_TOKEN_TTL_SECONDS) {
    return cachedAccessToken.token;
  }
  const assertion = await buildAssertion(cfg, nowSeconds);
  const res = await doFetch(cfg.tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (res.status !== 200) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch { /* no body */ }
    throw new Error(`FCM token exchange failed: ${res.status} ${detail}`);
  }
  const data = await res.json<{ access_token?: string }>();
  if (!data.access_token) throw new Error("FCM token exchange returned no access_token");
  cachedAccessToken = { key, token: data.access_token, iat: nowSeconds };
  return data.access_token;
}

// Test hook: drop the cached access token so a test starts cold.
export function __clearAccessTokenCache(): void {
  cachedAccessToken = null;
}

export async function sendFcm(
  cfg: FcmConfig,
  accessToken: string,
  token: string,
  alert: ApnsAlert,
  doFetch: typeof fetch = fetch,
): Promise<FcmResult> {
  // FCM data values must all be strings.
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(alert.data ?? {})) data[k] = String(v);

  const res = await doFetch(`https://fcm.googleapis.com/v1/projects/${cfg.projectId}/messages:send`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: alert.title, body: alert.body },
        ...(Object.keys(data).length ? { data } : {}),
        android: { priority: "high" },
      },
    }),
  });

  if (res.status === 200) return { ok: true, status: 200, dead: false };

  let reason: string | undefined;
  let errorStatus: string | undefined;
  try {
    const body = await res.json<{ error?: { message?: string; status?: string } }>();
    reason = body?.error?.message;
    errorStatus = body?.error?.status;
  } catch { /* no body */ }
  // Only a definitively-gone token is pruned. Everything else (auth, quota,
  // transient) keeps the token, mirroring the APNs "only 410 prunes" stance.
  const dead = res.status === 404 || errorStatus === "UNREGISTERED" || errorStatus === "NOT_FOUND";
  return { ok: false, status: res.status, dead, reason };
}
