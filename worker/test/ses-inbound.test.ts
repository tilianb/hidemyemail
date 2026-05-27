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

test("reply to reverse alias routes to handleReply, not a re-wrapped inbound", async () => {
  await q.autoCreateAlias(env.DB as D1Database, 1, "shop", "shop@test.hidemyemail.dev");
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
