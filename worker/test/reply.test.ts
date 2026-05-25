import { env } from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import { handleReply } from "../src/email/reply";
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
const TO = "shop+boss=store.com@hidemyemail.dev";
const PARSED = { aliasLocal: "shop", externalSender: "boss@store.com" };
const REPLY_RAW = `From: Me <real@me.com>\r\nTo: ${TO}\r\nSubject: Re: Hi\r\nMessage-ID: <x@gmail.com>\r\n\r\nmy reply\r\n`;

beforeEach(async () => {
  await resetDb(DB());
  await q.createDomain(DB(), "hidemyemail.dev", "real@me.com");
  await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
});

test("owner reply with SPF pass → SES send as alias, leaks stripped", async () => {
  const sentinel = { sent: [] as any[] };
  await handleReply(mkMessage("real@me.com", TO, REPLY_RAW), testEnv(sentinel), PARSED, { spf: "PASS" });
  expect(sentinel.sent.length).toBe(1);
  expect(sentinel.sent[0].from).toBe("shop@hidemyemail.dev");
  expect(sentinel.sent[0].to).toBe("boss@store.com");
  const decoded = atob(sentinel.sent[0].rawBase64);
  expect(decoded).toContain("From: shop@hidemyemail.dev");
  expect(decoded).not.toContain("real@me.com");
  expect(decoded).not.toContain("@gmail.com");
  expect((await q.getAlias(DB(), "shop@hidemyemail.dev"))?.reply_count).toBe(1);
});

test("non-owner reply → rejected, no SES", async () => {
  const sentinel = { sent: [] as any[] };
  await handleReply(mkMessage("attacker@evil.com", TO, REPLY_RAW), testEnv(sentinel), PARSED, { spf: "PASS" });
  expect(sentinel.sent.length).toBe(0);
});

test("owner address but SPF/DMARC fail → rejected, no SES (anti-spoof)", async () => {
  const sentinel = { sent: [] as any[] };
  await handleReply(mkMessage("real@me.com", TO, REPLY_RAW), testEnv(sentinel), PARSED, { spf: "FAIL", dmarc: "FAIL" });
  expect(sentinel.sent.length).toBe(0);
});
