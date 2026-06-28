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
        if (res.dead) await q.prunePushToken(env.DB, token);
      } catch (err) {
        console.error("APNs send failed", err);
      }
    }
  } catch (err) {
    console.error("pushToUser failed", err);
  }
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
