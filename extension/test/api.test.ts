import { expect, test, vi } from "vitest";
import { ApiError, createApi } from "../src/api";

const config = { server: "https://mail.example", key: "hme_secret" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("probes and loads validated domains with bearer header", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response({ name: "Extension", created_at: "2026-01-01 00:00:00", expires_at: null })).mockResolvedValueOnce(response({ data: ["one.example"], defaultAliasDomain: "one.example", defaultAliasFormat: "random_characters" }));
  const api = createApi(config, fetcher);
  await api.probe();
  expect(await api.domains()).toEqual({ domains: ["one.example"], defaultDomain: "one.example" });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://mail.example/api/v1/api-token-details", "https://mail.example/api/v1/domain-options"]);
  for (const [, init] of fetcher.mock.calls) expect(new Headers(init.headers).get("Authorization")).toBe("Bearer hme_secret");
});

test("creates random alias with exact request", async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ data: { id: "1", email: "abc@one.example", local_part: "abc", domain: "one.example", active: true, description: null, emails_forwarded: 0, created_at: "2026-01-01 00:00:00" } }, 201));
  expect(await createApi(config, fetcher).createAlias("one.example", ["one.example"])).toBe("abc@one.example");
  const [url, init] = fetcher.mock.calls[0]!;
  expect(init).toBeDefined();
  expect(url).toBe("https://mail.example/api/v1/aliases");
  expect(init!.method).toBe("POST");
  expect(init!.body).toBe(JSON.stringify({ domain: "one.example", format: "random_characters" }));
  expect(new Headers(init!.headers).get("Authorization")).toBe("Bearer hme_secret");
});

test.each(["bad domain", "other.example", "one.example\nother.example"])("rejects malformed or unvalidated domain %s before fetching", async (selectedDomain) => {
  const fetcher = vi.fn();
  await expect(createApi(config, fetcher).createAlias(selectedDomain, ["one.example"])).rejects.toMatchObject({ kind: "validation" });
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([
  [401, "auth", "API key was rejected."],
  [403, "permission", "The API key does not have permission for this action."],
  [409, "validation", "The request was not accepted."],
  [422, "validation", "The request was not accepted."],
  [429, "quota", "The server quota or rate limit was reached."],
  [500, "server", "The server could not complete the request."],
] as const)("maps HTTP %s to a safe extension-owned error", async (status, kind, message) => {
  const fetcher = vi.fn(async () => response({ message: "hme_leaked_remote_secret" }, status));
  await expect(createApi(config, fetcher).probe()).rejects.toMatchObject({ kind, message });
});

test("maps network errors without leaking credentials", async () => {
  const api = createApi(config, vi.fn(async () => { throw new TypeError("failed"); }));
  const error = await api.probe().then(() => { throw new Error("expected rejection"); }, (value) => value as ApiError);
  expect(error.kind).toBe("network");
  expect(error.message).not.toContain(config.key);
});

test.each([{ nope: true }, { data: [] }, { data: { email: "not-an-email" } }])("rejects malformed response %#", async (body) => {
  await expect(createApi(config, vi.fn(async () => response(body))).createAlias("one.example", ["one.example"])).rejects.toMatchObject({ kind: "malformed" });
});

test.each([
  { name: "", created_at: null, expires_at: null },
  { name: "key", created_at: 1, expires_at: null },
])("rejects malformed probe %#", async (body) => {
  await expect(createApi(config, vi.fn(async () => response(body))).probe()).rejects.toMatchObject({ kind: "malformed" });
});

test.each([
  { data: ["one.example", "one.example"], defaultAliasDomain: "one.example", defaultAliasFormat: "random_characters" },
  { data: ["-bad.example"], defaultAliasDomain: null, defaultAliasFormat: "random_characters" },
  { data: ["one.example"], defaultAliasDomain: "other.example", defaultAliasFormat: "random_characters" },
])("rejects malformed domain options %#", async (body) => {
  await expect(createApi(config, vi.fn(async () => response(body))).domains()).rejects.toMatchObject({ kind: "malformed" });
});

test.each([
  { email: "xyz@one.example", local_part: "abc", domain: "one.example" },
  { email: "abc@other.example", local_part: "abc", domain: "other.example" },
  { email: "bad local@one.example", local_part: "bad local", domain: "one.example" },
])("rejects inconsistent alias %#", async (alias) => {
  const body = { data: { id: "1", active: true, ...alias } };
  await expect(createApi(config, vi.fn(async () => response(body))).createAlias("one.example", ["one.example"])).rejects.toMatchObject({ kind: "malformed" });
});
