/**
 * SES receipt verdict handling (spam/virus) and the unsubscribe header mode.
 *
 *  - spam_verdict_action:  forward | flag (default) | drop
 *  - virus_verdict_action: forward | flag | drop (default)
 *  - unsubscribe_header_mode: always | bulk_only (default) | never
 *  - Authentication-Results is re-emitted under X-HideMyEmail-Authentication-Results
 */

import { env } from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import { handleInbound } from "../src/email/inbound";
import * as q from "../src/db/queries";
import { utf8 } from "../src/lib/bytes";
import { resetDb } from "./helpers";

const DB = () => env.DB as D1Database;

function mkMessage(from: string, to: string, raw: string) {
  return { from, to, headers: new Headers(), raw: new Response(raw).body!, rawSize: utf8(raw).length,
    setReject: vi.fn(), forward: vi.fn(), reply: vi.fn() } as unknown as ForwardableEmailMessage;
}
function testEnv(sentinel: { sent: any[] }) {
  return { ...env, SES_ACCESS_KEY_ID: "AKIA", SES_SECRET_ACCESS_KEY: "s", SES_REGION: "us-east-1",
    __sesSend: async (_c: any, m: any) => { sentinel.sent.push(m); return "mid"; } } as any;
}
async function setSetting(key: string, value: string) {
  await DB().prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(key, value).run();
}
async function lastEvent() {
  return DB().prepare("SELECT type, detail FROM events ORDER BY id DESC LIMIT 1")
    .first<{ type: string; detail: string | null }>();
}

const RAW = "From: Alice <alice@store.com>\r\nTo: shop@hidemyemail.dev\r\nSubject: Hi\r\n\r\nhello\r\n";
const RAW_BULK =
  "From: News <news@store.com>\r\nTo: shop@hidemyemail.dev\r\nSubject: Deals\r\n" +
  "List-Unsubscribe: <https://store.com/unsub>\r\n\r\nbuy things\r\n";

beforeEach(async () => { await resetDb(DB()); await q.createDomain(DB(), "hidemyemail.dev", "real@me.com"); });

// ── spam verdict ────────────────────────────────────────────────────────────

test("spam FAIL with default action → forwarded with X-Spam-Flag", async () => {
  const sentinel = { sent: [] as any[] };
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel), { spam: "FAIL" });
  expect(sentinel.sent.length).toBe(1);
  expect(atob(sentinel.sent[0].rawBase64)).toContain("X-Spam-Flag: YES");
});

test("spam FAIL with action=drop → no SES send, reject event 'spam'", async () => {
  const sentinel = { sent: [] as any[] };
  await setSetting("spam_verdict_action", "drop");
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel), { spam: "FAIL" });
  expect(sentinel.sent.length).toBe(0);
  expect(await lastEvent()).toMatchObject({ type: "reject", detail: "spam" });
});

test("spam FAIL with action=forward → forwarded without X-Spam-Flag", async () => {
  const sentinel = { sent: [] as any[] };
  await setSetting("spam_verdict_action", "forward");
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel), { spam: "FAIL" });
  expect(sentinel.sent.length).toBe(1);
  expect(atob(sentinel.sent[0].rawBase64)).not.toContain("X-Spam-Flag");
});

test("spam GRAY passes through untouched", async () => {
  const sentinel = { sent: [] as any[] };
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel), { spam: "GRAY" });
  expect(sentinel.sent.length).toBe(1);
  expect(atob(sentinel.sent[0].rawBase64)).not.toContain("X-Spam-Flag");
});

// ── virus verdict ───────────────────────────────────────────────────────────

test("virus FAIL with default action → dropped, reject event 'virus'", async () => {
  const sentinel = { sent: [] as any[] };
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel), { virus: "FAIL" });
  expect(sentinel.sent.length).toBe(0);
  expect(await lastEvent()).toMatchObject({ type: "reject", detail: "virus" });
});

test("virus FAIL with action=flag → forwarded with X-HideMyEmail-Virus", async () => {
  const sentinel = { sent: [] as any[] };
  await setSetting("virus_verdict_action", "flag");
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel), { virus: "FAIL" });
  expect(sentinel.sent.length).toBe(1);
  expect(atob(sentinel.sent[0].rawBase64)).toContain("X-HideMyEmail-Virus: detected");
});

test("no verdicts at all (legacy caller) → forwarded normally", async () => {
  const sentinel = { sent: [] as any[] };
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(1);
});

// ── unsubscribe header mode ─────────────────────────────────────────────────

test("bulk_only (default): person-to-person forward carries no List-Unsubscribe", async () => {
  const sentinel = { sent: [] as any[] };
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel));
  expect(atob(sentinel.sent[0].rawBase64)).not.toContain("List-Unsubscribe");
});

test("bulk_only (default): bulk mail gets our one-click unsubscribe", async () => {
  const sentinel = { sent: [] as any[] };
  await handleInbound(mkMessage("news@store.com", "shop@hidemyemail.dev", RAW_BULK), testEnv(sentinel));
  const decoded = atob(sentinel.sent[0].rawBase64);
  expect(decoded).toContain("List-Unsubscribe: <mailto:action+disable=");
  expect(decoded).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  expect(decoded).not.toContain("https://store.com/unsub");
});

test("bulk_only: Precedence: bulk also counts as bulk mail", async () => {
  const sentinel = { sent: [] as any[] };
  const raw = "From: a <a@store.com>\r\nTo: shop@hidemyemail.dev\r\nSubject: x\r\nPrecedence: bulk\r\n\r\nhi\r\n";
  await handleInbound(mkMessage("a@store.com", "shop@hidemyemail.dev", raw), testEnv(sentinel));
  expect(atob(sentinel.sent[0].rawBase64)).toContain("List-Unsubscribe: <mailto:action+disable=");
});

test("always: person-to-person forward gets our unsubscribe header", async () => {
  const sentinel = { sent: [] as any[] };
  await setSetting("unsubscribe_header_mode", "always");
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel));
  expect(atob(sentinel.sent[0].rawBase64)).toContain("List-Unsubscribe: <mailto:action+disable=");
});

test("never: bulk mail keeps the original List-Unsubscribe, not ours", async () => {
  const sentinel = { sent: [] as any[] };
  await setSetting("unsubscribe_header_mode", "never");
  await handleInbound(mkMessage("news@store.com", "shop@hidemyemail.dev", RAW_BULK), testEnv(sentinel));
  const decoded = atob(sentinel.sent[0].rawBase64);
  expect(decoded).toContain("https://store.com/unsub");
  expect(decoded).not.toContain("action+disable=");
});

// ── Authentication-Results rename ───────────────────────────────────────────

test("Authentication-Results is re-emitted under our own header name", async () => {
  const sentinel = { sent: [] as any[] };
  const raw =
    "From: Alice <alice@store.com>\r\nTo: shop@hidemyemail.dev\r\nSubject: Hi\r\n" +
    "Authentication-Results: amazonses.com; spf=pass\r\n\r\nhello\r\n";
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", raw), testEnv(sentinel));
  const decoded = atob(sentinel.sent[0].rawBase64);
  expect(decoded).toContain("X-HideMyEmail-Authentication-Results: amazonses.com; spf=pass");
  expect(decoded).not.toMatch(/\r\nAuthentication-Results:/);
});
