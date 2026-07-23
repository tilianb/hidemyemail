import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { resetDb } from "./helpers";
import * as q from "../src/db/queries";
import { makeSignedSnsBody } from "./sns-signature";

const INBOUND_ARN = "arn:aws:sns:ap-southeast-2:123456789012:hidemyemail-inbound-notifications";
const RAW_EMAIL = [
  "From: Alice <alice@store.com>",
  "To: shop@test.hidemyemail.dev",
  "Subject: Order update",
  "MIME-Version: 1.0",
  "Content-Type: text/plain",
  "",
  "Your order ships tomorrow.",
  "",
].join("\r\n");

function testEnv(opts: { s3Throws?: boolean; raw?: string; certPem?: string; confirmFetch?: typeof fetch } = {}) {
  const sesSent: any[] = [];
  const raw = opts.raw ?? RAW_EMAIL;
  return {
    ...env,
    SNS_INBOUND_TOPIC_ARN: INBOUND_ARN,
    S3_INBOUND_BUCKET: "hidemyemail-inbound-raw",
    SES_ACCESS_KEY_ID: "AKIATEST",
    SES_SECRET_ACCESS_KEY: "testsecret",
    SES_REGION: "ap-southeast-2",
    __snsCertFetch: async () => new Response(opts.certPem ?? "bad cert", { status: 200 }),
    __snsConfirmFetch: opts.confirmFetch,

    __s3Fetch: opts.s3Throws
      ? async () => { throw new Error("S3 unavailable"); }
      : async () => new TextEncoder().encode(raw),
    __sesSend: async (_c: any, m: any) => { sesSent.push(m); return "mid"; },
    _sesSent: sesSent,
  } as any;
}

function snsMessage(
  to = "shop@test.hidemyemail.dev", messageId = "msg-001-test",
  opts: { source?: string; spf?: string; dmarc?: string } = {},
) {
  return JSON.stringify({
      notificationType: "Received",
      mail: { source: opts.source ?? "alice@store.com", messageId, destination: [to] },
      receipt: {
        recipients: [to],
        spfVerdict: { status: opts.spf ?? "PASS" },
        dmarcVerdict: { status: opts.dmarc ?? "PASS" },
      },
  });
}

async function snsNotification(
  to = "shop@test.hidemyemail.dev", messageId = "msg-001-test",
  opts: { source?: string; spf?: string; dmarc?: string; topicArn?: string } = {},
) {
  return makeSignedSnsBody({
    topicArn: opts.topicArn ?? INBOUND_ARN,
    message: snsMessage(to, messageId, opts),
  });
}

beforeEach(async () => {
  await resetDb(env.DB as D1Database);
  await q.createDomain(env.DB as D1Database, "test.hidemyemail.dev", "real@me.com");
});

test("wrong TopicArn → 403", async () => {
  const app = createApp();
  const signed = await snsNotification("shop@test.hidemyemail.dev", "msg-wrong", { topicArn: "arn:aws:sns:ap-southeast-2:999:wrong" });
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(signed.body),
  }, testEnv({ certPem: signed.certPem }));
  expect(res.status).toBe(403);
});

test("SubscriptionConfirmation → 200", async () => {
  const app = createApp();
  const signed = await makeSignedSnsBody({ type: "SubscriptionConfirmation", topicArn: INBOUND_ARN });
  let confirmedUrl = "";
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(signed.body),
  }, testEnv({
    certPem: signed.certPem,
    confirmFetch: async (url) => {
      confirmedUrl = String(url);
      return new Response(null, { status: 200 });
    },
  }));
  expect(res.status).toBe(200);
  expect(confirmedUrl).toBe(signed.body.SubscribeURL);
});

test("tampered signed notification → 401", async () => {
  const app = createApp();
  const signed = await snsNotification();
  signed.body.Message = snsMessage("evil@test.hidemyemail.dev", "msg-tampered");
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(signed.body),
  }, testEnv({ certPem: signed.certPem }));
  expect(res.status).toBe(401);
});

test("allowed_topic query no longer expands accepted topics", async () => {
  const app = createApp();
  const wrongTopic = "arn:aws:sns:ap-southeast-2:999:wrong";
  const signed = await snsNotification("shop@test.hidemyemail.dev", "msg-wrong-query", { topicArn: wrongTopic });
  const res = await app.request(`/api/ses/inbound?allowed_topic=${encodeURIComponent(wrongTopic)}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(signed.body),
  }, testEnv({ certPem: signed.certPem }));
  expect(res.status).toBe(403);
});

test("valid Received → S3 fetched, inbound forwarded, SES sends, 200", async () => {
  const e = testEnv();
  const app = createApp();
  const signed = await snsNotification();
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(signed.body),
  }, { ...e, __snsCertFetch: async () => new Response(signed.certPem, { status: 200 }) });
  expect(res.status).toBe(200);
  expect(e._sesSent.length).toBe(1);
  // addy-style Reply-To with the sender encoded inline
  expect(atob(e._sesSent[0].rawBase64)).toContain("Reply-To: shop+alice=store.com@test.hidemyemail.dev");
});

test("completed SES message replay returns 200 without a second send", async () => {
  const e = testEnv();
  const app = createApp();
  const signed = await snsNotification();
  const request = () => app.request("/api/ses/inbound", {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(signed.body),
  }, { ...e, __snsCertFetch: async () => new Response(signed.certPem) });

  expect((await request()).status).toBe(200);
  expect((await request()).status).toBe(200);
  expect(e._sesSent).toHaveLength(1);
});

test("same SES message under a new SNS MessageId is not sent twice", async () => {
  const e = testEnv();
  const app = createApp();
  const first = await snsNotification("shop@test.hidemyemail.dev", "semantic-replay");
  const second = await snsNotification("shop@test.hidemyemail.dev", "semantic-replay");
  const send = (signed: Awaited<ReturnType<typeof snsNotification>>) => app.request("/api/ses/inbound", {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(signed.body),
  }, { ...e, __snsCertFetch: async () => new Response(signed.certPem) });
  expect((await send(first)).status).toBe(200);
  expect((await send(second)).status).toBe(200);
  expect(e._sesSent).toHaveLength(1);
});

test("terminal oversized S3 object is completed and immediately acknowledged", async () => {
  const signed = await snsNotification("shop@test.hidemyemail.dev", "too-large");
  const e = { ...testEnv(), __s3Fetch: async () => { throw new (await import("../src/lib/bytes")).BodyTooLargeError("too large"); } } as any;
  const request = () => createApp().request("/api/ses/inbound", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(signed.body) }, { ...e, __snsCertFetch: async () => new Response(signed.certPem) });
  expect((await request()).status).toBe(200);
  expect((await request()).status).toBe(200);
});

test("oversized public SNS body is rejected before certificate fetch", async () => {
  let certFetches = 0;
  const res = await createApp().request("/api/ses/inbound", {
    method: "POST", body: "x".repeat(300_000), headers: { "Content-Type": "text/plain" },
  }, { ...testEnv(), __snsCertFetch: async () => { certFetches++; return new Response(""); } });
  expect(res.status).toBe(413);
  expect(certFetches).toBe(0);
});

test("reply to reverse alias routes to handleReply, not a re-wrapped inbound", async () => {
  const alias = await q.autoCreateAlias(env.DB as D1Database, 1, "shop", "shop@test.hidemyemail.dev");
  // First-contact rule: model the prior inbound from alice@store.com this is a reply to.
  // The reply gate reads the durable `contacts` table; a real forward writes both.
  await q.insertEvent(env.DB as D1Database, { alias_id: alias!.id, type: "forward", external_sender: "alice@store.com", ts: Date.now() });
  await q.recordContact(env.DB as D1Database, alias!.id, "alice@store.com", Date.now());
  const replyRaw = [
    "From: Me <real@me.com>",
    "To: shop+alice=store.com@test.hidemyemail.dev",
    "Subject: Re: Order update",
    "",
    "Thanks, got it.",
    "",
  ].join("\r\n");
  const e = testEnv({ raw: replyRaw });
  const app = createApp();
  const signed = await snsNotification("shop+alice=store.com@test.hidemyemail.dev", "msg-reply", { source: "real@me.com", spf: "PASS" });
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(signed.body),
  }, { ...e, __snsCertFetch: async () => new Response(signed.certPem, { status: 200 }) });
  expect(res.status).toBe(200);
  expect(e._sesSent.length).toBe(1);
  // Sent AS the alias, TO the original external sender — no doubled token.
  expect(e._sesSent[0].from).toBe("shop@test.hidemyemail.dev");
  expect(e._sesSent[0].to).toBe("alice@store.com");
  expect(atob(e._sesSent[0].rawBase64)).not.toContain("=store.com=");
});

test("reply retry resumes an SES-accepted delivery without muting or sending twice", async () => {
  const alias = await q.autoCreateAlias(env.DB as D1Database, 1, "shop", "shop@test.hidemyemail.dev");
  await q.recordContact(env.DB as D1Database, alias!.id, "alice@store.com", Date.now());
  await (env.DB as D1Database).prepare("UPDATE settings SET value='1' WHERE key='reply_distinct_recipient_cap'").run();
  await (env.DB as D1Database).prepare(
    "CREATE TRIGGER fail_reply_event BEFORE INSERT ON events WHEN NEW.type='reply' BEGIN SELECT RAISE(FAIL, 'bookkeeping failed'); END"
  ).run();
  const replyRaw = "From: Me <real@me.com>\r\nTo: shop+alice=store.com@test.hidemyemail.dev\r\nSubject: Re: Order\r\n\r\nThanks\r\n";
  const e = testEnv({ raw: replyRaw });
  const signed = await snsNotification("shop+alice=store.com@test.hidemyemail.dev", "msg-reply-retry", { source: "real@me.com", spf: "PASS" });
  const request = () => createApp().request("/api/ses/inbound", {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(signed.body),
  }, { ...e, __snsCertFetch: async () => new Response(signed.certPem) });

  expect((await request()).status).toBe(500);
  expect(e._sesSent).toHaveLength(1);
  await (env.DB as D1Database).prepare("DROP TRIGGER fail_reply_event").run();
  expect((await request()).status).toBe(200);

  expect(e._sesSent).toHaveLength(1);
  expect((await q.getAlias(env.DB as D1Database, "shop@test.hidemyemail.dev"))?.muted_until).toBeNull();
  expect((await q.getAlias(env.DB as D1Database, "shop@test.hidemyemail.dev"))?.reply_count).toBe(1);
  expect((await (env.DB as D1Database).prepare("SELECT COUNT(*) n FROM events WHERE type='reply'").first<{ n: number }>())?.n).toBe(1);
});

test("inbound retry resumes an SES-accepted delivery without sending twice", async () => {
  await (env.DB as D1Database).prepare(
    "CREATE TRIGGER fail_forward_event BEFORE INSERT ON events WHEN NEW.type='forward' BEGIN SELECT RAISE(FAIL, 'bookkeeping failed'); END"
  ).run();
  const e = testEnv();
  const signed = await snsNotification("shop@test.hidemyemail.dev", "msg-forward-retry");
  const request = () => createApp().request("/api/ses/inbound", {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(signed.body),
  }, { ...e, __snsCertFetch: async () => new Response(signed.certPem) });

  expect((await request()).status).toBe(500);
  expect(e._sesSent).toHaveLength(1);
  await (env.DB as D1Database).prepare("DROP TRIGGER fail_forward_event").run();
  expect((await request()).status).toBe(200);

  expect(e._sesSent).toHaveLength(1);
  expect((await q.getAlias(env.DB as D1Database, "shop@test.hidemyemail.dev"))?.fwd_count).toBe(1);
  expect((await (env.DB as D1Database).prepare("SELECT COUNT(*) n FROM events WHERE type='forward'").first<{ n: number }>())?.n).toBe(1);
});

test("new SNS id resumes accepted semantic delivery bookkeeping without a second SES send", async () => {
  await (env.DB as D1Database).prepare(
    "CREATE TRIGGER fail_forward_event BEFORE INSERT ON events WHEN NEW.type='forward' BEGIN SELECT RAISE(FAIL, 'bookkeeping failed'); END"
  ).run();
  const e = testEnv();
  const first = await snsNotification("shop@test.hidemyemail.dev", "semantic-takeover");
  const replacement = await snsNotification("shop@test.hidemyemail.dev", "semantic-takeover");
  const send = (signed: Awaited<ReturnType<typeof snsNotification>>) => createApp().request("/api/ses/inbound", {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(signed.body),
  }, { ...e, __snsCertFetch: async () => new Response(signed.certPem) });

  expect((await send(first)).status).toBe(500);
  expect(e._sesSent).toHaveLength(1);
  await (env.DB as D1Database).prepare("UPDATE mail_deliveries SET lease_until=0").run();
  await (env.DB as D1Database).prepare("DROP TRIGGER fail_forward_event").run();

  expect((await send(replacement)).status).toBe(200);
  expect(e._sesSent).toHaveLength(1);
  expect((await q.getAlias(env.DB as D1Database, "shop@test.hidemyemail.dev"))?.fwd_count).toBe(1);
});

test("transient SES timeout keeps the send fence and retry before deadline cannot send again", async () => {
  const e = testEnv();
  const signed = await snsNotification("shop@test.hidemyemail.dev", "timeout-fence");
  let sends = 0;
  e.__sesSend = async () => {
    sends++;
    throw new (await import("../src/lib/ses")).SesTransientError("SES request timed out");
  };
  const request = () => createApp().request("/api/ses/inbound", {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(signed.body),
  }, { ...e, __snsCertFetch: async () => new Response(signed.certPem) });

  expect((await request()).status).toBe(500);
  expect((await request()).status).toBe(503);
  expect(sends).toBe(1);
  expect(await (env.DB as D1Database).prepare(
    "SELECT d.state delivery_state,r.state reservation_state,r.send_deadline FROM mail_deliveries d JOIN mail_quota_reservations r ON r.id=d.external_id"
  ).first()).toMatchObject({ delivery_state: "processing", reservation_state: "sending" });
});

test("replacement waits while the original SES send remains in flight", async () => {
  const e = testEnv();
  const signed = await snsNotification("shop@test.hidemyemail.dev", "msg-lease-takeover");
  const deliveryId = "ses:msg-lease-takeover";
  let sendStarted!: () => void;
  let finishSend!: () => void;
  const started = new Promise<void>((resolve) => { sendStarted = resolve; });
  const finish = new Promise<void>((resolve) => { finishSend = resolve; });
  e.__sesSend = async (_c: any, m: any) => {
    e._sesSent.push(m);
    if (e._sesSent.length === 1) {
      sendStarted();
      await finish;
    }
    return "mid";
  };

  const request = () => createApp().request("/api/ses/inbound", {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(signed.body),
  }, { ...e, __snsCertFetch: async () => new Response(signed.certPem) });

  const original = request();
  await started;
  await (env.DB as D1Database).prepare("UPDATE mail_deliveries SET lease_until=? WHERE external_id=?").bind(Date.now() - 1, deliveryId).run();

  expect((await request()).status).toBe(503);
  expect(e._sesSent).toHaveLength(1);

  finishSend();
  expect((await original).status).toBe(200);
  expect((await (env.DB as D1Database).prepare("SELECT COUNT(*) n FROM events WHERE type='forward'").first<{ n: number }>())?.n).toBe(1);
  expect((await q.getAlias(env.DB as D1Database, "shop@test.hidemyemail.dev"))?.fwd_count).toBe(1);
  expect((await (env.DB as D1Database).prepare("SELECT state FROM mail_deliveries WHERE external_id=?").bind(deliveryId).first<{ state: string }>())?.state).toBe("completed");
});

test("reply with SPF fail → no SES send (anti-spoof)", async () => {
  await q.autoCreateAlias(env.DB as D1Database, 1, "shop", "shop@test.hidemyemail.dev");
  const e = testEnv({ raw: "From: x\r\nTo: y\r\n\r\nz\r\n" });
  const app = createApp();
  const signed = await snsNotification("shop+alice=store.com@test.hidemyemail.dev", "msg-spoof", { source: "real@me.com", spf: "FAIL", dmarc: "FAIL" });
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(signed.body),
  }, { ...e, __snsCertFetch: async () => new Response(signed.certPem, { status: 200 }) });
  expect(res.status).toBe(200);
  expect(e._sesSent.length).toBe(0);
});

test("S3 fetch failure → 500 so SNS retries", async () => {
  const app = createApp();
  const signed = await snsNotification();
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(signed.body),
  }, testEnv({ s3Throws: true, certPem: signed.certPem }));
  expect(res.status).toBe(500);
});

test("Received for unknown domain → 200, no SES send", async () => {
  const e = testEnv();
  const app = createApp();
  const signed = await snsNotification("anything@unknown.dev", "msg-002");
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(signed.body),
  }, { ...e, __snsCertFetch: async () => new Response(signed.certPem, { status: 200 }) });
  expect(res.status).toBe(200);
  expect(e._sesSent.length).toBe(0);
});

test("non-Received notificationType → 200 ignored", async () => {
  const e = testEnv();
  const app = createApp();
  const signed = await makeSignedSnsBody({ topicArn: INBOUND_ARN, message: JSON.stringify({ notificationType: "Bounce" }) });
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(signed.body),
  }, { ...e, __snsCertFetch: async () => new Response(signed.certPem, { status: 200 }) });
  expect(res.status).toBe(200);
  expect(e._sesSent.length).toBe(0);
});
