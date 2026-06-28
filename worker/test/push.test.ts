import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import * as q from "../src/db/queries";
import { pushToUser } from "../src/lib/push";
import { getProviderToken, __clearProviderTokenCache, type ApnsConfig } from "../src/lib/apns";
import { resetDb } from "./helpers";

const DB = () => env.DB as D1Database;
beforeEach(async () => { await resetDb(DB()); });

// Generate a real P-256 signing key so the provider-JWT path is exercised end
// to end (import + ECDSA sign), returned as the base64 a .p8 would decode to.
async function makeAuthKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer);
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function pushEnv(extra: Record<string, unknown>) {
  return {
    ...env,
    APNS_KEY_ID: "ABC1234567",
    APNS_TEAM_ID: "TEAM123456",
    APNS_BUNDLE_ID: "dev.hidemyemail.app",
    APNS_AUTH_KEY: await makeAuthKey(),
    ...extra,
  } as any;
}

test("upsert is idempotent on token and re-points to the latest user", async () => {
  await q.upsertPushDevice(DB(), 1, "tok-a", "ios", undefined, Date.now());
  await q.upsertPushDevice(DB(), 1, "tok-a", "ios", { forward: true }, Date.now());
  const rows = await q.listPushDevices(DB(), 1);
  expect(rows.length).toBe(1);
  expect(rows[0]!.notify_forward).toBe(1);
});

test("tokensForCategory honours per-device opt-in defaults", async () => {
  // Defaults: blocked/bounce on, forward/reply off.
  await q.upsertPushDevice(DB(), 1, "tok-a", "ios", undefined, Date.now());
  expect(await q.tokensForCategory(DB(), 1, "blocked")).toEqual(["tok-a"]);
  expect(await q.tokensForCategory(DB(), 1, "forward")).toEqual([]);
  await q.updatePushPrefs(DB(), 1, "tok-a", { forward: true });
  expect(await q.tokensForCategory(DB(), 1, "forward")).toEqual(["tok-a"]);
});

test("updatePushPrefs only affects the owner's token", async () => {
  await q.upsertPushDevice(DB(), 1, "tok-a", "ios", undefined, Date.now());
  const changed = await q.updatePushPrefs(DB(), 2, "tok-a", { blocked: false });
  expect(changed).toBe(false);
  expect(await q.tokensForCategory(DB(), 1, "blocked")).toEqual(["tok-a"]);
});

test("pushToUser is a no-op when APNs is unconfigured", async () => {
  await q.upsertPushDevice(DB(), 1, "tok-a", "ios", undefined, Date.now());
  let calls = 0;
  const e = { ...env, __apnsFetch: async () => { calls++; return new Response("", { status: 200 }); } } as any;
  await pushToUser(e, 1, "blocked", "t", "b");
  expect(calls).toBe(0); // no APNS_* vars → skipped before any fetch
});

test("pushToUser sends to opted-in tokens and prunes dead ones", async () => {
  await q.upsertPushDevice(DB(), 1, "good-token", "ios", undefined, Date.now());
  await q.upsertPushDevice(DB(), 1, "dead-token", "ios", undefined, Date.now());

  const seen: string[] = [];
  const e = await pushEnv({
    __apnsFetch: async (url: string) => {
      seen.push(url);
      if (url.endsWith("/dead-token")) {
        return new Response(JSON.stringify({ reason: "Unregistered" }), { status: 410 });
      }
      return new Response("", { status: 200 });
    },
  });

  await pushToUser(e, 1, "blocked", "Mail blocked", "body");

  expect(seen.length).toBe(2);
  // The 410 token is pruned; the healthy one remains.
  const remaining = (await q.listPushDevices(DB(), 1)).map((d) => d.token);
  expect(remaining).toEqual(["good-token"]);
});

test("hardDeleteUser removes the user's push devices", async () => {
  const u = await DB().prepare("INSERT INTO users (passphrase_hash, created_at) VALUES (?, ?)")
    .bind(`hash-${Date.now()}`, Date.now()).run();
  const userId = u.meta.last_row_id as number;
  await q.upsertPushDevice(DB(), userId, "tok-purge", "ios", undefined, Date.now());

  const { hardDeleteUser } = await import("../src/lib/purge");
  await hardDeleteUser(DB(), userId);

  expect(await q.listPushDevices(DB(), userId)).toEqual([]);
});

test("provider token is reused within the refresh window and re-minted after", async () => {
  __clearProviderTokenCache();
  const cfg: ApnsConfig = {
    keyId: "ABC1234567", teamId: "TEAM123456",
    authKey: await makeAuthKey(), bundleId: "dev.hidemyemail.app", host: "api.push.apple.com",
  };
  const t1 = await getProviderToken(cfg, 1_000);
  const t2 = await getProviderToken(cfg, 1_000 + 10 * 60); // 10 min later → cached
  expect(t2).toBe(t1);
  const t3 = await getProviderToken(cfg, 1_000 + 31 * 60); // past 30 min → re-minted
  expect(t3).not.toBe(t1);
});

test("pushToUser skips categories the device opted out of", async () => {
  await q.upsertPushDevice(DB(), 1, "tok-a", "ios", undefined, Date.now()); // forward off by default
  let calls = 0;
  const e = await pushEnv({ __apnsFetch: async () => { calls++; return new Response("", { status: 200 }); } });
  await pushToUser(e, 1, "forward", "t", "b");
  expect(calls).toBe(0);
});
