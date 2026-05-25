import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { resetDb } from "./helpers";
import * as q from "../src/db/queries";

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

function testEnv(opts: { s3Throws?: boolean } = {}) {
  const sesSent: any[] = [];
  return {
    ...env,
    SNS_INBOUND_TOPIC_ARN: INBOUND_ARN,
    S3_INBOUND_BUCKET: "hidemyemail-inbound-raw",
    SES_ACCESS_KEY_ID: "AKIATEST",
    SES_SECRET_ACCESS_KEY: "testsecret",
    SES_REGION: "ap-southeast-2",
    REVERSE_PREFIX: "r.",
    __s3Fetch: opts.s3Throws
      ? async () => { throw new Error("S3 unavailable"); }
      : async () => new TextEncoder().encode(RAW_EMAIL),
    __sesSend: async (_c: any, m: any) => { sesSent.push(m); return "mid"; },
    _sesSent: sesSent,
  } as any;
}

function snsNotification(to = "shop@test.hidemyemail.dev", messageId = "msg-001-test") {
  return JSON.stringify({
    Type: "Notification",
    TopicArn: INBOUND_ARN,
    Message: JSON.stringify({
      notificationType: "Received",
      mail: { source: "alice@store.com", messageId, destination: [to] },
      receipt: { recipients: [to] },
    }),
  });
}

beforeEach(async () => {
  await resetDb(env.DB as D1Database);
  await q.createDomain(env.DB as D1Database, "test.hidemyemail.dev", "real@me.com");
});

test("wrong TopicArn → 403", async () => {
  const app = createApp();
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ Type: "Notification", TopicArn: "arn:aws:sns:ap-southeast-2:999:wrong" }),
  }, testEnv());
  expect(res.status).toBe(403);
});

test("SubscriptionConfirmation → 200", async () => {
  const app = createApp();
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({
      Type: "SubscriptionConfirmation",
      TopicArn: INBOUND_ARN,
      SubscribeURL: "https://sns.ap-southeast-2.amazonaws.com/confirm?Token=abc",
    }),
  }, testEnv());
  expect(res.status).toBe(200);
});

test("valid Received → S3 fetched, handleInbound called, SES sends, 200", async () => {
  const e = testEnv();
  const app = createApp();
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: snsNotification(),
  }, e);
  expect(res.status).toBe(200);
  expect(e._sesSent.length).toBe(1);
  // MIME surgery: From rewritten to reverse alias
  expect(atob(e._sesSent[0].rawBase64)).toContain("r.");
});

test("S3 fetch failure → 500 so SNS retries", async () => {
  const app = createApp();
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: snsNotification(),
  }, testEnv({ s3Throws: true }));
  expect(res.status).toBe(500);
});

test("Received for unknown domain → 200, no SES send", async () => {
  const e = testEnv();
  const app = createApp();
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: snsNotification("anything@unknown.dev", "msg-002"),
  }, e);
  expect(res.status).toBe(200);
  expect(e._sesSent.length).toBe(0);
});

test("non-Received notificationType → 200 ignored", async () => {
  const e = testEnv();
  const app = createApp();
  const res = await app.request("/api/ses/inbound", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({
      Type: "Notification",
      TopicArn: INBOUND_ARN,
      Message: JSON.stringify({ notificationType: "Bounce" }),
    }),
  }, e);
  expect(res.status).toBe(200);
  expect(e._sesSent.length).toBe(0);
});
