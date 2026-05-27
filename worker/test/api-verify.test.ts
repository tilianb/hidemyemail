import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { signSession } from "../src/lib/auth";
import { resetDb } from "./helpers";

let testEnv: any; let cookie: string;
beforeAll(async () => {
  testEnv = { ...env, SESSION_SECRET: "sek" };
  cookie = "__Host-session=" + (await signSession("sek", 1, 3600));
});

beforeEach(async () => {
  await resetDb(env.DB as D1Database);
  await (env.DB as D1Database).prepare("DELETE FROM destinations").run();
  delete testEnv.__sesSend;
});

test("GET and POST /api/verify email verification flow", async () => {
  const app = createApp();
  const db = env.DB as D1Database;

  // 1. Seed a pending destination
  const email = "test@example.com";
  const token = "pending-token-123";
  const { encryptDestination, hashDestination } = await import("../src/lib/crypto");
  const encEmail = await encryptDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY);
  const hashEmail = await hashDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY);
  await db.prepare(
    "INSERT INTO destinations (user_id, email, email_hash, token, created_at) VALUES (1, ?, ?, ?, ?)"
  ).bind(encEmail, hashEmail, token, Date.now()).run();

  // Verify it starts as unverified
  const initial = await db.prepare("SELECT verified_at FROM destinations WHERE token = ?").bind(token).first<{ verified_at: number | null }>();
  expect(initial?.verified_at).toBeNull();

  // 2. GET request to verify page (should show the confirmation landing page, no mutation)
  const getRes = await app.request(`/api/verify?token=${token}`, {}, testEnv);
  expect(getRes.status).toBe(200);
  expect(getRes.headers.get("Content-Type")).toContain("text/html");
  
  const getHtml = await getRes.text();
  expect(getHtml).toContain("Verify");
  expect(getHtml).toContain("Destination");
  expect(getHtml).toContain("Confirm Verification");
  expect(getHtml).toContain(email);
  expect(getHtml).toContain(`<input type="hidden" name="token" value="${token}" />`);

  // Verify no mutation occurred in the database on GET
  const afterGet = await db.prepare("SELECT verified_at FROM destinations WHERE token = ?").bind(token).first<{ verified_at: number | null }>();
  expect(afterGet?.verified_at).toBeNull();

  // 3. POST request to verify (submitting the confirmation form)
  const params = new URLSearchParams();
  params.append("token", token);

  const postRes = await app.request("/api/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  }, testEnv);

  expect(postRes.status).toBe(200);
  expect(postRes.headers.get("Content-Type")).toContain("text/html");

  const postHtml = await postRes.text();
  expect(postHtml).toContain("Verification Successful");
  expect(postHtml).toContain("Your email address has been verified successfully");
  expect(postHtml).toContain(email);

  // Verify the database was updated with verified_at timestamp
  const afterPost = await db.prepare("SELECT verified_at FROM destinations WHERE token = ?").bind(token).first<{ verified_at: number | null }>();
  expect(afterPost?.verified_at).not.toBeNull();
  expect(typeof afterPost?.verified_at).toBe("number");

  // 4. Repeated GET request should now fail (returns 400 since verified_at is no longer NULL)
  const repeatedGetRes = await app.request(`/api/verify?token=${token}`, {}, testEnv);
  expect(repeatedGetRes.status).toBe(400);
  expect(repeatedGetRes.headers.get("Content-Type")).toContain("text/html");
  
  const repeatedGetHtml = await repeatedGetRes.text();
  expect(repeatedGetHtml).toContain("Link Expired or Invalid");

  // 5. Repeated POST request should also fail
  const repeatedPostRes = await app.request("/api/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  }, testEnv);
  expect(repeatedPostRes.status).toBe(400);
  
  const repeatedPostHtml = await repeatedPostRes.text();
  expect(repeatedPostHtml).toContain("Link Expired or Invalid");
});

test("GET and POST /api/verify with invalid / missing token", async () => {
  const app = createApp();

  // 1. GET with missing token
  const getMissingRes = await app.request("/api/verify", {}, testEnv);
  expect(getMissingRes.status).toBe(400);
  expect(await getMissingRes.text()).toBe("Missing token");

  // 2. GET with invalid token
  const getInvalidRes = await app.request("/api/verify?token=non-existent-token", {}, testEnv);
  expect(getInvalidRes.status).toBe(400);
  const getInvalidHtml = await getInvalidRes.text();
  expect(getInvalidHtml).toContain("Link Expired or Invalid");

  // 3. POST with missing token
  const postMissingRes = await app.request("/api/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "",
  }, testEnv);
  expect(postMissingRes.status).toBe(400);
  const postMissingHtml = await postMissingRes.text();
  expect(postMissingHtml).toContain("Link Expired or Invalid");

  // 4. POST with invalid token
  const params = new URLSearchParams();
  params.append("token", "non-existent-token");
  const postInvalidRes = await app.request("/api/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  }, testEnv);
  expect(postInvalidRes.status).toBe(400);
  const postInvalidHtml = await postInvalidRes.text();
  expect(postInvalidHtml).toContain("Link Expired or Invalid");
});

test("POST /api/destinations stores pending destination before sending verification email", async () => {
  let releaseSend!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    testEnv.__sesSend = async () => {
      resolve();
      await new Promise<void>((release) => { releaseSend = release; });
      return "message-id";
    };
  });

  const app = createApp();
  const createRes = await app.request("/api/destinations", {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "new@example.com" }),
  }, {
    ...testEnv,
    SES_ACCESS_KEY_ID: "akid",
    SES_SECRET_ACCESS_KEY: "secret",
    SES_REGION: "ap-southeast-2",
  });

  expect(createRes.status).toBe(200);
  await sendStarted;

  const row = await (env.DB as D1Database).prepare(
    "SELECT token, verified_at FROM destinations WHERE user_id = 1"
  ).first<{ token: string; verified_at: number | null }>();
  expect(row?.token).toBeTruthy();
  expect(row?.verified_at).toBeNull();

  releaseSend();
  delete testEnv.__sesSend;
});
