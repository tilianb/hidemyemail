import { env } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";
import PostalMime from "postal-mime";
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
  expect(postHtml).not.toContain("<script>");
  expect(postHtml).not.toContain("script-src 'unsafe-inline'");

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
  let sentMessage: any;
  const sendStarted = new Promise<void>((resolve) => {
    testEnv.__sesSend = async (_config: any, message: any) => {
      sentMessage = message;
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

  const rawBytes = Uint8Array.from(atob(sentMessage.rawBase64), (char) => char.charCodeAt(0));
  const rawMessage = new TextDecoder().decode(rawBytes);
  expect(rawMessage).not.toContain("—");
  const parsed = await PostalMime.parse(rawBytes);
  expect(parsed.text).toContain("Verify your email address — HideMyEmail");

  releaseSend();
  delete testEnv.__sesSend;
});

test("POST /api/destinations/:id/resend sends the existing verification token to the decrypted destination", async () => {
  const email = "pending@example.com";
  const token = "existing-verification-token";
  const { encryptDestination, hashDestination } = await import("../src/lib/crypto");
  const encryptedEmail = await encryptDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY);
  const emailHash = await hashDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY);
  const inserted = await (env.DB as D1Database).prepare(
    "INSERT INTO destinations (user_id, email, email_hash, token, created_at) VALUES (1, ?, ?, ?, ?) RETURNING id"
  ).bind(encryptedEmail, emailHash, token, Date.now()).first<{ id: number }>();
  const sent: any[] = [];

  const res = await createApp().request(`/api/destinations/${inserted!.id}/resend`, {
    method: "POST",
    headers: { cookie },
  }, {
    ...testEnv,
    SES_ACCESS_KEY_ID: "akid",
    SES_SECRET_ACCESS_KEY: "secret",
    SES_REGION: "ap-southeast-2",
    __sesSend: async (_config: any, message: any) => { sent.push(message); return "message-id"; },
  });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toBe(email);
  const rawBytes = Uint8Array.from(atob(sent[0].rawBase64), (char) => char.charCodeAt(0));
  const parsed = await PostalMime.parse(rawBytes);
  expect(parsed.text).toContain(`/api/verify?token=${token}`);
  expect(parsed.html).toContain(`/api/verify?token=${token}`);
  const stored = await (env.DB as D1Database).prepare("SELECT email, token, verified_at FROM destinations WHERE id = ?")
    .bind(inserted!.id).first<{ email: string; token: string; verified_at: number | null }>();
  expect(stored).toEqual({ email: encryptedEmail, token, verified_at: null });
});

test("POST /api/destinations/:id/resend rejects missing SES configuration without sending or consuming cooldown", async () => {
  const email = "unconfigured@example.com";
  const { encryptDestination, hashDestination } = await import("../src/lib/crypto");
  const inserted = await (env.DB as D1Database).prepare(
    "INSERT INTO destinations (user_id, email, email_hash, token, created_at) VALUES (1, ?, ?, ?, ?) RETURNING id"
  ).bind(
    await encryptDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY),
    await hashDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY),
    "unconfigured-token",
    Date.now()
  ).first<{ id: number }>();
  const sent: any[] = [];

  const res = await createApp().request(`/api/destinations/${inserted!.id}/resend`, {
    method: "POST",
    headers: { cookie },
  }, {
    ...testEnv,
    SES_ACCESS_KEY_ID: undefined,
    SES_SECRET_ACCESS_KEY: undefined,
    SES_REGION: undefined,
    __sesSend: async (...args: any[]) => { sent.push(args); return "message-id"; },
  });

  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "Email sending is not configured" });
  expect(sent).toHaveLength(0);
  const cooldown = await (env.DB as D1Database).prepare("SELECT reset_at FROM rate_limits WHERE ip = ?")
    .bind(`destination-resend:1:${inserted!.id}`).first();
  expect(cooldown).toBeNull();
});

test("POST /api/destinations/:id/resend rate limits a second immediate send", async () => {
  const email = "cooldown@example.com";
  const { encryptDestination, hashDestination } = await import("../src/lib/crypto");
  const inserted = await (env.DB as D1Database).prepare(
    "INSERT INTO destinations (user_id, email, email_hash, token, created_at) VALUES (1, ?, ?, ?, ?) RETURNING id"
  ).bind(
    await encryptDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY),
    await hashDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY),
    "cooldown-token",
    Date.now()
  ).first<{ id: number }>();
  const sent: any[] = [];
  const requestEnv = {
    ...testEnv,
    SES_ACCESS_KEY_ID: "akid",
    SES_SECRET_ACCESS_KEY: "secret",
    SES_REGION: "ap-southeast-2",
    __sesSend: async (...args: any[]) => { sent.push(args); return "message-id"; },
  };
  const app = createApp();

  const first = await app.request(`/api/destinations/${inserted!.id}/resend`, {
    method: "POST", headers: { cookie },
  }, requestEnv);
  const second = await app.request(`/api/destinations/${inserted!.id}/resend`, {
    method: "POST", headers: { cookie },
  }, requestEnv);

  expect(first.status).toBe(200);
  expect(second.status).toBe(429);
  expect(await second.json()).toEqual({ error: "Please wait before resending verification email" });
  expect(sent).toHaveLength(1);
});

test("POST /api/destinations/:id/resend atomically rate limits concurrent sends", async () => {
  const email = "concurrent-cooldown@example.com";
  const { encryptDestination, hashDestination } = await import("../src/lib/crypto");
  const inserted = await (env.DB as D1Database).prepare(
    "INSERT INTO destinations (user_id, email, email_hash, token, created_at) VALUES (1, ?, ?, ?, ?) RETURNING id"
  ).bind(
    await encryptDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY),
    await hashDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY),
    "concurrent-cooldown-token",
    Date.now()
  ).first<{ id: number }>();
  const sent: any[] = [];
  const requestEnv = {
    ...testEnv,
    SES_ACCESS_KEY_ID: "akid",
    SES_SECRET_ACCESS_KEY: "secret",
    SES_REGION: "ap-southeast-2",
    __sesSend: async (...args: any[]) => { sent.push(args); return "message-id"; },
  };
  const app = createApp();
  const request = () => app.request(`/api/destinations/${inserted!.id}/resend`, {
    method: "POST",
    headers: { cookie },
  }, requestEnv);

  const responses = await Promise.all([request(), request()]);

  expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
  expect(sent).toHaveLength(1);
  const rejected = responses.find((response) => response.status === 429)!;
  expect(await rejected.json()).toEqual({ error: "Please wait before resending verification email" });
});

test("POST /api/destinations/:id/resend rejects malformed and zero ids", async () => {
  for (const id of ["wat", "0"]) {
    const res = await createApp().request(`/api/destinations/${id}/resend`, {
      method: "POST",
      headers: { cookie },
    }, testEnv);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid id" });
  }
});

test("POST /api/destinations/:id/resend rejects a verified destination without sending", async () => {
  const { encryptDestination, hashDestination } = await import("../src/lib/crypto");
  const email = "verified@example.com";
  const inserted = await (env.DB as D1Database).prepare(
    "INSERT INTO destinations (user_id, email, email_hash, token, verified_at, created_at) VALUES (1, ?, ?, ?, ?, ?) RETURNING id"
  ).bind(
    await encryptDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY),
    await hashDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY),
    "verified-token",
    Date.now(),
    Date.now()
  ).first<{ id: number }>();
  const sent: any[] = [];

  const res = await createApp().request(`/api/destinations/${inserted!.id}/resend`, {
    method: "POST",
    headers: { cookie },
  }, { ...testEnv, __sesSend: async (...args: any[]) => { sent.push(args); return "message-id"; } });

  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "Destination is already verified" });
  expect(sent).toHaveLength(0);
  const cooldown = await (env.DB as D1Database).prepare("SELECT reset_at FROM rate_limits WHERE ip = ?")
    .bind(`destination-resend:1:${inserted!.id}`).first();
  expect(cooldown).toBeNull();
});

test("POST /api/destinations/:id/resend hides another user's destination without sending", async () => {
  const db = env.DB as D1Database;
  await db.prepare("INSERT INTO users (id, passphrase_hash, created_at) VALUES (2, 'hash', ?)").bind(Date.now()).run();
  const { encryptDestination, hashDestination } = await import("../src/lib/crypto");
  const email = "other@example.com";
  const inserted = await db.prepare(
    "INSERT INTO destinations (user_id, email, email_hash, token, created_at) VALUES (2, ?, ?, ?, ?) RETURNING id"
  ).bind(
    await encryptDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY),
    await hashDestination(email, testEnv.DESTINATION_ENCRYPTION_KEY),
    "other-token",
    Date.now()
  ).first<{ id: number }>();
  const sent: any[] = [];

  const res = await createApp().request(`/api/destinations/${inserted!.id}/resend`, {
    method: "POST",
    headers: { cookie },
  }, { ...testEnv, __sesSend: async (...args: any[]) => { sent.push(args); return "message-id"; } });

  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "Destination not found" });
  expect(sent).toHaveLength(0);
  const cooldown = await db.prepare("SELECT reset_at FROM rate_limits WHERE ip = ?")
    .bind(`destination-resend:1:${inserted!.id}`).first();
  expect(cooldown).toBeNull();
});

test("admin can send a selected test email type to an arbitrary destination", async () => {
  const sent: any[] = [];
  const app = createApp();
  const res = await app.request("/api/admin/test-email", {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "mfa", to: "operator@example.com" }),
  }, {
    ...testEnv,
    SES_ACCESS_KEY_ID: "akid",
    SES_SECRET_ACCESS_KEY: "secret",
    SES_REGION: "ap-southeast-2",
    __sesSend: async (_c: any, m: any) => { sent.push(m); return "message-id"; },
  });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, type: "mfa", to: "operator@example.com" });
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toBe("operator@example.com");
  expect(sent[0].from).toBe("HideMyEmail <noreply@example.com>");
  const decoded = atob(sent[0].rawBase64);
  expect(decoded).toContain("Your Authentication Code");
  expect(decoded).toContain("123456");
});

test("admin test email rejects invalid type and destination", async () => {
  const app = createApp();
  const invalidEmail = await app.request("/api/admin/test-email", {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "mfa", to: "not-an-email" }),
  }, testEnv);
  expect(invalidEmail.status).toBe(400);

  const invalidType = await app.request("/api/admin/test-email", {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "unknown", to: "operator@example.com" }),
  }, testEnv);
  expect(invalidType.status).toBe(400);
});
