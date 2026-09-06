import { env } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { createApp } from "../src/api/app";
import { signSession, signFreshAuth } from "../src/lib/auth";

// JavaScript keeps the browser client's DOM types out of the Worker tsconfig.
// The dashboard build typechecks that client against its own browser libraries.
afterEach(() => vi.unstubAllGlobals());

test("a stale dashboard cannot mutate or export the account signed in by another tab", async () => {
  vi.resetModules();
  const { api } = await import("../../dashboard/src/api");
  const app = createApp();
  const db = env.DB;
  const secret = "dashboard-binding-test";
  const users = await Promise.all(["tab-a", "tab-b"].map(async name => {
    const row = await db.prepare("INSERT INTO users (passphrase_hash, name, active, created_at) VALUES (?, ?, 1, ?)")
      .bind(crypto.randomUUID(), name, Date.now()).run();
    const id = Number(row.meta.last_row_id);
    return { id, cookie: `__Host-session=${await signSession(secret, id, 3600)}; __Host-fresh-auth=${await signFreshAuth(secret, id, 600)}` };
  }));
  let cookie = users[0].cookie;
  vi.stubGlobal("fetch", async (path, init) => {
    const headers = new Headers(init?.headers);
    headers.set("cookie", cookie);
    return app.request(path, { ...init, headers }, { ...env, SESSION_SECRET: secret });
  });

  expect((await api.profile()).id).toBe(users[0].id);
  expect((await api.regenerateRecoveryCodes()).codes).toHaveLength(10);
  // Another tab replaces the shared cookies, including a valid fresh credential.
  cookie = users[1].cookie;
  await expect(api.regenerateRecoveryCodes()).rejects.toThrow("signed-in account changed");
  await expect(api.exportAccount()).rejects.toThrow("signed-in account changed");
  await expect(api.profile()).rejects.toThrow("signed-in account changed");
  const state = await db.prepare("SELECT recovery_codes FROM users WHERE id = ?").bind(users[1].id)
    .first();
  expect(state?.recovery_codes).toBeNull();
});

test("the session guard rejects a mismatched account hint before a sensitive action", async () => {
  const app = createApp();
  const secret = "dashboard-binding-test";
  const headers = {
    cookie: `__Host-session=${await signSession(secret, 1, 3600)}; __Host-fresh-auth=${await signFreshAuth(secret, 1, 600)}`,
    "X-Expected-User-ID": "2",
  };
  const response = await app.request("/api/account/recovery-codes", { method: "POST", headers }, { ...env, SESSION_SECRET: secret });
  expect(response.status).toBe(409);
  const matching = await app.request("/api/account/profile", { headers: { ...headers, "X-Expected-User-ID": "1" } }, { ...env, SESSION_SECRET: secret });
  expect(matching.status).toBe(200);
});

test.each(["login", "completeMfa", "passkeyLoginVerify", "register", "logout"])(
  "%s in the current tab clears its previous account binding", async method => {
    vi.resetModules();
    const { api } = await import("../../dashboard/src/api");
    let id = 1;
    const requests = [];
    vi.stubGlobal("fetch", async (path, init) => {
      if (path === "/api/account/profile") {
        requests.push(new Headers(init?.headers));
        return Response.json({ id });
      }
      return Response.json({ ok: true, userId: 2 });
    });
    await api.profile();
    await api[method]("test-credential");
    id = 2;
    expect((await api.profile()).id).toBe(2);
    expect(requests[1].has("X-Expected-User-ID")).toBe(false);
  },
);
