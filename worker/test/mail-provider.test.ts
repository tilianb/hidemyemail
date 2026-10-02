import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  MailPermanentError,
  MailRetryableError,
  MailUncertainError,
  sendMail,
} from "../src/lib/mail-provider";
import { getHeader, parseMime, removeProviderControlHeaders, serializeMime } from "../src/lib/mime";
import { encryptDestination } from "../src/lib/crypto";
import { getEnvWithOverride } from "../src/lib/settings";
import { createApp } from "../src/api/app";
import { signFreshAuth, signSession } from "../src/lib/auth";

const message = { from: "Alias <alias@example.com>", to: "person@example.net", rawBase64: "VGVzdA==" };

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'smtp_%' OR key='mail_outbound_provider'").run();
});

describe("mail provider selection", () => {
  test("keeps SES as the default and preserves its envelope and MIME", async () => {
    const ses = vi.fn(async (_creds, sent) => {
      expect(sent).toEqual(message);
      return "ses-id";
    });
    const result = await sendMail(env.DB as D1Database, {
      SES_ACCESS_KEY_ID: "key",
      SES_SECRET_ACCESS_KEY: "secret",
      SES_REGION: "eu-west-1",
      __sesSend: ses,
    } as any, message);
    expect(result).toEqual({ providerId: "ses-id" });
    expect(ses).toHaveBeenCalledOnce();
  });

  test("uses only the private SMTP binding when smtp is selected", async () => {
    const fetch = vi.fn(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual(message);
      return Response.json({ providerId: "smtp-id" }, { status: 202 });
    });
    const result = await sendMail(env.DB as D1Database, {
      MAIL_OUTBOUND_PROVIDER: "smtp",
      SMTP_TRANSPORT: { fetch },
    } as any, message);
    expect(result).toEqual({ providerId: "smtp-id" });
  });

  test("fails clearly when Cloudflare is configured for Docker-only SMTP", async () => {
    await expect(sendMail(env.DB as D1Database, { MAIL_OUTBOUND_PROVIDER: "smtp" } as any, message))
      .rejects.toThrow(/Docker-only SMTP_TRANSPORT/);
  });

  test.each([
    [400, MailPermanentError],
    [421, MailRetryableError],
    [504, MailUncertainError],
  ])("maps private transport status %i", async (status, ErrorType) => {
    await expect(sendMail(env.DB as D1Database, {
      MAIL_OUTBOUND_PROVIDER: "smtp",
      SMTP_TRANSPORT: { fetch: async () => new Response("rejected", { status }) },
    } as any, message)).rejects.toBeInstanceOf(ErrorType);
  });

  test("treats a lost private-binding response as uncertain acceptance", async () => {
    await expect(sendMail(env.DB as D1Database, {
      MAIL_OUTBOUND_PROVIDER: "smtp",
      SMTP_TRANSPORT: { fetch: async () => { throw new Error("connection reset"); } },
    } as any, message)).rejects.toBeInstanceOf(MailUncertainError);
  });
});

test("strips SMTP supplier controls without changing MIME content", () => {
  const raw = new TextEncoder().encode([
    "Subject: Keep me", "Resend-Idempotency-Key: attacker", "X-MC-Track: opens",
    "X-SMTPAPI: {\"to\":[\"victim@example.net\"]}", "X-Mailgun-Recipient-Variables: {}",
    "Content-Type: multipart/mixed; boundary=x", "", "--x\r\nattachment bytes\r\n--x--", "",
  ].join("\r\n"));
  const sanitized = removeProviderControlHeaders(parseMime(raw));
  expect(getHeader(sanitized, "Subject")).toBe("Keep me");
  expect(sanitized.headers.map((header) => header.name.toLowerCase())).not.toEqual(expect.arrayContaining([
    "resend-idempotency-key", "x-mc-track", "x-smtpapi", "x-mailgun-recipient-variables",
  ]));
  expect(new TextDecoder().decode(serializeMime(sanitized))).toContain("attachment bytes");
});

test("explicit settings override env, empty disables it, and reset restores env", async () => {
  const db = env.DB as D1Database;
  const runtime = { SMTP_OUTBOUND_PORT: "587" };
  expect(await getEnvWithOverride(db, runtime, "smtp_outbound_port")).toBe("587");
  await db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('smtp_outbound_port','465',?)").bind(Date.now()).run();
  expect(await getEnvWithOverride(db, runtime, "smtp_outbound_port")).toBe("465");
  await db.prepare("UPDATE settings SET value='' WHERE key='smtp_outbound_port'").run();
  expect(await getEnvWithOverride(db, runtime, "smtp_outbound_port")).toBe("");
  await db.prepare("DELETE FROM settings WHERE key='smtp_outbound_port'").run();
  expect(await getEnvWithOverride(db, runtime, "smtp_outbound_port")).toBe("587");
});

test("decrypts stored SMTP passwords without exposing ciphertext", async () => {
  const db = env.DB as D1Database;
  const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const encrypted = await encryptDestination("replacement-secret", key);
  await db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('smtp_outbound_password',?,?)").bind(encrypted, Date.now()).run();
  expect(await getEnvWithOverride(db, { DESTINATION_ENCRYPTION_KEY: key, SMTP_OUTBOUND_PASSWORD: "env-secret" }, "smtp_outbound_password"))
    .toBe("replacement-secret");
});

test("admin mail settings require fresh auth, mask encrypted credentials, and reset to env", async () => {
  const db = env.DB as D1Database;
  const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const runtime = {
    ...env,
    SESSION_SECRET: "settings-secret",
    DESTINATION_ENCRYPTION_KEY: key,
    MAIL_OUTBOUND_PROVIDER: "ses",
    SMTP_OUTBOUND_HOST: "env.smtp.example",
    SMTP_OUTBOUND_PORT: "587",
    SMTP_OUTBOUND_TLS: "starttls",
    SMTP_OUTBOUND_USERNAME: "env-user",
    SMTP_OUTBOUND_PASSWORD: "env-password",
  } as any;
  const session = `__Host-session=${await signSession(runtime.SESSION_SECRET, 1, 3600)}`;
  const body = {
    mail_outbound_provider: "smtp", smtp_outbound_host: "override.smtp.example",
    smtp_outbound_port: "465", smtp_outbound_tls: "implicit",
    smtp_outbound_username: "override-user", smtp_outbound_password: "override-password",
  };
  const app = createApp();
  const stale = await app.request("/api/admin/settings", {
    method: "PATCH", headers: { cookie: session, "content-type": "application/json" }, body: JSON.stringify(body),
  }, runtime);
  expect(stale.status).toBe(401);

  const fresh = `__Host-fresh-auth=${await signFreshAuth(runtime.SESSION_SECRET, 1, 300)}`;
  const saved = await app.request("/api/admin/settings", {
    method: "PATCH", headers: { cookie: `${session}; ${fresh}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }, runtime);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ restart_required: true });
  expect(await getEnvWithOverride(db, runtime, "smtp_outbound_username")).toBe("override-user");
  expect(await getEnvWithOverride(db, runtime, "smtp_outbound_password")).toBe("override-password");

  const listed = await app.request("/api/admin/settings", { headers: { cookie: session } }, runtime);
  const settings = (await listed.json() as any).settings;
  expect(settings.smtp_outbound_password).toMatchObject({ value: "•••••• configured", source: "override" });
  expect(JSON.stringify(settings)).not.toContain("override-password");
  expect(JSON.stringify(settings)).not.toContain("env-password");

  const removed = await app.request("/api/admin/settings", {
    method: "PATCH", headers: { cookie: `${session}; ${fresh}`, "content-type": "application/json" },
    body: JSON.stringify({ smtp_outbound_username: "", smtp_outbound_password: "" }),
  }, runtime);
  expect(removed.status).toBe(200);
  expect(await getEnvWithOverride(db, runtime, "smtp_outbound_password")).toBe("");
  const afterRemoval = await app.request("/api/admin/settings", { headers: { cookie: session } }, runtime);
  expect((await afterRemoval.json() as any).settings.smtp_outbound_password).toMatchObject({ value: "", source: "override" });

  const reset = await app.request("/api/admin/settings", {
    method: "PATCH", headers: { cookie: `${session}; ${fresh}`, "content-type": "application/json" },
    body: JSON.stringify(Object.fromEntries(Object.keys(body).map((setting) => [setting, null]))),
  }, runtime);
  expect(reset.status).toBe(200);
  expect(await getEnvWithOverride(db, runtime, "smtp_outbound_host")).toBe("env.smtp.example");
  expect(await getEnvWithOverride(db, runtime, "smtp_outbound_password")).toBe("env-password");
});
