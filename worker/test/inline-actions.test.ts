import { env } from "cloudflare:test";
import { beforeEach, expect, test, vi } from "vitest";
import { signAction, handleAction, encodeSender } from "../src/email/action";
import { handleInbound } from "../src/email/inbound";
import * as q from "../src/db/queries";
import { utf8 } from "../src/lib/bytes";
import { encryptDestination } from "../src/lib/crypto";
import { resetDb } from "./helpers";
import type { Env } from "../src/types";

const DB = () => env.DB as D1Database;
const KEY = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=";

function mkMessage(from: string, to: string, raw = "") {
  return {
    from, to, headers: new Headers(), raw: new Response(raw).body!, rawSize: utf8(raw).length,
    setReject: vi.fn(), forward: vi.fn(), reply: vi.fn(),
  } as unknown as ForwardableEmailMessage;
}
function testEnv(sentinel: { sent: any[] }) {
  return {
    ...env, SES_ACCESS_KEY_ID: "AKIA", SES_SECRET_ACCESS_KEY: "s", SES_REGION: "us-east-1",
    __sesSend: async (_c: any, m: any) => { sentinel.sent.push(m); return "mid"; },
  } as any;
}

beforeEach(async () => {
  await resetDb(DB());
  const encDest = await encryptDestination("real@me.com", KEY);
  await DB().prepare(
    "INSERT INTO domains (domain, default_destination, active, created_at) VALUES (?,?,1,?)"
  ).bind("hidemyemail.dev", encDest, Date.now()).run();
});

test("signAction signatures isolated across verbs", async () => {
  const e = { SESSION_SECRET: "s", DESTINATION_ENCRYPTION_KEY: "k" } as Env;
  const disableSig = await signAction("disable", "42", e);
  const blockSig = await signAction("block", "42", e);
  const muteSig = await signAction("mute7", "42", e);
  expect(new Set([disableSig, blockSig, muteSig]).size).toBe(3);
});

test("signAction backwards-compat: number payload produces same sig as String(number)", async () => {
  const e = { SESSION_SECRET: "s", DESTINATION_ENCRYPTION_KEY: "k" } as Env;
  expect(await signAction("disable", 42, e)).toBe(await signAction("disable", "42", e));
});

test("block verb adds sender to alias block list", async () => {
  const a = await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  const e = { ...env, DESTINATION_ENCRYPTION_KEY: KEY } as any;
  const encSender = encodeSender("spammer@bad.com");
  const sig = await signAction("block", `${a!.id}:${encSender}`, e);
  await handleAction(mkMessage("spammer@bad.com", `action+block=${a!.id}_${encSender}_${sig}@hidemyemail.dev`),
    e, "block", `${a!.id}_${encSender}_${sig}`);
  const rows = await DB().prepare("SELECT pattern FROM blocks WHERE alias_id = ?").bind(a!.id).all<{ pattern: string }>();
  expect(rows.results?.[0]?.pattern).toBe("spammer@bad.com");
});

test("block verb rejects forged sender (sig bound to encoded sender)", async () => {
  const a = await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  const e = { ...env, DESTINATION_ENCRYPTION_KEY: KEY } as any;
  const realSender = encodeSender("spammer@bad.com");
  const sig = await signAction("block", `${a!.id}:${realSender}`, e);
  const forgedSender = encodeSender("victim@example.com");
  await handleAction(mkMessage("victim@example.com", `action+block=${a!.id}_${forgedSender}_${sig}@hidemyemail.dev`),
    e, "block", `${a!.id}_${forgedSender}_${sig}`);
  const rows = await DB().prepare("SELECT COUNT(*) AS c FROM blocks WHERE alias_id = ?").bind(a!.id).first<{ c: number }>();
  expect(rows?.c).toBe(0);
});

test("mute7 sets muted_until ~7d in the future", async () => {
  const a = await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  const e = { ...env, DESTINATION_ENCRYPTION_KEY: KEY } as any;
  const sig = await signAction("mute7", String(a!.id), e);
  const before = Date.now();
  await handleAction(mkMessage("x@y.com", "action+...@hidemyemail.dev"), e, "mute7", `${a!.id}_${sig}`);
  const row = await DB().prepare("SELECT muted_until FROM aliases WHERE id = ?").bind(a!.id).first<{ muted_until: number }>();
  const delta = row!.muted_until - before;
  expect(delta).toBeGreaterThan(7 * 24 * 3600_000 - 1000);
  expect(delta).toBeLessThan(7 * 24 * 3600_000 + 1000);
});

test("muted alias drops inbound forwards", async () => {
  const a = await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  await DB().prepare("UPDATE aliases SET muted_until = ? WHERE id = ?")
    .bind(Date.now() + 3600_000, a!.id).run();
  const sentinel = { sent: [] as any[] };
  const raw = "From: x@y.com\r\nTo: shop@hidemyemail.dev\r\n\r\nhi\r\n";
  await handleInbound(mkMessage("x@y.com", "shop@hidemyemail.dev", raw), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(0);
  const ev = await DB().prepare("SELECT detail FROM events WHERE alias_id = ? ORDER BY id DESC LIMIT 1")
    .bind(a!.id).first<{ detail: string }>();
  expect(ev?.detail).toBe("muted");
});

test("expired mute lets forward through", async () => {
  const a = await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  await DB().prepare("UPDATE aliases SET muted_until = ? WHERE id = ?")
    .bind(Date.now() - 1000, a!.id).run();
  const sentinel = { sent: [] as any[] };
  const raw = "From: x@y.com\r\nTo: shop@hidemyemail.dev\r\n\r\nhi\r\n";
  await handleInbound(mkMessage("x@y.com", "shop@hidemyemail.dev", raw), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(1);
});

test("route verb rejects destination not owned by alias user", async () => {
  const a = await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  await DB().prepare("INSERT INTO users (id, passphrase_hash, created_at) VALUES (99, 'other-hash', ?)").bind(Date.now()).run();
  const encDest = await encryptDestination("other@x.com", KEY);
  await DB().prepare(
    "INSERT INTO destinations (id, user_id, email, email_hash, token, verified_at, created_at) VALUES (777, 99, ?, 'h99', 'tok99', ?, ?)"
  ).bind(encDest, Date.now(), Date.now()).run();
  const e = { ...env, DESTINATION_ENCRYPTION_KEY: KEY } as any;
  const sig = await signAction("route", `${a!.id}:777`, e);
  await handleAction(mkMessage("x@y.com", "action+...@hidemyemail.dev"), e, "route", `${a!.id}_777_${sig}`);
  const row = await DB().prepare("SELECT destination FROM aliases WHERE id = ?").bind(a!.id).first<{ destination: string | null }>();
  expect(row?.destination).toBeNull();
});

test("route verb succeeds for owned + verified destination", async () => {
  const a = await q.autoCreateAlias(DB(), 1, "shop", "shop@hidemyemail.dev");
  const encDest = await encryptDestination("primary@me.com", KEY);
  await DB().prepare(
    "INSERT INTO destinations (id, user_id, email, email_hash, token, verified_at, created_at) VALUES (123, 1, ?, 'h123', 'tok123', ?, ?)"
  ).bind(encDest, Date.now(), Date.now()).run();
  const e = { ...env, DESTINATION_ENCRYPTION_KEY: KEY } as any;
  const sig = await signAction("route", `${a!.id}:123`, e);
  await handleAction(mkMessage("x@y.com", "action+...@hidemyemail.dev"), e, "route", `${a!.id}_123_${sig}`);
  const row = await DB().prepare("SELECT destination FROM aliases WHERE id = ?").bind(a!.id).first<{ destination: string | null }>();
  expect(row?.destination).not.toBeNull();
});

test("toolbar appears when user pref = on (footer default)", async () => {
  await DB().prepare("UPDATE users SET inline_actions_pref = 'on' WHERE id = 1").run();
  const sentinel = { sent: [] as any[] };
  const raw = "From: x@y.com\r\nTo: shop@hidemyemail.dev\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\nhello world\r\n";
  await handleInbound(mkMessage("x@y.com", "shop@hidemyemail.dev", raw), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(1);
  const decoded = atob(sentinel.sent[0].rawBase64);
  expect(decoded).toContain("X-HideMyEmail-Actions: footer");
  expect(decoded).toContain("action+block=");
  expect(decoded).toContain("action+mute7=");
  expect(decoded).toContain("action+disable=");
});

test("toolbar absent when user pref = off and global default = false", async () => {
  await DB().prepare("UPDATE users SET inline_actions_pref = 'off' WHERE id = 1").run();
  const sentinel = { sent: [] as any[] };
  const raw = "From: x@y.com\r\nTo: shop@hidemyemail.dev\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\nhello world\r\n";
  await handleInbound(mkMessage("x@y.com", "shop@hidemyemail.dev", raw), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(1);
  const decoded = atob(sentinel.sent[0].rawBase64);
  expect(decoded).not.toContain("X-HideMyEmail-Actions");
  expect(decoded).not.toContain("action+block=");
});

test("toolbar absent when user pref = null (inherit) and global default = false", async () => {
  await DB().prepare("UPDATE users SET inline_actions_pref = NULL WHERE id = 1").run();
  const sentinel = { sent: [] as any[] };
  const raw = "From: x@y.com\r\nTo: shop@hidemyemail.dev\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\nhello world\r\n";
  await handleInbound(mkMessage("x@y.com", "shop@hidemyemail.dev", raw), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(1);
  expect(atob(sentinel.sent[0].rawBase64)).not.toContain("X-HideMyEmail-Actions");
});

test("toolbar appears when user pref = null (inherit) and global default = true", async () => {
  await DB().prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('inline_actions_default_enabled', 'true', 0) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run();
  await DB().prepare("UPDATE users SET inline_actions_pref = NULL WHERE id = 1").run();
  const sentinel = { sent: [] as any[] };
  const raw = "From: x@y.com\r\nTo: shop@hidemyemail.dev\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\nhello world\r\n";
  await handleInbound(mkMessage("x@y.com", "shop@hidemyemail.dev", raw), testEnv(sentinel));
  expect(atob(sentinel.sent[0].rawBase64)).toContain("X-HideMyEmail-Actions: footer");
});

test("toolbar position = header places bar above body", async () => {
  await DB().prepare("UPDATE users SET inline_actions_pref = 'on', inline_actions_position = 'header' WHERE id = 1").run();
  const sentinel = { sent: [] as any[] };
  const raw = "From: x@y.com\r\nTo: shop@hidemyemail.dev\r\nSubject: Hi\r\nContent-Type: text/html\r\n\r\n<html><body>HELLO_BODY</body></html>\r\n";
  await handleInbound(mkMessage("x@y.com", "shop@hidemyemail.dev", raw), testEnv(sentinel));
  const decoded = atob(sentinel.sent[0].rawBase64);
  expect(decoded).toContain("X-HideMyEmail-Actions: header");
  const idxToolbar = decoded.indexOf("action+block=");
  const idxBody = decoded.indexOf("HELLO_BODY");
  expect(idxToolbar).toBeGreaterThan(-1);
  expect(idxBody).toBeGreaterThan(-1);
  expect(idxToolbar).toBeLessThan(idxBody);
});

test("over-quota suppresses toolbar even when user pref = on", async () => {
  await DB().prepare("UPDATE users SET inline_actions_pref = 'on' WHERE id = 1").run();
  // Force over-quota path by setting tight quota
  await DB().prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('max_total_aliases', '0', 0) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run();
  // Auto-create at over_quota
  const a = await DB().prepare(
    "INSERT INTO aliases (domain_id, user_id, local_part, full_address, active, source, created_at) VALUES (1,1,'shop','shop@hidemyemail.dev',1,'auto_over_quota',?) RETURNING id"
  ).bind(Date.now()).first<{ id: number }>();
  expect(a).toBeTruthy();
  const sentinel = { sent: [] as any[] };
  const raw = "From: x@y.com\r\nTo: shop@hidemyemail.dev\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\nhello\r\n";
  await handleInbound(mkMessage("x@y.com", "shop@hidemyemail.dev", raw), testEnv(sentinel));
  expect(sentinel.sent.length).toBe(1);
  const decoded = atob(sentinel.sent[0].rawBase64);
  expect(decoded).not.toContain("X-HideMyEmail-Actions");
  expect(decoded).not.toContain("action+block=");
  // Warning banner still present (text variant uppercases)
  expect(decoded).toContain("QUOTA EXCEEDED");
});
