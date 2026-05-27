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

// SECURITY: DMARC verdict authenticates the header-From, not envelope MAIL FROM.
// Spoofed envelope=owner + DKIM-aligned header-From=attacker (DMARC pass for
// attacker's domain) must NOT relay through the alias.
test("spoofed envelope=owner with DMARC pass on attacker header-From → rejected", async () => {
  const sentinel = { sent: [] as any[] };
  const spoofRaw = `From: Attacker <evil@attacker.com>\r\nTo: ${TO}\r\nSubject: spoof\r\n\r\nbody\r\n`;
  await handleReply(mkMessage("real@me.com", TO, spoofRaw), testEnv(sentinel), PARSED, { spf: "FAIL", dmarc: "PASS" });
  expect(sentinel.sent.length).toBe(0);
});

// Legitimate forwarded reply: SPF on envelope fails (forwarder rewrote it) but
// DMARC PASSES on owner's header-From (DKIM intact) → must still deliver.
test("forwarded owner reply: SPF fail, DMARC pass, header-From=owner → relayed", async () => {
  const sentinel = { sent: [] as any[] };
  const fwdRaw = `From: Me <real@me.com>\r\nTo: ${TO}\r\nSubject: Re: Hi\r\n\r\nfwd body\r\n`;
  await handleReply(mkMessage("forwarder@list.example", TO, fwdRaw), testEnv(sentinel), PARSED, { spf: "FAIL", dmarc: "PASS" });
  expect(sentinel.sent.length).toBe(1);
  expect(sentinel.sent[0].from).toBe("shop@hidemyemail.dev");
});

// Quoted-display-name format must parse correctly.
test('DMARC-pass reply with quoted display name "Real Name" <owner> → relayed', async () => {
  const sentinel = { sent: [] as any[] };
  const quoted = `From: "Real Name" <real@me.com>\r\nTo: ${TO}\r\nSubject: Re: Hi\r\n\r\nbody\r\n`;
  await handleReply(mkMessage("anything@somewhere", TO, quoted), testEnv(sentinel), PARSED, { dmarc: "PASS" });
  expect(sentinel.sent.length).toBe(1);
});

// SECURITY (regression): RFC 5322 quoted-string display-name may contain '<' / '>' / '@'.
// SES will DMARC-align against the real addr-spec (attacker@evil.com); the worker must
// agree. A naïve regex that grabs the first `<addr>` would return the owner address
// embedded inside the quoted display-name and open the alias up as an open relay.
test("SECURITY: quoted display-name embedding <owner> with attacker addr-spec → rejected", async () => {
  const sentinel = { sent: [] as any[] };
  const spoof = `From: "spoof <real@me.com>" <attacker@evil.com>\r\nTo: ${TO}\r\nSubject: spoof\r\n\r\nbody\r\n`;
  await handleReply(mkMessage("attacker@evil.com", TO, spoof), testEnv(sentinel), PARSED, { spf: "PASS", dmarc: "PASS" });
  expect(sentinel.sent.length).toBe(0);
});

// SECURITY (regression): RFC 5322 comment in parentheses may embed an address that
// must NOT be treated as the addr-spec.
test("SECURITY: parenthesised comment embedding <owner> with attacker addr-spec → rejected", async () => {
  const sentinel = { sent: [] as any[] };
  const spoof = `From: (real@me.com legit) <attacker@evil.com>\r\nTo: ${TO}\r\nSubject: spoof\r\n\r\nbody\r\n`;
  await handleReply(mkMessage("attacker@evil.com", TO, spoof), testEnv(sentinel), PARSED, { spf: "PASS", dmarc: "PASS" });
  expect(sentinel.sent.length).toBe(0);
});

// SECURITY (regression): trailing addr-spec is the canonical one per RFC 5322.
test("SECURITY: multiple <addr> tokens → last one wins (rejected when last is attacker)", async () => {
  const sentinel = { sent: [] as any[] };
  const spoof = `From: <real@me.com> spoof <attacker@evil.com>\r\nTo: ${TO}\r\nSubject: spoof\r\n\r\nbody\r\n`;
  await handleReply(mkMessage("attacker@evil.com", TO, spoof), testEnv(sentinel), PARSED, { spf: "PASS", dmarc: "PASS" });
  expect(sentinel.sent.length).toBe(0);
});
