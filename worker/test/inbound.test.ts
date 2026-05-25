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
  const decoded = atob(sentinel.sent[0].rawBase64);
  expect(decoded).toContain(`From: "Alice - alice at store.com" <shop@hidemyemail.dev>`);
  expect(decoded).toContain("Reply-To: shop+alice=store.com@hidemyemail.dev");
  expect(decoded).not.toContain("DKIM-Signature");
  expect((await q.getAlias(DB(), "shop@hidemyemail.dev"))?.fwd_count).toBe(1);
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
  await DB().prepare("UPDATE aliases SET active = 0 WHERE id = ?").bind(a.id).run();
  await handleInbound(mkMessage("alice@store.com", "shop@hidemyemail.dev", RAW), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(0);
});

test("unknown domain → dropped, no SES", async () => {
  const sentinel = { sent: [] as any[] };
  await handleInbound(mkMessage("alice@store.com", "shop@unknown.dev", RAW), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(0);
});
