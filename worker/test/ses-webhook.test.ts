import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { makeSignedSnsBody } from "./sns-signature";

const ARN = "arn:aws:sns:ap-southeast-2:123:ses-notifs";
const testEnv = (certPem = "bad cert") => ({
  ...env,
  SNS_ALLOWED_TOPIC_ARN: ARN,
  SES_REGION: "ap-southeast-2",
  __snsCertFetch: async () => new Response(certPem, { status: 200 }),
});

beforeEach(async () => { await (env.DB as D1Database).prepare("DELETE FROM events").run(); });

test("rejects wrong topic arn", async () => {
  const app = createApp();
  const signed = await makeSignedSnsBody({
    topicArn: "arn:aws:sns:ap-southeast-2:123:wrong",
    message: "{}",
  });
  const res = await app.request("/api/ses/notification", {
    method: "POST", headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(signed.body),
  }, testEnv(signed.certPem));
  expect(res.status).toBe(403);
});

test("rejects tampered notification signature", async () => {
  const app = createApp();
  const signed = await makeSignedSnsBody({ topicArn: ARN, message: "{}" });
  signed.body.Message = JSON.stringify({ notificationType: "Bounce" });
  const res = await app.request("/api/ses/notification", {
    method: "POST", headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(signed.body),
  }, testEnv(signed.certPem));
  expect(res.status).toBe(401);
});

test("bounce notification for unknown address returns 200 and logs feedback", async () => {
  const app = createApp();
  // Bounce for an address not in destinations — should succeed silently (no destination to suppress)
  const message = JSON.stringify({ notificationType: "Bounce", bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "x@y.com" }] } });
  const signed = await makeSignedSnsBody({ topicArn: ARN, message });
  const res = await app.request("/api/ses/notification", {
    method: "POST", headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(signed.body),
  }, testEnv(signed.certPem));
  expect(res.status).toBe(200);
  const row = await (env.DB as D1Database).prepare("SELECT COUNT(*) AS n FROM events WHERE type='error'").first<{ n: number }>();
  expect(row?.n).toBe(1);
});
