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
const RAW = "From: Alice <alice@store.com>\r\nTo: shop@hidemyemail.dev\r\nSubject: Hi\r\nDKIM-Signature: v=1; x\r\n\r\nhello\r\n";

beforeEach(async () => { await resetDb(DB()); await q.createDomain(DB(), "hidemyemail.dev", "real@me.com"); });

test("clean mail to new alias → SES re-inject with rewritten headers", async () => {
  const sentinel = { sent: [] as any[] };
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(1);
  expect(sentinel.sent[0].from).toBe(`"Alice (alice at store.com)" <shop@hidemyemail.dev>`);
  const decoded = atob(sentinel.sent[0].rawBase64);
  expect(decoded).toContain("Reply-To: shop+alice=store.com@hidemyemail.dev");
  expect(decoded).not.toContain("DKIM-Signature");
  expect((await q.getAlias(DB(), "shop@hidemyemail.dev"))?.fwd_count).toBe(1);
});

test("concurrent inbound forwards atomically reserve the final global quota slot", async () => {
  await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  await DB().prepare("UPDATE settings SET value='1' WHERE key='rate_limit_global'").run();
  const sentinel = { sent: [] as any[] };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const e = { ...testEnv(sentinel), __sesSend: async (_c: any, m: any) => { sentinel.sent.push(m); await gate; return "mid"; } } as any;
  const first = handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), e);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = handleInbound(mkMessage("bob@store.com", "shop@hidemyemail.dev", RAW), e);
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await Promise.all([first, second]);
  expect(sentinel.sent).toHaveLength(1);
});

test("catch-all cannot recreate an alias reserved by another user", async () => {
  await DB().prepare(
    "INSERT INTO identifier_reservations (kind, value, user_id, created_at) VALUES ('alias', 'shop@hidemyemail.dev', 99, 123)"
  ).run();
  const sentinel = { sent: [] as any[] };

  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel));

  expect(sentinel.sent).toHaveLength(0);
  expect(await q.getAlias(DB(), "shop@hidemyemail.dev")).toBeNull();
});

test("clean inbound forwarding rewrites headers without touching MIME body bytes", async () => {
  const sentinel = { sent: [] as any[] };
  const raw = [
    "From: Alice <alice@store.com>",
    "To: shop@hidemyemail.dev",
    "Subject: Encoded",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    "SGVsbG8g8J+YgA==",
    "",
  ].join("\r\n");

  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", raw), testEnv(sentinel));

  const decoded = atob(sentinel.sent[0].rawBase64);
  expect(decoded.split("\r\n\r\n")[1]).toBe("SGVsbG8g8J+YgA==\r\n");
  expect(decoded).toContain("Content-Transfer-Encoding: base64");
  expect(decoded).toContain("Reply-To: shop+alice=store.com@hidemyemail.dev");
});

test("admin-selected From format can include raw sender email", async () => {
  const sentinel = { sent: [] as any[] };
  await DB().prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('forwarded_from_format', 'name_address_parens_at', 0) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run();
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel));
  expect(sentinel.sent[0].from).toBe(`"Alice (alice@store.com)" <shop@hidemyemail.dev>`);
});

test("blocked sender → no SES, block event", async () => {
  const sentinel = { sent: [] as any[] };
  await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  await DB().prepare("INSERT INTO blocks (alias_id, pattern, created_at) VALUES (NULL, '*@store.com', ?)").bind(Date.now()).run();
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(0);
  expect((await q.getAlias(DB(), "shop@hidemyemail.dev"))?.blocked_count).toBe(1);
});

test("disabled alias → no SES", async () => {
  const sentinel = { sent: [] as any[] };
  const a = await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  await DB().prepare("UPDATE aliases SET active = 0 WHERE id = ?").bind(a!.id).run();
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(0);
});

test("quota buffer allows exactly one over-limit auto-created alias", async () => {
  const sentinel = { sent: [] as any[] };
  await DB().prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('max_total_aliases', '2', 0) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run();
  await q.autoCreateAlias(DB(), 1, "one", "one@hidemyemail.dev");
  await q.autoCreateAlias(DB(), 1, "two", "two@hidemyemail.dev");

  await handleInbound(mkMessage("alice@store.com", "three@hidemyemail.dev", RAW.replace("shop@hidemyemail.dev", "three@hidemyemail.dev")), testEnv(sentinel));
  await handleInbound(mkMessage("alice@store.com", "four@hidemyemail.dev", RAW.replace("shop@hidemyemail.dev", "four@hidemyemail.dev")), testEnv(sentinel));

  expect((await q.getAlias(DB(), "three@hidemyemail.dev"))?.source).toBe("auto_over_quota");
  expect(await q.getAlias(DB(), "four@hidemyemail.dev")).toBeNull();
});

test("disabled quota buffer blocks auto-create at admin alias limit", async () => {
  const sentinel = { sent: [] as any[] };
  await DB().prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('max_total_aliases', '2', 0), ('alias_quota_buffer_enabled', 'false', 0) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run();
  await q.autoCreateAlias(DB(), 1, "one", "one@hidemyemail.dev");
  await q.autoCreateAlias(DB(), 1, "two", "two@hidemyemail.dev");

  await handleInbound(mkMessage("alice@store.com", "three@hidemyemail.dev", RAW.replace("shop@hidemyemail.dev", "three@hidemyemail.dev")), testEnv(sentinel));

  expect(await q.getAlias(DB(), "three@hidemyemail.dev")).toBeNull();
  expect(sentinel.sent.length).toBe(1);
  expect(sentinel.sent[0].from).toBe("HideMyEmail <noreply@example.com>");
});

test("quota notification uses MAIN_GLOBAL_DOMAIN env fallback", async () => {
  const sentinel = { sent: [] as any[] };
  await DB().prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('max_total_aliases', '0', 0), ('alias_quota_buffer_enabled', 'false', 0), ('main_global_domain', '', 0) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run();

  await handleInbound(
    mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW),
    { ...testEnv(sentinel), MAIN_GLOBAL_DOMAIN: "hidemyemail.dev" }
  );

  expect(sentinel.sent[0].from).toBe("HideMyEmail <noreply@hidemyemail.dev>");
  expect(atob(sentinel.sent[0].rawBase64)).toContain("https://hidemyemail.dev");
});

test("quota notification escapes recipient address in HTML body", async () => {
  const sentinel = { sent: [] as any[] };
  await DB().prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('max_total_aliases', '0', 0), ('alias_quota_buffer_enabled', 'false', 0) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run();

  await handleInbound(
    mkMessage("alice@store.com", "<img src=x onerror=alert(1)>@hidemyemail.dev", RAW),
    testEnv(sentinel)
  );

  const decoded = atob(sentinel.sent[0].rawBase64);
  const htmlPart = decoded.slice(decoded.indexOf("<!DOCTYPE html>"));
  expect(htmlPart).toContain("&lt;img src=x onerror=alert(1)&gt;@hidemyemail.dev");
  expect(htmlPart).not.toContain("<img src=x onerror=alert(1)>");
});

test("unknown domain → dropped, no SES", async () => {
  const sentinel = { sent: [] as any[] };
  await handleInbound(mkMessage("alice@store.com", "shop@unknown.dev", RAW), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(0);
});

test("per-subdomain catch_all=0 disables auto-create even when global is on", async () => {
  const sentinel = { sent: [] as any[] };
  await DB().prepare("UPDATE domains SET catch_all = 0 WHERE domain = 'hidemyemail.dev'").run();
  await handleInbound(mkMessage("alice@store.com", "fresh@hidemyemail.dev", RAW), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(0);
  expect(await q.getAlias(DB(), "fresh@hidemyemail.dev")).toBeNull();
});

test("per-subdomain catch_all=1 enables auto-create even when global is off", async () => {
  const sentinel = { sent: [] as any[] };
  await DB().prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES " +
    "('catch_all_auto_create', 'false', 0), ('max_total_aliases', '10', 0), ('alias_quota_buffer_enabled', 'true', 0) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run();
  await DB().prepare("UPDATE domains SET catch_all = 1 WHERE domain = 'hidemyemail.dev'").run();
  await handleInbound(mkMessage("alice@store.com", "fresh@hidemyemail.dev", RAW), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(1);
  expect(await q.getAlias(DB(), "fresh@hidemyemail.dev")).not.toBeNull();
});

test("allow rule on alias rejects non-matching sender (allowlist mode)", async () => {
  const sentinel = { sent: [] as any[] };
  const a = await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  await DB().prepare("INSERT INTO blocks (user_id, alias_id, kind, pattern, created_at) VALUES (1, ?, 'allow', 'bank@trusted.com', ?)")
    .bind(a!.id, Date.now()).run();
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(0);
  expect((await q.getAlias(DB(), "shop@hidemyemail.dev"))?.blocked_count).toBe(1);
});

test("allow rule on subdomain permits matching sender", async () => {
  const sentinel = { sent: [] as any[] };
  await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  await DB().prepare("INSERT INTO blocks (user_id, domain_id, kind, pattern, created_at) VALUES (1, 1, 'allow', '*@store.com', ?)")
    .bind(Date.now()).run();
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(1);
});
