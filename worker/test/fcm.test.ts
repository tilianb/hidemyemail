import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import * as q from "../src/db/queries";
import { pushToUser, sendTestPush } from "../src/lib/push";
import { fcmConfig, sendFcm, getAccessToken, __clearAccessTokenCache, type FcmConfig } from "../src/lib/fcm";
import { resetDb } from "./helpers";

const DB = () => env.DB as D1Database;
beforeEach(async () => { await resetDb(DB()); __clearAccessTokenCache(); });

// A real RSA key so the assertion-JWT path (import + RS256 sign) is exercised
// end to end, wrapped in a service-account JSON shaped like Google's.
async function makeServiceAccount(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  ) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer);
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({
    project_id: "demo-project",
    client_email: "sa@demo-project.iam.gserviceaccount.com",
    private_key: pem,
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

// A long, mixed-case, URL-safe token like FCM actually issues.
const FCM_TOKEN = `dEv1ce${"A".repeat(60)}:APA91b${"_x-Z9".repeat(8)}`;

// A fake fetch that answers both the OAuth token exchange and the FCM send.
// `sendBehaviour` decides the send response per token.
function fcmFetch(sendBehaviour: (token: string) => Response): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "fake-access-token", expires_in: 3600 }), { status: 200 });
    }
    const sent = JSON.parse(String(init?.body ?? "{}"));
    return sendBehaviour(sent?.message?.token ?? "");
  }) as unknown as typeof fetch;
}

async function fcmEnv(sendBehaviour: (token: string) => Response, extra: Record<string, unknown> = {}) {
  return {
    ...env,
    FCM_SERVICE_ACCOUNT: await makeServiceAccount(),
    // Clear APNs so these tests exercise only the FCM transport.
    APNS_AUTH_KEY: "", APNS_KEY_ID: "", APNS_TEAM_ID: "", APNS_BUNDLE_ID: "", APPLE_APP_ID: "",
    __fcmFetch: fcmFetch(sendBehaviour),
    ...extra,
  } as any;
}

test("fcmConfig is null when unset and parses a service account when present", async () => {
  expect(fcmConfig({} as any)).toBeNull();
  const cfg = fcmConfig({ FCM_SERVICE_ACCOUNT: await makeServiceAccount() } as any);
  expect(cfg?.projectId).toBe("demo-project");
  expect(cfg?.clientEmail).toBe("sa@demo-project.iam.gserviceaccount.com");
});

test("isValidFcmToken accepts realistic tokens and rejects junk", () => {
  expect(q.isValidFcmToken(FCM_TOKEN)).toBe(true);
  expect(q.isValidFcmToken("short")).toBe(false);
  expect(q.isValidFcmToken("has spaces ".repeat(10))).toBe(false);
});

test("sendFcm marks 404 / UNREGISTERED as dead and keeps others", async () => {
  const cfg = fcmConfig({ FCM_SERVICE_ACCOUNT: await makeServiceAccount() } as any) as FcmConfig;
  const token = await getAccessToken(cfg, 1_000, fcmFetch(() => new Response("", { status: 200 })));

  const ok = await sendFcm(cfg, token, FCM_TOKEN, { title: "t", body: "b" },
    fcmFetch(() => new Response("", { status: 200 })));
  expect(ok).toMatchObject({ ok: true, dead: false });

  const gone = await sendFcm(cfg, token, FCM_TOKEN, { title: "t", body: "b" },
    fcmFetch(() => new Response(JSON.stringify({ error: { status: "UNREGISTERED", message: "gone" } }), { status: 404 })));
  expect(gone).toMatchObject({ ok: false, dead: true });

  const quota = await sendFcm(cfg, token, FCM_TOKEN, { title: "t", body: "b" },
    fcmFetch(() => new Response(JSON.stringify({ error: { status: "QUOTA_EXCEEDED" } }), { status: 429 })));
  expect(quota).toMatchObject({ ok: false, dead: false });
});

test("pushToUser routes android devices to FCM and prunes a 404", async () => {
  await q.upsertPushDevice(DB(), 1, "good-fcm-token", "android", undefined, Date.now());
  await q.upsertPushDevice(DB(), 1, "dead-fcm-token", "android", undefined, Date.now());

  const e = await fcmEnv((token) =>
    token === "dead-fcm-token"
      ? new Response(JSON.stringify({ error: { status: "UNREGISTERED" } }), { status: 404 })
      : new Response("", { status: 200 }));

  await pushToUser(e, 1, "blocked", "Mail blocked", "body");

  // The 404 token is pruned; the healthy one remains.
  expect((await q.listPushDevices(DB(), 1)).map((d) => d.token)).toEqual(["good-fcm-token"]);
});

test("pushToUser is a no-op for android devices when FCM is unconfigured", async () => {
  await q.upsertPushDevice(DB(), 1, "good-fcm-token", "android", undefined, Date.now());
  let calls = 0;
  const e = { ...env, FCM_SERVICE_ACCOUNT: "", APNS_AUTH_KEY: "", APNS_KEY_ID: "",
    __fcmFetch: async () => { calls++; return new Response("", { status: 200 }); } } as any;
  await pushToUser(e, 1, "blocked", "t", "b");
  expect(calls).toBe(0);
});

test("sendTestPush delivers to an android device over FCM", async () => {
  await q.upsertPushDevice(DB(), 1, "good-fcm-token", "android", undefined, Date.now());
  const e = await fcmEnv(() => new Response("", { status: 200 }));
  const res = await sendTestPush(e, 1, Date.now());
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ ok: true, sent: 1 });
});

test("mixed iOS+Android devices each use their own transport", async () => {
  await q.upsertPushDevice(DB(), 1, "a".repeat(64), "ios", undefined, Date.now());
  await q.upsertPushDevice(DB(), 1, "good-fcm-token", "android", undefined, Date.now());

  const apnsHits: string[] = [];
  const fcmHits: string[] = [];
  const e = await fcmEnv(
    (token) => { fcmHits.push(token); return new Response("", { status: 200 }); },
    {
      APNS_KEY_ID: "ABC1234567", APNS_TEAM_ID: "TEAM123456", APNS_BUNDLE_ID: "dev.hidemyemail.app",
      APNS_AUTH_KEY: await makeApnsKey(),
      __apnsFetch: async (url: string) => { apnsHits.push(url); return new Response("", { status: 200 }); },
    },
  );

  await pushToUser(e, 1, "blocked", "Mail blocked", "body");
  expect(apnsHits.length).toBe(1);
  expect(fcmHits).toEqual(["good-fcm-token"]);
});

// A P-256 .p8-equivalent for the APNs leg of the mixed-transport test.
async function makeApnsKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer);
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  return btoa(bin);
}
