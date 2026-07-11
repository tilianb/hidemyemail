import type { Env } from "../types";
import * as q from "../db/queries";
import type { CategoryDevice, PushCategory } from "../db/push";
import { apnsConfig, getProviderToken, sendApns, type ApnsAlert, type ApnsResult } from "./apns";
import { fcmConfig, getAccessToken, sendFcm, type FcmResult } from "./fcm";

// Per-dispatch transport state: each platform's config plus its lazily-minted
// provider credential, so a single dispatch signs/exchanges at most once per
// transport (mirrors how the APNs provider token is reused across a batch).
interface Dispatcher {
  apns: ReturnType<typeof apnsConfig>;
  fcm: ReturnType<typeof fcmConfig>;
  apnsFetch: typeof fetch;
  fcmFetch: typeof fetch;
  jwt: string | null;
  accessToken: string | null;
}

function makeDispatcher(env: Env): Dispatcher {
  return {
    apns: apnsConfig(env),
    fcm: fcmConfig(env),
    apnsFetch: (env as any).__apnsFetch ?? fetch,
    fcmFetch: (env as any).__fcmFetch ?? fetch,
    jwt: null,
    accessToken: null,
  };
}

// Send one alert to one device on its platform's transport, pruning the token
// on the spot if the provider reports it dead (APNs 410 / FCM 404·UNREGISTERED).
// Returns the provider result, or null when that platform isn't configured.
async function sendToDevice(
  env: Env,
  d: Dispatcher,
  device: CategoryDevice,
  alert: ApnsAlert,
  nowSeconds: number,
): Promise<ApnsResult | FcmResult | null> {
  if (device.platform === "android") {
    if (!d.fcm) return null;
    d.accessToken ??= await getAccessToken(d.fcm, nowSeconds, d.fcmFetch);
    const res = await sendFcm(d.fcm, d.accessToken, device.token, alert, d.fcmFetch);
    if (res.dead) await q.prunePushToken(env.DB, device.token);
    return res;
  }
  if (!d.apns) return null;
  d.jwt ??= await getProviderToken(d.apns, nowSeconds);
  const res = await sendApns(d.apns, d.jwt, device.token, alert, d.apnsFetch);
  if (res.dead) await q.prunePushToken(env.DB, device.token);
  return res;
}

// High-level push dispatch. Resolves a user's opted-in devices for the given
// category and sends the alert to each on its platform (APNs for iOS, FCM for
// Android), pruning tokens the provider reports as dead. Best-effort: never
// throws into the mail path — a push failure must never affect delivery.
//
// Tests inject fake fetches via `env.__apnsFetch` / `env.__fcmFetch`.
export async function pushToUser(
  env: Env,
  userId: number,
  category: PushCategory,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  try {
    const d = makeDispatcher(env);
    if (!d.apns && !d.fcm) return; // push not configured → no-op

    const devices = await q.devicesForCategory(env.DB, userId, category);
    if (devices.length === 0) return;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const alert: ApnsAlert = { title, body, data: { category, ...(data ?? {}) } };

    for (const device of devices) {
      try {
        const res = await sendToDevice(env, d, device, alert, nowSeconds);
        if (res && !res.ok && !res.dead) {
          // Kept token (config/auth/topic/transient). Surface the reason so a
          // misconfiguration is debuggable without pruning valid tokens.
          console.warn(`push ${device.platform} ${res.status} ${res.reason ?? ""} — keeping token`);
        }
      } catch (err) {
        console.error(`push send failed (${device.platform})`, err);
      }
    }
  } catch (err) {
    console.error("pushToUser failed", err);
  }
}

// Minimum gap between test pushes per account, so the self-service "send test"
// button can't be held down to spam APNs (and the user's own devices).
const TEST_PUSH_COOLDOWN_MS = 60_000;

export interface TestPushResponse {
  status: number;
  body: {
    ok: boolean;
    // `error` on non-2xx responses (the dashboard surfaces it via its request
    // helper); `reason` on a 200 that simply had nothing to send.
    error?: string;
    reason?: string;
    sent?: number;
    failures?: { token: string; status: number; reason?: string }[];
  };
}

// Send a one-off test alert to every device registered to `userId`. Bypasses
// per-category opt-in so a user can confirm the full push pipeline on either
// platform. Self-scoped (own devices only), rate-limited per account, and
// prunes dead tokens just like the real dispatch path so they don't linger.
export async function sendTestPush(env: Env, userId: number, now: number): Promise<TestPushResponse> {
  const d = makeDispatcher(env);
  if (!d.apns && !d.fcm) return { status: 503, body: { ok: false, error: "Push not configured" } };

  // Per-account cooldown (reuses the rate_limits table, keyed off a synthetic id).
  const key = `pushtest:${userId}`;
  const prior = await env.DB.prepare("SELECT reset_at FROM rate_limits WHERE ip = ?").bind(key).first<{ reset_at: number }>();
  if (prior && prior.reset_at > now) {
    return { status: 429, body: { ok: false, error: "Please wait before sending another test push" } };
  }

  const devices = await q.listPushDevices(env.DB, userId);
  if (devices.length === 0) return { status: 200, body: { ok: false, reason: "No devices registered", sent: 0 } };

  // Commit the cooldown only once we're actually sending a batch.
  await env.DB.prepare(
    "INSERT INTO rate_limits (ip, attempts, reset_at) VALUES (?, 1, ?) " +
    "ON CONFLICT(ip) DO UPDATE SET reset_at = excluded.reset_at"
  ).bind(key, now + TEST_PUSH_COOLDOWN_MS).run();

  const nowSeconds = Math.floor(now / 1000);
  const alert: ApnsAlert = { title: "HideMyEmail", body: "Test push notification" };
  let sent = 0;
  const failures: { token: string; status: number; reason?: string }[] = [];
  for (const dev of devices) {
    try {
      const res = await sendToDevice(env, d, { token: dev.token, platform: dev.platform }, alert, nowSeconds);
      if (!res) {
        // The device's platform transport isn't configured on this Worker.
        failures.push({ token: dev.token, status: 503, reason: `${dev.platform} push not configured` });
        continue;
      }
      if (res.ok) { sent++; continue; }
      // sendToDevice already pruned the token if it was dead.
      failures.push({ token: dev.token, status: res.status, reason: res.reason });
    } catch {
      /* transient network error mid-send; leave the token for the next dispatch */
    }
  }
  return { status: 200, body: { ok: true, sent, failures } };
}

// Shorten a possibly-empty subject for a notification body.
function subjectTail(subject?: string | null): string {
  const s = (subject ?? "").trim();
  if (!s) return "";
  const clipped = s.length > 80 ? `${s.slice(0, 77)}…` : s;
  return ` — “${clipped}”`;
}

// --- Event-shaped helpers (keep notification copy in one place) ---

export async function pushBlocked(env: Env, userId: number, aliasAddress: string, sender: string): Promise<void> {
  await pushToUser(env, userId, "blocked",
    "Mail blocked",
    `A message to ${aliasAddress} from ${sender} was blocked.`,
    { alias: aliasAddress });
}

export async function pushForward(env: Env, userId: number, aliasAddress: string, sender: string, subject?: string | null): Promise<void> {
  await pushToUser(env, userId, "forward",
    aliasAddress,
    `Forwarded a message from ${sender}${subjectTail(subject)}.`,
    { alias: aliasAddress });
}

export async function pushReply(env: Env, userId: number, aliasAddress: string, recipient: string, subject?: string | null): Promise<void> {
  await pushToUser(env, userId, "reply",
    "Reply sent",
    `Your reply from ${aliasAddress} to ${recipient}${subjectTail(subject)} was delivered.`,
    { alias: aliasAddress });
}

export async function pushSuppression(
  env: Env,
  userId: number,
  reason: "complaint" | "hard_bounce" | "soft_bounce",
): Promise<void> {
  const body = reason === "complaint"
    ? "A destination was paused after a spam complaint. Forwarding to it has stopped."
    : reason === "hard_bounce"
      ? "A destination was paused after a permanent delivery failure. Forwarding to it has stopped."
      : "A destination was paused after repeated temporary failures. Forwarding to it has stopped.";
  await pushToUser(env, userId, "bounce", "Destination paused", body);
}
