import type { Env } from "../types";
import * as q from "../db/queries";
import type { PushCategory } from "../db/push";
import { apnsConfig, getProviderToken, sendApns } from "./apns";

// High-level push dispatch. Resolves a user's opted-in device tokens for the
// given category, sends the alert to each, and prunes any tokens APNs reports
// as dead. Best-effort: never throws into the mail path — a push failure must
// never affect delivery.
//
// Tests inject a fake fetch via `env.__apnsFetch` (mirrors `__sesSend`).
export async function pushToUser(
  env: Env,
  userId: number,
  category: PushCategory,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  try {
    const cfg = apnsConfig(env);
    if (!cfg) return; // push not configured → no-op

    const tokens = await q.tokensForCategory(env.DB, userId, category);
    if (tokens.length === 0) return;

    const doFetch: typeof fetch = (env as any).__apnsFetch ?? fetch;
    const jwt = await getProviderToken(cfg, Math.floor(Date.now() / 1000));
    const alert = { title, body, data: { category, ...(data ?? {}) } };

    for (const token of tokens) {
      try {
        const res = await sendApns(cfg, jwt, token, alert, doFetch);
        if (res.dead) {
          await q.prunePushToken(env.DB, token);
        } else if (!res.ok) {
          // Likely an environment/topic mismatch (wrong APNS_HOST/BUNDLE_ID).
          // Keep the token; surface the reason so misconfig is debuggable.
          console.warn(`APNs ${res.status} ${res.reason ?? ""} — keeping token`);
        }
      } catch (err) {
        console.error("APNs send failed", err);
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
// per-category opt-in so a user can confirm the full APNs pipeline. Self-scoped
// (own devices only), rate-limited per account, and prunes 410/Unregistered
// tokens just like the real dispatch path so a dead device doesn't linger.
export async function sendTestPush(env: Env, userId: number, now: number): Promise<TestPushResponse> {
  const cfg = apnsConfig(env);
  if (!cfg) return { status: 503, body: { ok: false, error: "APNs not configured" } };

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

  const doFetch: typeof fetch = (env as any).__apnsFetch ?? fetch;
  const jwt = await getProviderToken(cfg, Math.floor(now / 1000));
  const alert = { title: "HideMyEmail", body: "Test push notification" };
  let sent = 0;
  const failures: { token: string; status: number; reason?: string }[] = [];
  for (const dev of devices) {
    try {
      const res = await sendApns(cfg, jwt, dev.token, alert, doFetch);
      if (res.ok) { sent++; continue; }
      failures.push({ token: dev.token, status: res.status, reason: res.reason });
      if (res.dead) await q.prunePushToken(env.DB, dev.token); // 410/Unregistered → prune
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
