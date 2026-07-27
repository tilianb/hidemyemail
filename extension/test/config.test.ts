import { describe, expect, test, vi } from "vitest";
import { canonicalizeServerUrl, configure, hostPermissionPattern, initializeConfig, KEY_PATTERN, PERMISSION_ERROR, RECOVERY_ERROR, STORAGE_ERROR } from "../src/config";

describe("canonicalizeServerUrl", () => {
  test.each([
    [" https://Example.COM/ ", "https://example.com"],
    ["https://example.com:443", "https://example.com"],
    ["http://localhost:8787/", "http://localhost:8787"],
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
    ["http://[::1]:8787/", "http://[::1]:8787"],
  ])("canonicalizes %s", (input, expected) => expect(canonicalizeServerUrl(input)).toBe(expected));

  test.each(["http://example.com", "https://u:p@example.com", "https://example.com/x", "https://example.com/?q=1", "https://example.com/#x", "ftp://example.com"])("rejects %s", (input) => {
    expect(() => canonicalizeServerUrl(input)).toThrow("valid HTTPS");
  });
});

test.each([
  ["https://example.com:8443", "https://example.com/*"],
  ["http://localhost:8787", "http://localhost/*"],
  ["http://127.0.0.1:8787", "http://127.0.0.1/*"],
  ["http://[::1]:8787", "http://[::1]/*"],
])("uses a portless Chrome match pattern for %s", (server, expected) => {
  expect(hostPermissionPattern(server)).toBe(expected);
});

test("accepts only dedicated API keys", () => {
  expect(KEY_PATTERN.test("hme_abc123")).toBe(true);
  expect(KEY_PATTERN.test("other_abc123")).toBe(false);
});

function platform(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn(async () => ({ server: "https://old.example:8443", key: "hme_old" })),
    set: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    contains: vi.fn(async () => false),
    request: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    ...overrides,
  };
}

test("validates and atomically persists candidate before removing old access", async () => {
  const events: string[] = [];
  const p = platform({
    contains: vi.fn(async () => { events.push("contains"); return false; }),
    request: vi.fn(async () => { events.push("request"); return true; }),
    remove: vi.fn(async () => { events.push("remove"); return true; }),
    set: vi.fn(async () => { events.push("set"); }),
  });
  await configure(p, "https://new.example:9443", "hme_new", async () => { events.push("validate"); });
  expect(events).toEqual(["contains", "request", "validate", "set", "remove"]);
  expect(p.request).toHaveBeenCalledWith("https://new.example/*");
  expect(p.remove).toHaveBeenCalledWith("https://old.example/*");
});

test("permission denial stores nothing and does not expose key", async () => {
  const p = platform({ get: vi.fn(async () => ({})), request: vi.fn(async () => false) });
  await expect(configure(p, "https://example.com", "hme_secret", vi.fn())).rejects.toThrow("Site access was denied");
  expect(p.set).not.toHaveBeenCalled();
  expect(JSON.stringify(p.request.mock.calls)).not.toContain("hme_secret");
});

test("permission check failure is fixed, retains prior config, and does not alter uncertain access", async () => {
  const p = platform({ contains: vi.fn(async () => { throw new Error("chrome hme_secret https://new.example"); }) });
  const error = await configure(p, "https://new.example", "hme_secret", vi.fn()).catch((failure: unknown) => failure) as Error;
  expect(error.message).toBe(PERMISSION_ERROR);
  expect(error.message).not.toMatch(/hme_secret|new\.example|chrome/i);
  expect(p.request).not.toHaveBeenCalled();
  expect(p.remove).not.toHaveBeenCalled();
  expect(p.set).not.toHaveBeenCalled();
});

test("permission request throw safely removes a possibly granted, known-new permission", async () => {
  const p = platform({ request: vi.fn(async () => { throw "chrome request failed hme_secret"; }) });
  const error = await configure(p, "https://new.example", "hme_secret", vi.fn()).catch((failure: unknown) => failure) as Error;
  expect(error.message).toBe(PERMISSION_ERROR);
  expect(error.message).not.toMatch(/hme_secret|chrome/i);
  expect(p.remove).toHaveBeenCalledExactlyOnceWith("https://new.example/*");
  expect(p.set).not.toHaveBeenCalled();
});

test("permission request throw never removes same-server shared access", async () => {
  const p = platform({ request: vi.fn(async () => { throw new Error("hme_secret"); }) });
  const error = await configure(p, "https://old.example:9443", "hme_secret", vi.fn()).catch((failure: unknown) => failure) as Error;
  expect(error.message).toBe(PERMISSION_ERROR);
  expect(p.remove).not.toHaveBeenCalled();
  expect(p.set).not.toHaveBeenCalled();
});

test("cleanup failure after permission request throw returns only fixed recovery guidance", async () => {
  const p = platform({
    request: vi.fn(async () => { throw new Error("request hme_secret"); }),
    remove: vi.fn(async () => { throw new Error("cleanup hme_secret"); }),
  });
  const error = await configure(p, "https://new.example", "hme_secret", vi.fn()).catch((failure: unknown) => failure) as Error;
  expect(error.message).toBe(RECOVERY_ERROR);
  expect(error.message).not.toMatch(/hme_secret|request|cleanup/i);
  expect(p.set).not.toHaveBeenCalled();
});

test("validation failure retains old config and revokes only newly granted access", async () => {
  const p = platform();
  await expect(configure(p, "https://new.example", "hme_secret", async () => { throw new Error("invalid"); })).rejects.toThrow("invalid");
  expect(p.remove).toHaveBeenCalledOnce();
  expect(p.remove).toHaveBeenCalledWith("https://new.example/*");
  expect(p.set).not.toHaveBeenCalled();
});

test("validation failure never removes preexisting candidate access", async () => {
  const p = platform({ contains: vi.fn(async () => true) });
  await expect(configure(p, "https://new.example", "hme_secret", async () => { throw new Error("invalid"); })).rejects.toThrow("invalid");
  expect(p.request).not.toHaveBeenCalled();
  expect(p.remove).not.toHaveBeenCalled();
});

test("same-server validation failure never removes working access", async () => {
  const p = platform({ get: vi.fn(async () => ({ server: "https://same.example:8443", key: "hme_old" })) });
  await expect(configure(p, "https://same.example:8443", "hme_new", async () => { throw new Error("invalid"); })).rejects.toThrow("invalid");
  expect(p.remove).not.toHaveBeenCalled();
});

test("port change retains shared host permission", async () => {
  const p = platform({ contains: vi.fn(async () => true) });
  await configure(p, "https://old.example:9443", "hme_new", async () => undefined);
  expect(p.remove).not.toHaveBeenCalled();
});

test.each([false, "throw"])("failed old permission removal (%s) restores old config and revokes new grant", async (failure) => {
  const p = platform({ remove: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) });
  if (failure === "throw") p.remove.mockRejectedValueOnce(new Error("private detail")).mockResolvedValueOnce(true);
  await expect(configure(p, "https://new.example", "hme_new", async () => undefined)).rejects.toThrow("previous site access");
  expect(p.remove.mock.calls).toEqual([["https://old.example/*"], ["https://new.example/*"]]);
  expect(p.set.mock.calls).toEqual([[{ server: "https://new.example", key: "hme_new" }], [{ server: "https://old.example:8443", key: "hme_old" }]]);
});

test("storage set failure leaves old config and revokes new access", async () => {
  const p = platform({ set: vi.fn(async () => { throw new Error("private storage detail"); }) });
  await expect(configure(p, "https://new.example", "hme_new", async () => undefined)).rejects.toThrow(STORAGE_ERROR);
  expect(p.remove).toHaveBeenLastCalledWith("https://new.example/*");
  expect(p.remove).not.toHaveBeenCalledWith("https://old.example/*");
});

test("rollback storage failure reports recovery required and does not revoke permission needed by persisted candidate", async () => {
  const set = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("private rollback detail"));
  const p = platform({ set });
  p.remove.mockResolvedValueOnce(false);
  await expect(configure(p, "https://new.example", "hme_new", async () => undefined)).rejects.toThrow(RECOVERY_ERROR);
  expect(p.remove).toHaveBeenCalledOnce();
});

test("candidate revoke failure reports recovery required without leaking key", async () => {
  const p = platform({ remove: vi.fn(async () => false) });
  await expect(configure(p, "https://new.example", "hme_new", async () => { throw new Error("invalid"); })).rejects.toMatchObject({ message: RECOVERY_ERROR });
  expect(RECOVERY_ERROR).not.toContain("hme_new");
});

test("successful same-server key change overwrites credentials without deleting shared permission", async () => {
  const p = platform({ contains: vi.fn(async () => true) });
  await configure(p, "https://old.example:8443", "hme_new", async () => undefined);
  expect(p.set).toHaveBeenCalledWith({ server: "https://old.example:8443", key: "hme_new" });
  expect(p.remove).not.toHaveBeenCalled();
});

test.each([
  ["malformed server", { server: "not a URL", key: "hme_old" }],
  ["server only", { server: "https://old.example:8443" }],
  ["key only", { key: "hme_old" }],
  ["invalid key", { server: "https://old.example:8443", key: "not-an-api-key" }],
  ["noncanonical server", { server: "https://OLD.example:8443/", key: "hme_old" }],
])("treats %s stored configuration as absent without exposing or parsing it unsafely", async (_label, stored) => {
  const p = platform({ get: vi.fn(async () => stored) });
  await configure(p, "https://new.example", "hme_new", async () => undefined);
  expect(p.set).toHaveBeenCalledExactlyOnceWith({ server: "https://new.example", key: "hme_new" });
  expect(p.remove).not.toHaveBeenCalledWith("https://old.example/*");
});

test("does not attempt old-permission removal for incomplete previous storage", async () => {
  const p = platform({
    get: vi.fn(async () => ({ server: "https://old.example:8443" })),
    remove: vi.fn(async () => false),
  });
  await expect(configure(p, "https://new.example", "hme_new", async () => undefined)).resolves.toEqual({ server: "https://new.example", key: "hme_new" });
  expect(p.remove).not.toHaveBeenCalled();
});

test.each(["access", "read"])("returns fixed storage failure when %s fails", async (failure) => {
  const initialize = vi.fn(async () => { if (failure === "access") throw new Error("secret access detail"); });
  const p = platform({ get: vi.fn(async () => { if (failure === "read") throw new Error("secret read detail"); return {}; }) });
  await expect(initializeConfig(p, initialize)).resolves.toEqual({ ok: false, error: STORAGE_ERROR });
});
