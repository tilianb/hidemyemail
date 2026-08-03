import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/api/app";
import { derivePassphraseHash, hashPassword, signFreshAuth, signSession, verifyFreshAuth } from "../src/lib/auth";
import { encryptDestination } from "../src/lib/crypto";
import { hashBackupCode } from "../src/lib/totp";

let testEnv: Record<string, unknown>;
let bearer: string;
let fresh: string;

beforeAll(async () => {
  const { saltHex, hashHex } = await hashPassword("current-passphrase");
  testEnv = {
    ...env,
    APP_ORIGIN: "https://app.example.com",
    SESSION_SECRET: "native-security-secret",
    AUTH_PASSWORD_SALT: saltHex,
    AUTH_PASSWORD_HASH: hashHex,
  };
  bearer = await signSession("native-security-secret", 1, 3600, 0);
  fresh = await signFreshAuth("native-security-secret", 1, 3600, 0);
});

beforeEach(async () => {
  await (env.DB as D1Database).prepare("DELETE FROM rate_limits").run();
  await (env.DB as D1Database).prepare("DELETE FROM consumed_auth_artifacts").run();
  await (env.DB as D1Database).prepare("DELETE FROM passkey_credentials WHERE id LIKE 'reauth-test-%'").run();
  await (env.DB as D1Database).prepare("DELETE FROM mfa WHERE user_id = 1").run();
  await (env.DB as D1Database).prepare("DELETE FROM users WHERE id = 2").run();
  await (env.DB as D1Database).prepare("UPDATE users SET auth_version = 0, active = 1, deleted_at = NULL WHERE id = 1").run();
});

const nativeHeaders = (withFresh = false) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${bearer}`,
  "X-Auth-Mode": "token",
  ...(withFresh ? { "X-Fresh-Auth": fresh } : {}),
});

describe("inline native reauthentication", () => {
  test("web reauth requires the exact canonical Origin and sets only fresh auth", async () => {
    const request = (origin?: string) => createApp().request("/api/settings/reauth", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `__Host-session=${bearer}`, ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ passphrase: "current-passphrase" }),
    }, testEnv);
    expect((await request()).status).toBe(400);
    expect((await request("https://app.example.com/")).status).toBe(400);
    const response = await request("https://app.example.com");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Host-fresh-auth=");
    expect(cookie).not.toContain("__Host-session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  test("accepts a valid passphrase longer than 1024 characters like login", async () => {
    const passphrase = "long-valid-passphrase-".repeat(60);
    const { saltHex, hashHex } = await hashPassword(passphrase);
    const response = await createApp().request("/api/settings/reauth", {
      method: "POST",
      headers: nativeHeaders(),
      body: JSON.stringify({ passphrase }),
    }, { ...testEnv, AUTH_PASSWORD_SALT: saltHex, AUTH_PASSWORD_HASH: hashHex });

    expect(response.status).toBe(200);
  });

  test("rejects a cookie-authenticated request spoofing token mode", async () => {
    const response = await createApp().request("/api/settings/reauth", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `__Host-session=${bearer}`,
        "X-Auth-Mode": "token",
      },
      body: JSON.stringify({ passphrase: "current-passphrase" }),
    }, testEnv);

    expect(response.status).toBe(400);
  });

  test("returns only a version-bound fresh_auth token", async () => {
    const response = await createApp().request("/api/settings/reauth", {
      method: "POST",
      headers: nativeHeaders(),
      body: JSON.stringify({ passphrase: "current-passphrase" }),
    }, testEnv);

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["fresh_auth"]);
    expect(await verifyFreshAuth("native-security-secret", body.fresh_auth as string, 1, 0)).toBe(true);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("rejects browser origins and rate-limits indistinguishable failures", async () => {
    const browser = await createApp().request("/api/settings/reauth", {
      method: "POST", headers: { ...nativeHeaders(), Origin: "https://app.example.com" },
      body: JSON.stringify({ passphrase: "current-passphrase" }),
    }, testEnv);
    expect(browser.status).toBe(400);

    for (let i = 0; i < 10; i++) {
      const failed = await createApp().request("/api/settings/reauth", {
        method: "POST", headers: { ...nativeHeaders(), "cf-connecting-ip": "192.0.2.10" },
        body: JSON.stringify({ passphrase: "wrong", code: "wrong" }),
      }, testEnv);
      expect(failed.status).toBe(401);
      expect(await failed.json()).toEqual({ error: "Invalid credentials" });
    }
    const limited = await createApp().request("/api/settings/reauth", {
      method: "POST", headers: { ...nativeHeaders(), "cf-connecting-ip": "192.0.2.10" },
      body: JSON.stringify({ passphrase: "wrong" }),
    }, testEnv);
    expect(limited.status).toBe(429);
  });

  test("consumes a valid MFA backup code only after the passphrase also succeeds", async () => {
    const backupCode = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-AB";
    const encrypted = await encryptDestination("JBSWY3DPEHPK3PXP", testEnv.DESTINATION_ENCRYPTION_KEY as string);
    await (env.DB as D1Database).prepare(
      "INSERT INTO mfa (user_id, totp_secret, totp_enabled, totp_backup_codes) VALUES (1, ?, 1, ?)"
    ).bind(encrypted, JSON.stringify([await hashBackupCode(backupCode)])).run();

    const wrong = await createApp().request("/api/settings/reauth", {
      method: "POST", headers: nativeHeaders(),
      body: JSON.stringify({ passphrase: "wrong", code: backupCode }),
    }, testEnv);
    expect(wrong.status).toBe(401);
    const afterWrong = await (env.DB as D1Database).prepare("SELECT totp_backup_codes FROM mfa WHERE user_id = 1")
      .first<{ totp_backup_codes: string }>();
    expect(JSON.parse(afterWrong!.totp_backup_codes)).toHaveLength(1);

    const correct = await createApp().request("/api/settings/reauth", {
      method: "POST", headers: nativeHeaders(),
      body: JSON.stringify({ passphrase: "current-passphrase", code: backupCode }),
    }, testEnv);
    expect(correct.status).toBe(200);
    const replay = await createApp().request("/api/settings/reauth", {
      method: "POST", headers: nativeHeaders(),
      body: JSON.stringify({ passphrase: "current-passphrase", code: backupCode }),
    }, testEnv);
    expect(replay.status).toBe(401);
  });

  test("passkey reauth challenge is account-bound and uses only its channel transport", async () => {
    await (env.DB as D1Database).prepare(
      "INSERT INTO passkey_credentials (id, user_id, public_key, sign_count, transports, created_at) VALUES (?, 1, ?, 0, ?, ?)"
    ).bind("reauth-test-admin", "unused-for-challenge", JSON.stringify(["internal"]), Date.now()).run();

    const web = await createApp().request("/api/settings/reauth/passkey/challenge", {
      method: "POST",
      headers: { Cookie: `__Host-session=${bearer}`, Origin: "https://app.example.com" },
    }, testEnv);
    expect(web.status).toBe(200);
    const webBody = await web.json() as Record<string, unknown>;
    expect(webBody.passkey_token).toBeUndefined();
    expect((webBody.allowCredentials as { id: string }[]).map(x => x.id)).toEqual(["reauth-test-admin"]);
    expect(web.headers.get("set-cookie")).toContain("__Host-reauth-passkey=");
    expect(web.headers.get("set-cookie")).not.toContain("__Host-fresh-auth=");
    expect(web.headers.get("cache-control")).toBe("no-store");

    const native = await createApp().request("/api/settings/reauth/passkey/challenge", {
      method: "POST", headers: nativeHeaders(),
    }, testEnv);
    expect(native.status).toBe(200);
    const nativeBody = await native.json() as Record<string, unknown>;
    expect(typeof nativeBody.passkey_token).toBe("string");
    expect((nativeBody.allowCredentials as { id: string }[]).map(x => x.id)).toEqual(["reauth-test-admin"]);
    expect(native.headers.get("set-cookie")).toBeNull();

    const transferred = await createApp().request("/api/settings/reauth/passkey/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `__Host-session=${bearer}`, Origin: "https://app.example.com" },
      body: JSON.stringify({ response: { id: "reauth-test-admin" }, passkey_token: nativeBody.passkey_token }),
    }, testEnv);
    expect(transferred.status).toBe(401);
  }, 10_000);

  test("auth-version rotation invalidates a passkey reauth challenge before assertion verification", async () => {
    await (env.DB as D1Database).prepare(
      "INSERT INTO passkey_credentials (id, user_id, public_key, sign_count, created_at) VALUES (?, 1, ?, 0, ?)"
    ).bind("reauth-test-stale", "unused-for-challenge", Date.now()).run();
    const challenge = await createApp().request("/api/settings/reauth/passkey/challenge", {
      method: "POST", headers: nativeHeaders(),
    }, testEnv);
    const token = (await challenge.json() as { passkey_token: string }).passkey_token;

    await (env.DB as D1Database).prepare("UPDATE users SET auth_version = 1 WHERE id = 1").run();
    const rotatedBearer = await signSession("native-security-secret", 1, 3600, 1);
    const response = await createApp().request("/api/settings/reauth/passkey/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rotatedBearer}`,
        "X-Auth-Mode": "token",
      },
      body: JSON.stringify({ response: { id: "reauth-test-stale" }, passkey_token: token }),
    }, testEnv);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid or expired passkey challenge" });
  });
});

describe("native passkey registration contract", () => {
  test("rejects cookie-only token-mode challenge and register requests", async () => {
    const headers = {
      "Content-Type": "application/json",
      Cookie: `__Host-session=${bearer}; __Host-fresh-auth=${fresh}`,
      "X-Auth-Mode": "token",
    };
    const challenge = await createApp().request("/api/settings/passkeys/challenge", {
      method: "POST", headers,
    }, testEnv);
    expect(challenge.status).toBe(400);

    const register = await createApp().request("/api/settings/passkeys/register", {
      method: "POST", headers, body: JSON.stringify({ response: {} }),
    }, testEnv);
    expect(register.status).toBe(400);
  });

  test("native challenge requires X-Fresh-Auth instead of a fresh-auth cookie", async () => {
    const response = await createApp().request("/api/settings/passkeys/challenge", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "X-Auth-Mode": "token",
        Cookie: `__Host-fresh-auth=${fresh}`,
      },
    }, testEnv);
    expect(response.status).toBe(401);
  });

  test("returns an auth-version-bound challengeToken without a registration cookie", async () => {
    const response = await createApp().request("/api/settings/passkeys/challenge", {
      method: "POST", headers: nativeHeaders(true),
    }, testEnv);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body.challenge).toBe("string");
    expect(typeof body.challengeToken).toBe("string");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("fails closed for malformed Android origins", async () => {
    const response = await createApp().request("/api/settings/passkeys/challenge", {
      method: "POST", headers: nativeHeaders(true),
    }, { ...testEnv, ANDROID_APP_ORIGINS: "android:apk-key-hash:not+base64" });
    expect(response.status).toBe(500);
  });

  test("browser challenge ignores malformed optional Android origins", async () => {
    const response = await createApp().request("/api/settings/passkeys/challenge", {
      method: "POST",
      headers: { Cookie: `__Host-session=${bearer}; __Host-fresh-auth=${fresh}` },
    }, { ...testEnv, ANDROID_APP_ORIGINS: "android:apk-key-hash:not+base64" });
    expect(response.status).toBe(200);
  });

  test("challenge token is one-use and auth-version-bound", async () => {
    const challenge = await createApp().request("/api/settings/passkeys/challenge", {
      method: "POST", headers: nativeHeaders(true),
    }, testEnv);
    const { challengeToken } = await challenge.json() as { challengeToken: string };
    const invalidRegistration = {
      method: "POST",
      headers: nativeHeaders(true),
      body: JSON.stringify({ response: { id: "invalid" }, challengeToken }),
    };

    const first = await createApp().request("/api/settings/passkeys/register", invalidRegistration, testEnv);
    expect(first.status).toBe(400);
    const replay = await createApp().request("/api/settings/passkeys/register", invalidRegistration, testEnv);
    expect(replay.status).toBe(401);

    const nextChallenge = await createApp().request("/api/settings/passkeys/challenge", {
      method: "POST", headers: nativeHeaders(true),
    }, testEnv);
    const nextToken = (await nextChallenge.json() as { challengeToken: string }).challengeToken;
    await (env.DB as D1Database).prepare("UPDATE users SET auth_version = 1 WHERE id = 1").run();
    const rotatedBearer = await signSession("native-security-secret", 1, 3600, 1);
    const rotatedFresh = await signFreshAuth("native-security-secret", 1, 3600, 1);
    const rotated = await createApp().request("/api/settings/passkeys/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rotatedBearer}`,
        "X-Auth-Mode": "token",
        "X-Fresh-Auth": rotatedFresh,
      },
      body: JSON.stringify({ response: { id: "invalid" }, challengeToken: nextToken }),
    }, testEnv);
    expect(rotated.status).toBe(401);
  });
});

describe("native Security browser handoff", () => {
  test("rejects cookie-only token mode and bearer auth with only a fresh-auth cookie", async () => {
    const cookieOnly = await createApp().request("/api/settings/security-handoff", {
      method: "POST",
      headers: {
        Cookie: `__Host-session=${bearer}; __Host-fresh-auth=${fresh}`,
        "X-Auth-Mode": "token",
      },
    }, testEnv);
    expect(cookieOnly.status).toBe(400);

    const cookieFresh = await createApp().request("/api/settings/security-handoff", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        Cookie: `__Host-fresh-auth=${fresh}`,
        "X-Auth-Mode": "token",
      },
    }, testEnv);
    expect(cookieFresh.status).toBe(401);
  });

  test("GET confirms without consuming or setting cookies, then same-origin POST consumes once", async () => {
    const minted = await createApp().request("/api/settings/security-handoff", {
      method: "POST", headers: nativeHeaders(true),
    }, testEnv);
    expect(minted.status).toBe(200);
    const { url } = await minted.json() as { url: string };
    expect(url.startsWith("https://app.example.com/security-handoff?code=")).toBe(true);
    expect(url).not.toContain(bearer);

    const path = new URL(url).pathname + new URL(url).search;
    const firstGet = await createApp().request(path, {}, testEnv);
    expect(firstGet.status).toBe(200);
    expect(firstGet.headers.get("set-cookie")).toBeNull();
    expect(firstGet.headers.get("cache-control")).toBe("no-store");
    expect(firstGet.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await firstGet.text()).toContain('<form method="post" action="/security-handoff">');
    const secondGet = await createApp().request(path, {}, testEnv);
    expect(secondGet.status).toBe(200);

    const code = new URL(url).searchParams.get("code")!;
    const redeemed = await createApp().request("/security-handoff", {
      method: "POST",
      headers: { Origin: "https://app.example.com", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code }).toString(),
    }, testEnv);
    expect(redeemed.status).toBe(303);
    expect(redeemed.headers.get("location")).toBe("https://app.example.com/#settings");
    const cookies = redeemed.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("__Host-session=");
    expect(cookies).toContain("__Host-fresh-auth=");

    const replay = await createApp().request("/security-handoff", {
      method: "POST",
      headers: { Origin: "https://app.example.com", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code }).toString(),
    }, testEnv);
    expect(replay.status).toBe(401);
  });

  test("POST rejects missing and cross-origin Origin", async () => {
    const minted = await createApp().request("/api/settings/security-handoff", {
      method: "POST", headers: nativeHeaders(true),
    }, testEnv);
    const code = new URL((await minted.json() as { url: string }).url).searchParams.get("code")!;
    for (const origin of [undefined, "https://evil.example"]) {
      const response = await createApp().request("/security-handoff", {
        method: "POST",
        headers: { ...(origin ? { Origin: origin } : {}), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code }).toString(),
      }, testEnv);
      expect(response.status).toBe(403);
    }
  });

  test("different-user session cannot be silently switched", async () => {
    const hash = await derivePassphraseHash("other", testEnv.AUTH_PASSWORD_SALT as string);
    await (env.DB as D1Database).prepare("INSERT INTO users (id, passphrase_hash, created_at) VALUES (2, ?, ?)")
      .bind(hash, Date.now()).run();
    const otherCookie = await signSession("native-security-secret", 2, 3600, 0);
    const minted = await createApp().request("/api/settings/security-handoff", {
      method: "POST", headers: nativeHeaders(true),
    }, testEnv);
    const url = new URL((await minted.json() as { url: string }).url);
    const headers = { Cookie: `__Host-session=${otherCookie}` };
    const confirmation = await createApp().request(url.pathname + url.search, { headers }, testEnv);
    expect(confirmation.status).toBe(409);
    expect(await confirmation.text()).not.toContain(url.searchParams.get("code")!);

    const redeemed = await createApp().request("/security-handoff", {
      method: "POST",
      headers: { ...headers, Origin: "https://app.example.com", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: url.searchParams.get("code")! }).toString(),
    }, testEnv);
    expect(redeemed.status).toBe(409);
    expect(redeemed.headers.get("set-cookie")).toBeNull();
  });

  test("mint rejects Origin and assetlinks shares strict Android association config", async () => {
    const rejected = await createApp().request("/api/settings/security-handoff", {
      method: "POST", headers: { ...nativeHeaders(true), Origin: "https://app.example.com" },
    }, testEnv);
    expect(rejected.status).toBe(400);

    const missing = await createApp().request("/.well-known/assetlinks.json", {}, {
      ...testEnv, ANDROID_APP_ORIGINS: undefined,
    });
    expect(missing.status).toBe(404);
    const malformed = await createApp().request("/.well-known/assetlinks.json", {}, {
      ...testEnv, ANDROID_APP_ORIGINS: "malformed",
    });
    expect(malformed.status).toBe(500);
    const configured = await createApp().request("/.well-known/assetlinks.json", {}, {
      ...testEnv,
      ANDROID_APP_ORIGINS: "android:apk-key-hash:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA, android:apk-key-hash:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA,android:apk-key-hash:__________________________________________8",
    });
    expect(await configured.json()).toEqual([{
      relation: ["delegate_permission/common.get_login_creds"],
      target: {
        namespace: "android_app",
        package_name: "dev.hidemyemail.app",
        sha256_cert_fingerprints: [
          "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
          "FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF:FF",
        ],
      },
    }]);
  });

  test("auth-version rotation invalidates a minted handoff", async () => {
    const minted = await createApp().request("/api/settings/security-handoff", {
      method: "POST", headers: nativeHeaders(true),
    }, testEnv);
    const { url } = await minted.json() as { url: string };
    await (env.DB as D1Database).prepare("UPDATE users SET auth_version = 1 WHERE id = 1").run();

    const target = new URL(url);
    const redeemed = await createApp().request(target.pathname, {
      method: "POST",
      headers: { Origin: "https://app.example.com", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: target.searchParams.get("code")! }).toString(),
    }, testEnv);
    expect(redeemed.status).toBe(401);
  });
});
