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
  // First-contact rule: a reply is only allowed to an external sender the alias has
  // already heard from. The durable record lives in `contacts` (the reply gate reads
  // it, not `events`); a real forward writes both, so seed both here.
  await q.insertEvent(DB(), { alias_id: 1, type: "forward", external_sender: "boss@store.com", ts: Date.now() });
  await q.recordContact(DB(), 1, "boss@store.com", Date.now());
});

test("expired delivery lease owner cannot complete or release its replacement", async () => {
  const first = await q.claimDelivery(DB(), "sns:lease", "notification", 1_000, "ses:semantic");
  expect(first.status).toBe("claimed");
  if (first.status !== "claimed") throw new Error("first lease not claimed");
  const second = await q.claimDelivery(DB(), "sns:lease", "notification", 1_000 + 5 * 60_000, "ses:semantic");
  expect(second.status).toBe("claimed");
  if (second.status !== "claimed") throw new Error("second lease not claimed");
  await q.completeDelivery(DB(), "sns:lease", first.token, 2_000);
  await q.releaseDelivery(DB(), "sns:lease", first.token);
  expect((await q.claimDelivery(DB(), "sns:lease", "notification", 2_001, "ses:semantic")).status).toBe("busy");
  await q.completeDelivery(DB(), "sns:lease", second.token, 2_002);
  expect((await q.claimDelivery(DB(), "sns:lease", "notification", 2_003, "ses:semantic")).status).toBe("completed");
});

test("expired quota reservation is reclaimed and stale owner cannot release it", async () => {
  const first = await q.reserveMailQuota(DB(), { id: "mail:x", token: "old", kind: "reply", aliasId: 1, recipient: "boss@store.com", now: 1_000, aliasCap: -1, globalCap: -1, distinctCap: -1 });
  expect(first).toBe("reserved");
  const second = await q.reserveMailQuota(DB(), { id: "mail:x", token: "new", kind: "reply", aliasId: 1, recipient: "boss@store.com", now: 1_000 + 5 * 60_000, aliasCap: -1, globalCap: -1, distinctCap: -1 });
  expect(second).toBe("reserved");
  await q.releaseMailQuota(DB(), "mail:x", "old");
  expect(await DB().prepare("SELECT token FROM mail_quota_reservations WHERE id='mail:x'").first<{ token: string }>()).toEqual({ token: "new" });
});

test("accepted reservation with an expired lease still consumes hourly alias and global quota", async () => {
  await DB().prepare("DELETE FROM events").run();
  const now = 2 * 3600_000;
  expect(await q.reserveMailQuota(DB(), { id: "mail:accepted-hour", token: "owner", kind: "reply", aliasId: 1, recipient: "one@example.com", now: now - 30 * 60_000, aliasCap: 1, globalCap: 1, distinctCap: -1 })).toBe("reserved");
  expect(await q.startMailSend(DB(), "mail:accepted-hour", "owner", now - 30 * 60_000)).toBe(true);
  expect(await q.markMailQuotaAccepted(DB(), "mail:accepted-hour", "owner")).toBe(true);
  await DB().prepare("UPDATE mail_quota_reservations SET expires_at=? WHERE id='mail:accepted-hour'").bind(now - 1).run();

  expect(await q.reserveMailQuota(DB(), { id: "mail:alias-blocked", token: "next", kind: "reply", aliasId: 1, recipient: "two@example.com", now, aliasCap: 1, globalCap: -1, distinctCap: -1 })).toBe("cap");
  expect(await q.reserveMailQuota(DB(), { id: "mail:global-blocked", token: "next", kind: "reply", aliasId: 1, recipient: "two@example.com", now, aliasCap: -1, globalCap: 1, distinctCap: -1 })).toBe("cap");
});

test("accepted reservation with an expired lease still consumes daily distinct-recipient quota", async () => {
  await DB().prepare("DELETE FROM events").run();
  const now = 2 * 86400_000;
  expect(await q.reserveMailQuota(DB(), { id: "mail:accepted-day", token: "owner", kind: "reply", aliasId: 1, recipient: "one@example.com", now: now - 12 * 3600_000, aliasCap: -1, globalCap: -1, distinctCap: 1 })).toBe("reserved");
  expect(await q.startMailSend(DB(), "mail:accepted-day", "owner", now - 12 * 3600_000)).toBe(true);
  expect(await q.markMailQuotaAccepted(DB(), "mail:accepted-day", "owner")).toBe(true);
  await DB().prepare("UPDATE mail_quota_reservations SET expires_at=? WHERE id='mail:accepted-day'").bind(now - 1).run();

  expect(await q.reserveMailQuota(DB(), { id: "mail:distinct-blocked", token: "next", kind: "reply", aliasId: 1, recipient: "two@example.com", now, aliasCap: -1, globalCap: -1, distinctCap: 1 })).toBe("cap");
});

test("expired non-accepted reservation does not consume mail quota", async () => {
  await DB().prepare("DELETE FROM events").run();
  const now = 2 * 3600_000;
  expect(await q.reserveMailQuota(DB(), { id: "mail:stale", token: "old", kind: "reply", aliasId: 1, recipient: "one@example.com", now: now - 10 * 60_000, aliasCap: 1, globalCap: 1, distinctCap: 1 })).toBe("reserved");

  expect(await q.reserveMailQuota(DB(), { id: "mail:after-stale", token: "next", kind: "reply", aliasId: 1, recipient: "two@example.com", now, aliasCap: 1, globalCap: 1, distinctCap: 1 })).toBe("reserved");
});

test("quota cleanup retains accepted usage for its full daily window", async () => {
  const now = 2 * 86400_000;
  await DB().prepare("INSERT INTO mail_quota_reservations (id,token,kind,state,alias_id,recipient,created_at,expires_at) VALUES ('mail:keep','token','reply','accepted',1,'one@example.com',?,?)")
    .bind(now - 86400_000 + 1, now - 2 * 86400_000).run();

  await q.claimDelivery(DB(), "cleanup-trigger", "inbound", now);

  expect(await DB().prepare("SELECT state FROM mail_quota_reservations WHERE id='mail:keep'").first()).toEqual({ state: "accepted" });
});

test("abandoned in-flight send can be reclaimed only after its deadline", async () => {
  const first = await q.claimDelivery(DB(), "mail:abandoned", "inbound", 1_000, "ses:abandoned");
  if (first.status !== "claimed") throw new Error("delivery not claimed");
  expect(await q.reserveMailQuota(DB(), {
    id: "mail:abandoned", token: "sender", kind: "forward", aliasId: 1,
    recipient: "sender@example.com", now: 1_000, aliasCap: -1, globalCap: -1, distinctCap: -1,
    deliveryToken: first.token,
  })).toBe("reserved");
  expect(await q.startMailSend(DB(), "mail:abandoned", "sender", 1_000)).toBe(true);
  await DB().prepare("UPDATE mail_deliveries SET lease_until=0 WHERE external_id='mail:abandoned'").run();

  expect((await q.claimDelivery(DB(), "mail:abandoned", "inbound", 2_000, "ses:abandoned")).status).toBe("busy");
  const replacement = await q.claimDelivery(DB(), "mail:abandoned", "inbound", 5 * 60_000 + 1_001, "ses:abandoned");
  expect(replacement.status).toBe("claimed");
  if (replacement.status !== "claimed") throw new Error("delivery not reclaimed");
  expect(await q.reserveMailQuota(DB(), {
    id: "mail:abandoned", token: "replacement", kind: "forward", aliasId: 1,
    recipient: "sender@example.com", now: 5 * 60_000 + 1_001, aliasCap: -1, globalCap: -1, distinctCap: -1,
    deliveryToken: replacement.token,
  })).toBe("reserved");
});

test("delivery is not completed when durable bookkeeping fails after SES", async () => {
  const claim = await q.claimDelivery(DB(), "sns:bookkeeping", "inbound", Date.now(), "ses:bookkeeping");
  expect(claim.status).toBe("claimed");
  await DB().prepare("CREATE TRIGGER fail_reply_event BEFORE INSERT ON events WHEN NEW.type='reply' BEGIN SELECT RAISE(FAIL, 'bookkeeping failed'); END").run();
  const sentinel = { sent: [] as any[] };
  await expect(handleReply(mkMessage("real@me.com", TO, REPLY_RAW), testEnv(sentinel), PARSED, { spf: "PASS" }, { id: "sns:bookkeeping", token: claim.status === "claimed" ? claim.token : "" })).rejects.toThrow("bookkeeping failed");
  expect(sentinel.sent).toHaveLength(1);
  expect((await DB().prepare("SELECT state FROM mail_deliveries WHERE external_id='sns:bookkeeping'").first<{ state: string }>())?.state).toBe("processing");
  expect((await q.getAlias(DB(), "shop@hidemyemail.dev"))?.reply_count).toBe(0);
  await DB().prepare("DROP TRIGGER fail_reply_event").run();
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

test("concurrent replies atomically reserve the final per-alias quota slot", async () => {
  await DB().prepare("INSERT INTO settings (key,value,updated_at) VALUES ('rate_limit_reply_per_alias','1',?) ON CONFLICT(key) DO UPDATE SET value='1'").bind(Date.now()).run();
  const sentinel = { sent: [] as any[] };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const e = { ...testEnv(sentinel), __sesSend: async (_c: any, m: any) => { sentinel.sent.push(m); await gate; return "mid"; } } as any;
  const first = handleReply(mkMessage("real@me.com", TO, REPLY_RAW), e, PARSED, { spf: "PASS" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = handleReply(mkMessage("real@me.com", TO, REPLY_RAW), e, PARSED, { spf: "PASS" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await Promise.all([first, second]);
  expect(sentinel.sent).toHaveLength(1);
  await DB().prepare("UPDATE settings SET value='10' WHERE key='rate_limit_reply_per_alias'").run();
});

test("owner reply rewrites headers without touching MIME body bytes", async () => {
  const sentinel = { sent: [] as any[] };
  const raw = [
    "From: Me <real@me.com>",
    `To: ${TO}`,
    "Subject: Encoded reply",
    "Message-ID: <x@gmail.com>",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    "bXkgcmVwbHkg8J+YgA==",
    "",
  ].join("\r\n");

  await handleReply(mkMessage("real@me.com", TO, raw), testEnv(sentinel), PARSED, { spf: "PASS" });

  const decoded = atob(sentinel.sent[0].rawBase64);
  expect(decoded.split("\r\n\r\n")[1]).toBe("bXkgcmVwbHkg8J+YgA==\r\n");
  expect(decoded).toContain("Content-Transfer-Encoding: base64");
  expect(decoded).toContain("From: shop@hidemyemail.dev");
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

// SECURITY (first-contact): reverse addresses are guessable. An authenticated owner
// could craft a reverse address for a stranger and use the alias as a cold-outbound
// spam relay. Only allow replies to external senders the alias has heard from.
test("SECURITY: owner reply to a stranger with no prior inbound → rejected, no SES", async () => {
  const sentinel = { sent: [] as any[] };
  const strangerTo = "shop+cold=stranger.com@hidemyemail.dev";
  const strangerParsed = { aliasLocal: "shop", externalSender: "cold@stranger.com" };
  const raw = `From: Me <real@me.com>\r\nTo: ${strangerTo}\r\nSubject: cold\r\n\r\nspam\r\n`;
  await handleReply(mkMessage("real@me.com", strangerTo, raw), testEnv(sentinel), strangerParsed, { spf: "PASS" });
  expect(sentinel.sent.length).toBe(0);
  const ev = await DB().prepare("SELECT detail FROM events WHERE type='reject' ORDER BY id DESC LIMIT 1").first<{ detail: string }>();
  expect(ev?.detail).toBe("no_prior_contact");
});

// First-contact is case-insensitive: inbound stored "Boss@Store.com" still authorises
// a reply to "boss@store.com".
test("first-contact match is case-insensitive", async () => {
  await DB().prepare("DELETE FROM events").run();
  await DB().prepare("DELETE FROM contacts").run();
  await q.recordContact(DB(), 1, "Boss@Store.com", Date.now());
  const sentinel = { sent: [] as any[] };
  await handleReply(mkMessage("real@me.com", TO, REPLY_RAW), testEnv(sentinel), PARSED, { spf: "PASS" });
  expect(sentinel.sent.length).toBe(1);
});

// Distinct-recipient cap: an authenticated owner could reply to many strangers (each
// with exactly one prior inbound) and use the alias as a cold-outbound spam relay.
// Cap the number of unique reply recipients per 24h window.

// Helper: seed a prior inbound 'forward' so the first-contact gate passes.
async function seedForward(sender: string) {
  await q.insertEvent(DB(), { alias_id: 1, type: "forward", external_sender: sender, ts: Date.now() });
  await q.recordContact(DB(), 1, sender, Date.now());
}

test("distinct recipient cap: under cap → reply succeeds", async () => {
  // Lower the cap to 2 so we don't need to seed 15 prior senders.
  await DB().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('reply_distinct_recipient_cap', '2', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(Date.now()).run();

  // Seed one prior distinct reply (within window) so we sit at 1/2 distinct.
  await seedForward("other@example.com");
  await q.insertEvent(DB(), { alias_id: 1, type: "reply", external_sender: "other@example.com", ts: Date.now() });

  // Reply to the regularly-seeded boss@store.com (prior inbound already seeded in beforeEach).
  const sentinel = { sent: [] as any[] };
  await handleReply(mkMessage("real@me.com", TO, REPLY_RAW), testEnv(sentinel), PARSED, { spf: "PASS" });
  expect(sentinel.sent.length).toBe(1);
});

test("distinct recipient cap: at cap with new recipient → rejected + alias muted", async () => {
  // Cap of 2; seed 2 distinct reply recipients already in the window.
  await DB().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('reply_distinct_recipient_cap', '2', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(Date.now()).run();

  const now = Date.now();
  await seedForward("alice@example.com");
  await seedForward("bob@example.com");
  await q.insertEvent(DB(), { alias_id: 1, type: "reply", external_sender: "alice@example.com", ts: now });
  await q.insertEvent(DB(), { alias_id: 1, type: "reply", external_sender: "bob@example.com", ts: now });

  // boss@store.com is the new (third) distinct recipient — must be blocked.
  const sentinel = { sent: [] as any[] };
  await handleReply(mkMessage("real@me.com", TO, REPLY_RAW), testEnv(sentinel), PARSED, { spf: "PASS" });
  expect(sentinel.sent.length).toBe(0);

  const ev = await DB().prepare("SELECT detail FROM events WHERE type='reject' ORDER BY id DESC LIMIT 1").first<{ detail: string }>();
  expect(ev?.detail).toBe("distinct_recipient_cap");

  // Alias must now be muted for a future timestamp.
  const alias = await DB().prepare("SELECT muted_until FROM aliases WHERE id = 1").first<{ muted_until: number | null }>();
  expect(alias?.muted_until).toBeGreaterThan(Date.now());
});

test("distinct recipient cap: already-contacted recipient exempted at cap", async () => {
  // Cap of 2; seed boss@store.com itself as one of the 2 already-replied-to recipients.
  await DB().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('reply_distinct_recipient_cap', '2', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(Date.now()).run();

  const now = Date.now();
  await seedForward("alice@example.com");
  // boss@store.com was already seeded via beforeEach; also record a prior reply to it.
  await q.insertEvent(DB(), { alias_id: 1, type: "reply", external_sender: "boss@store.com", ts: now });
  await q.insertEvent(DB(), { alias_id: 1, type: "reply", external_sender: "alice@example.com", ts: now });
  // Distinct count is now 2/2 (boss + alice). Replying again to boss must NOT be blocked.

  const sentinel = { sent: [] as any[] };
  await handleReply(mkMessage("real@me.com", TO, REPLY_RAW), testEnv(sentinel), PARSED, { spf: "PASS" });
  expect(sentinel.sent.length).toBe(1);
});

// Reply rate limit: replies consume SES quota + sender reputation, capped per alias
// per hour (default 10). Inbound forwards do not count against this reply cap.
test("reply rate limit: inbound forwards do not count against per-alias reply cap", async () => {
  const now = Date.now();
  for (let i = 0; i < 12; i++) {
    await q.insertEvent(DB(), { alias_id: 1, type: "forward", external_sender: `sender${i}@example.com`, ts: now });
  }
  const sentinel = { sent: [] as any[] };
  await handleReply(mkMessage("real@me.com", TO, REPLY_RAW), testEnv(sentinel), PARSED, { spf: "PASS" });
  expect(sentinel.sent.length).toBe(1);
});

test("reply rate limit: accepted reservation with expired lease is diagnosed as rate without muting alias", async () => {
  const now = Date.now();
  await DB().prepare("UPDATE settings SET value='1', updated_at=? WHERE key='rate_limit_reply_per_alias'").bind(now).run();
  expect(await q.reserveMailQuota(DB(), {
    id: "mail:accepted-reply", token: "owner", kind: "reply", aliasId: 1,
    recipient: "other@example.com", now: now - 1_000, aliasCap: 1, globalCap: -1, distinctCap: -1,
  })).toBe("reserved");
  expect(await q.startMailSend(DB(), "mail:accepted-reply", "owner", now - 1_000)).toBe(true);
  expect(await q.markMailQuotaAccepted(DB(), "mail:accepted-reply", "owner")).toBe(true);
  await DB().prepare("UPDATE mail_quota_reservations SET expires_at=? WHERE id='mail:accepted-reply'").bind(now - 1).run();

  const sentinel = { sent: [] as any[] };
  await handleReply(mkMessage("real@me.com", TO, REPLY_RAW), testEnv(sentinel), PARSED, { spf: "PASS" });

  expect(sentinel.sent).toHaveLength(0);
  const ev = await DB().prepare("SELECT detail FROM events WHERE type='reject' ORDER BY id DESC LIMIT 1").first<{ detail: string }>();
  expect(ev?.detail).toBe("rate");
  const alias = await DB().prepare("SELECT muted_until FROM aliases WHERE id=1").first<{ muted_until: number | null }>();
  expect(alias?.muted_until).toBeNull();
});

test("reply rate limit: over per-alias cap → rejected, no SES", async () => {
  const now = Date.now();
  for (let i = 0; i < 12; i++) {
    await q.insertEvent(DB(), { alias_id: 1, type: "reply", external_sender: "boss@store.com", ts: now });
  }
  const sentinel = { sent: [] as any[] };
  await handleReply(mkMessage("real@me.com", TO, REPLY_RAW), testEnv(sentinel), PARSED, { spf: "PASS" });
  expect(sentinel.sent.length).toBe(0);
  const ev = await DB().prepare("SELECT detail FROM events WHERE type='reject' ORDER BY id DESC LIMIT 1").first<{ detail: string }>();
  expect(ev?.detail).toBe("rate");
});

// Unified global rate limit: rate_limit_global means total relay volume
// (forward + reply) on BOTH paths, so inbound forwards count toward it here too.
test("reply rate limit: forwards count toward the global cap (unified)", async () => {
  await DB().prepare("DELETE FROM events").run(); // contact for boss@store.com persists
  const now = Date.now();
  await q.insertEvent(DB(), { alias_id: 1, type: "forward", external_sender: "boss@store.com", ts: now });
  await q.insertEvent(DB(), { alias_id: 1, type: "forward", external_sender: "other@store.com", ts: now });
  await DB().prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('rate_limit_global', '2', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(now).run();

  const sentinel = { sent: [] as any[] };
  await handleReply(mkMessage("real@me.com", TO, REPLY_RAW), testEnv(sentinel), PARSED, { spf: "PASS" });
  expect(sentinel.sent.length).toBe(0);
  const ev = await DB().prepare("SELECT detail FROM events WHERE type='reject' ORDER BY id DESC LIMIT 1").first<{ detail: string }>();
  expect(ev?.detail).toBe("rate");
});
