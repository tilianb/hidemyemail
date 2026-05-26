import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";

const ARN = "arn:aws:sns:us-east-1:123:ses-notifs";
const testEnv = () => ({ ...env, SNS_ALLOWED_TOPIC_ARN: ARN, SNS_SECRET: "test-sns-secret" });

beforeEach(async () => { await (env.DB as D1Database).prepare("DELETE FROM events").run(); });

test("rejects wrong topic arn", async () => {
  const app = createApp();
  const res = await app.request("/api/ses/notification?secret=test-sns-secret", {
    method: "POST", headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ Type: "Notification", TopicArn: "arn:other", Message: "{}" }),
  }, testEnv());
  expect(res.status).toBe(403);
});

test("records a bounce notification as error event", async () => {
  const app = createApp();
  const message = JSON.stringify({ notificationType: "Bounce", bounce: { bouncedRecipients: [{ emailAddress: "x@y.com" }] } });
  const res = await app.request("/api/ses/notification?secret=test-sns-secret", {
    method: "POST", headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ Type: "Notification", TopicArn: ARN, Message: message }),
  }, testEnv());
  expect(res.status).toBe(200);
  const row = await (env.DB as D1Database).prepare("SELECT COUNT(*) AS n FROM events WHERE type='error'").first<{ n: number }>();
  expect(row?.n).toBe(1);
});
