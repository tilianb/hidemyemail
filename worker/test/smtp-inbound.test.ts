import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { resetDb } from "./helpers";
import * as q from "../src/db/queries";

const secret = "internal-secret";
const app = createApp();
const request = (path: string, body: object, supplied = secret, overrides: Record<string, unknown> = {}) => app.request(`/internal/${path}`, {
  method: "POST", headers: { "content-type": "application/json", "x-hidemyemail-internal-secret": supplied },
  body: JSON.stringify(body),
}, { ...env, SMTP_INGRESS_SECRET: secret, __mailSend: async () => ({ providerId: "id" }), ...overrides } as any);

beforeEach(async () => {
  await resetDb(env.DB as D1Database);
  await q.createDomain(env.DB as D1Database, "test.hidemyemail.dev", "real@example.com");
});

test("private SMTP endpoints hide from forged public requests", async () => {
  expect((await request("smtp-recipient", { to: "shop@test.hidemyemail.dev" }, "wrong")).status).toBe(404);
  expect((await app.request("/internal/smtp-recipient", { method: "POST" }, { ...env } as any)).status).toBe(404);
});

test("rejects unknown domains and accepts an active-domain catch-all", async () => {
  expect(await (await request("smtp-recipient", { to: "shop@unknown.example" })).json()).toEqual({ accepted: false });
  expect(await (await request("smtp-recipient", { to: "shop@test.hidemyemail.dev" })).json()).toEqual({ accepted: true });
  await env.DB.prepare("UPDATE domains SET active=0 WHERE domain=?").bind("test.hidemyemail.dev").run();
  expect(await (await request("smtp-recipient", { to: "shop@test.hidemyemail.dev" })).json()).toEqual({ accepted: false });
});

test("rejects malformed trusted verdicts and oversize data", async () => {
  const raw = btoa("From: owner@example.com\r\n\r\nbody");
  const base = { gateway: "mta", deliveryId: "one", from: "owner@example.com", to: "shop@test.hidemyemail.dev", rawBase64: raw };
  const malformed = await request("smtp-ingest", { ...base, auth: { spf: "TOTALLY_PASS" } });
  expect(malformed.status).toBe(400);
  const verdicts = { spf: "PASS", dmarc: "PASS", spam: "PASS", virus: "PASS" };
  const large = await request("smtp-ingest", { ...base, auth: verdicts, deliveryId: "two", rawBase64: btoa("x".repeat(25 * 1024 * 1024 + 1)) });
  expect(large.status).toBe(413);
});

test("concurrent SMTP duplicates keep one claim and completed retries do not resend", async () => {
  const body = {
    gateway: "stalwart-1", deliveryId: "queue-42", from: "alice@sender.example",
    to: "shop@test.hidemyemail.dev", rawBase64: btoa("From: Alice <alice@sender.example>\r\nSubject: hello\r\n\r\nbody"),
    auth: { spf: "PASS", dmarc: "PASS", spam: "PASS", virus: "PASS" },
  };
  const sent: unknown[] = [];
  let release!: () => void;
  let started!: () => void;
  const sendStarted = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const overrides = { __mailSend: async (message: unknown) => { sent.push(message); started(); await gate; return { providerId: "id" }; } };

  const firstPromise = request("smtp-ingest", body, secret, overrides);
  await sendStarted;
  const concurrent = await request("smtp-ingest", body, secret, overrides);
  expect(concurrent.status).toBe(503);
  release();
  const first = await firstPromise;
  expect(first.status).toBe(202);
  const completedRetry = await request("smtp-ingest", body, secret, overrides);
  expect(completedRetry.status).toBe(200);
  expect(await completedRetry.json()).toEqual({ ok: true, duplicate: true });
  expect(sent).toHaveLength(1);
});
