import { env } from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import { handleReply } from "../src/email/reply";
import * as q from "../src/db/queries";
import { getOrCreateReverse } from "../src/lib/reverse";
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
const REPLY_RAW = "From: Me <real@me.com>\r\nTo: shop+TOKEN@hidemyemail.dev\r\nSubject: Re: Hi\r\nMessage-ID: <x@gmail.com>\r\n\r\nmy reply\r\n";

beforeEach(async () => { await resetDb(DB()); await q.createDomain(DB(), "hidemyemail.dev", "real@me.com"); });

test("owner reply → SES send as alias, leaks stripped", async () => {
  const sentinel = { sent: [] as any[] };
  const a = await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  const rev = await getOrCreateReverse(DB(), a.id, "boss@store.com");
  const raw = REPLY_RAW.replace("TOKEN", rev.token);
  await handleReply(mkMessage("real@me.com", `shop+${rev.token}@hidemyemail.dev`, raw), testEnv(sentinel), rev.token);
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
  const a = await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  const rev = await getOrCreateReverse(DB(), a.id, "boss@store.com");
  const raw = REPLY_RAW.replace("TOKEN", rev.token).replace("real@me.com", "attacker@evil.com");
  await handleReply(mkMessage("attacker@evil.com", `shop+${rev.token}@hidemyemail.dev`, raw), testEnv(sentinel), rev.token);
  expect(sentinel.sent.length).toBe(0);
});
