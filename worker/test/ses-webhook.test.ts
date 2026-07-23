import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { encryptDestination, hashDestination } from "../src/lib/crypto";
import { makeSignedSnsBody } from "./sns-signature";

const ARN = "arn:aws:sns:ap-southeast-2:123:ses-notifs";
const testEnv = (certPem = "bad cert") => ({
  ...env,
  SNS_ALLOWED_TOPIC_ARN: ARN,
  SES_REGION: "ap-southeast-2",
  __snsCertFetch: async () => new Response(certPem, { status: 200 }),
});

beforeEach(async () => {
  await (env.DB as D1Database).prepare("DELETE FROM events").run();
  await (env.DB as D1Database).prepare("DELETE FROM mail_deliveries").run();
  await (env.DB as D1Database).prepare("DELETE FROM destinations").run();
});

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

test("replayed SNS MessageId is acknowledged without repeating side effects", async () => {
  const app = createApp();
  const message = JSON.stringify({ notificationType: "Bounce", bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "x@y.com" }] } });
  const signed = await makeSignedSnsBody({ topicArn: ARN, message });
  const send = () => app.request("/api/ses/notification", {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(signed.body),
  }, testEnv(signed.certPem));
  expect((await send()).status).toBe(200);
  expect((await send()).status).toBe(200);
  const row = await (env.DB as D1Database).prepare("SELECT COUNT(*) AS n FROM events WHERE type='error'").first<{ n: number }>();
  expect(row?.n).toBe(1);
});

test("same SES feedback event republished under another SNS id has one side effect", async () => {
  const app = createApp();
  const message = JSON.stringify({ notificationType: "Bounce", mail: { messageId: "ses-feedback-1" }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "x@y.com" }] } });
  const first = await makeSignedSnsBody({ topicArn: ARN, message });
  const second = await makeSignedSnsBody({ topicArn: ARN, message });
  for (const signed of [first, second]) {
    expect((await app.request("/api/ses/notification", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(signed.body) }, testEnv(signed.certPem))).status).toBe(200);
  }
  const row = await (env.DB as D1Database).prepare("SELECT COUNT(*) AS n FROM events WHERE type='error'").first<{ n: number }>();
  expect(row?.n).toBe(1);
});

test.each([
  ["Bounce", "bounce", { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "takeover@example.com" }] }],
  ["Complaint", "complaint", { complainedRecipients: [{ emailAddress: "takeover@example.com" }] }],
] as const)("%s lease takeover retries with one durable effect and completion", async (kind, eventType, feedback) => {
  const db = env.DB as D1Database;
  const email = "takeover@example.com";
  const encrypted = await encryptDestination(email, env.DESTINATION_ENCRYPTION_KEY);
  const hash = await hashDestination(email, env.DESTINATION_ENCRYPTION_KEY);
  const dest = await db.prepare(
    "INSERT INTO destinations (user_id,email,email_hash,token,verified_at,created_at,is_default) VALUES (1,?,?,?,1,1,1) RETURNING id"
  ).bind(encrypted, hash, `takeover-${kind}`).first<{ id: number }>();
  const message = JSON.stringify({ notificationType: kind, mail: { messageId: `takeover-${kind}` }, [kind.toLowerCase()]: feedback });
  const signed = await makeSignedSnsBody({ topicArn: ARN, message });
  const deliveryId = `sns:${signed.body.MessageId}`;
  let steal = true;
  const routeEnv = {
    ...testEnv(signed.certPem),
    __beforeFeedbackCommit: async () => {
      if (!steal) return;
      steal = false;
      await db.prepare("UPDATE mail_deliveries SET lease_until=0 WHERE external_id=?").bind(deliveryId).run();
      const replacement = await (await import("../src/db/queries")).claimDelivery(db, deliveryId, "notification", Date.now(), `ses:takeover-${kind}:${kind}`);
      expect(replacement.status).toBe("claimed");
      await db.prepare("UPDATE mail_deliveries SET lease_until=0 WHERE external_id=?").bind(deliveryId).run();
    },
  };
  const send = () => createApp().request("/api/ses/notification", {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(signed.body),
  }, routeEnv);

  expect((await send()).status).toBe(503);
  expect((await send()).status).toBe(200);

  expect((await db.prepare("SELECT COUNT(*) n FROM events WHERE type=? AND detail=?").bind(eventType, `dest:${dest!.id}`).first<{ n: number }>())?.n).toBe(1);
  expect((await db.prepare("SELECT suppression_class FROM destinations WHERE id=?").bind(dest!.id).first<{ suppression_class: string }>())?.suppression_class).toBe("hard");
  expect((await db.prepare("SELECT state FROM mail_deliveries WHERE external_id=?").bind(deliveryId).first<{ state: string }>())?.state).toBe("completed");
});
