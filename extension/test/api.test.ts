import { expect, test, vi } from "vitest";
import { ApiError, createApi } from "../src/api";

const config = { server: "https://mail.example", key: "hme_secret" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("probes and loads validated domains and destinations with bearer header", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({ name: "Extension", created_at: "2026-01-01 00:00:00", expires_at: null }))
    .mockResolvedValueOnce(response({ data: ["one.example"], defaultAliasDomain: "one.example", defaultAliasFormat: "random_characters" }))
    .mockResolvedValueOnce(response({ data: [{ id: "7", email: "real@me.example", isDefault: true }], defaultDestinationId: "7" }));
  const api = createApi(config, fetcher);
  await api.probe();
  expect(await api.domains()).toEqual({ domains: ["one.example"], defaultDomain: "one.example" });
  expect(await api.destinations()).toEqual({ destinations: [{ id: "7", email: "real@me.example", isDefault: true }], defaultDestinationId: "7" });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://mail.example/api/v1/api-token-details", "https://mail.example/api/v1/domain-options", "https://mail.example/api/v1/destination-options"]);
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

test("lists up to 100 validated aliases with an encoded search", async () => {
  const alias = { id: "12", email: "shop-news@one.example", local_part: "shop-news", domain: "one.example", active: false, description: "News" };
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ data: [alias] }));

  await expect(createApi(config, fetcher).listAliases("shop & news")).resolves.toEqual([alias]);
  expect(fetcher.mock.calls[0]![0]).toBe("https://mail.example/api/v1/aliases?filter%5Bsearch%5D=shop+%26+news");
});

test("parses an alias response containing an underscore", async () => {
  const alias = { id: "13", email: "shop_news@one.example", local_part: "shop_news", domain: "one.example", active: true, description: null };
  const fetcher = vi.fn(async () => response({ data: [alias] }));

  await expect(createApi(config, fetcher).listAliases()).resolves.toEqual([alias]);
});

test("normalizes an uppercase rich-create domain before sending and comparing", async () => {
  const alias = { id: "1", email: "abc@one.example", local_part: "abc", domain: "one.example", active: true, description: null };
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ data: alias }, 201));

  await expect(createApi(config, fetcher).createAlias({ domain: "ONE.Example", format: "random_characters" })).resolves.toEqual(alias);
  expect(fetcher.mock.calls[0]![1]!.body).toBe(JSON.stringify({ domain: "one.example", format: "random_characters" }));
});

test.each([
  [
    { domain: "one.example", format: "random_characters" as const },
    { domain: "one.example", format: "random_characters" },
    { id: "1", email: "abc@one.example", local_part: "abc", domain: "one.example", active: true, description: null },
  ],
  [
    { domain: "one.example", description: "Login", format: "uuid" as const, destination_id: "7" },
    { domain: "one.example", description: "Login", format: "uuid", destination_id: "7" },
    { id: "2", email: "123e4567-e89b-12d3-a456-426614174000@one.example", local_part: "123e4567-e89b-12d3-a456-426614174000", domain: "one.example", active: true, description: "Login" },
  ],
  [
    { domain: "one.example", description: "Shop", format: "custom" as const, local_part: "shop" },
    { domain: "one.example", description: "Shop", format: "custom", local_part: "shop" },
    { id: "3", email: "shop@one.example", local_part: "shop", domain: "one.example", active: true, description: "Shop" },
  ],
])("creates an alias using the requested format %#", async (input, expectedBody, alias) => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ data: alias }, 201));
  await expect(createApi(config, fetcher).createAlias(input)).resolves.toEqual(alias);
  expect(fetcher.mock.calls[0]![1]!.body).toBe(JSON.stringify(expectedBody));
});

test("creates a custom alias containing an underscore", async () => {
  const alias = { id: "4", email: "shop_news@one.example", local_part: "shop_news", domain: "one.example", active: true, description: null };
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response({ data: alias }, 201));

  await expect(createApi(config, fetcher).createAlias({ domain: "one.example", format: "custom", local_part: "shop_news" })).resolves.toEqual(alias);
  expect(fetcher.mock.calls[0]![1]!.body).toBe(JSON.stringify({ domain: "one.example", format: "custom", local_part: "shop_news" }));
});

test("activates, deactivates, and deletes aliases", async () => {
  const alias = { id: "7", email: "shop@one.example", local_part: "shop", domain: "one.example", active: true, description: null };
  const fetcher = vi.fn()
    .mockResolvedValueOnce(response({ data: alias }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const api = createApi(config, fetcher);

  await expect(api.activateAlias("7")).resolves.toEqual(alias);
  await expect(api.deactivateAlias("7")).resolves.toBeUndefined();
  await expect(api.deleteAlias("7")).resolves.toBeUndefined();
  expect(fetcher.mock.calls.map(([url, init]) => [url, init.method, init.body])).toEqual([
    ["https://mail.example/api/v1/active-aliases", "POST", JSON.stringify({ id: "7" })],
    ["https://mail.example/api/v1/active-aliases/7", "DELETE", undefined],
    ["https://mail.example/api/v1/aliases/7", "DELETE", undefined],
  ]);
});

test.each([
  { data: [{ id: "0", email: "a@one.example", local_part: "a", domain: "one.example", active: true, description: null }] },
  { data: [{ id: "1", email: "not-an-email", local_part: "a", domain: "one.example", active: true, description: null }] },
  { data: [{ id: "1", email: "a@one.example", local_part: "a", domain: "one.example", active: 1, description: null }] },
  { data: [{ id: "1", email: "a@one.example", domain: "one.example", active: true, description: null }] },
  { data: [{ id: "1", email: "a@one.example", local_part: "a", active: true, description: null }] },
  { data: [{ id: "1", email: "shop+news@one.example", local_part: "shop+news", domain: "one.example", active: true, description: null }] },
  { data: new Array(101).fill({ id: "1", email: "a@one.example", local_part: "a", domain: "one.example", active: true, description: null }) },
])("rejects malformed alias lists %#", async (body) => {
  await expect(createApi(config, vi.fn(async () => response(body))).listAliases()).rejects.toMatchObject({ kind: "malformed", message: "The server returned invalid aliases." });
});

test.each(["", "0", "01", "-1", "1/2"])("rejects malformed alias id %s before fetching", async (id) => {
  const fetcher = vi.fn();
  await expect(createApi(config, fetcher).deleteAlias(id)).rejects.toMatchObject({ kind: "validation", message: "The alias ID is invalid." });
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([
  { domain: "bad domain", format: "random_characters" },
  { domain: "one.example", description: null, format: "random_characters" },
  { domain: "one.example", description: "x".repeat(256), format: "random_characters" },
  { domain: "one.example", format: "custom" },
  { domain: "one.example", format: "uuid", local_part: "not-allowed" },
  { domain: "one.example", format: "custom", local_part: "bad local" },
  { domain: "one.example", format: "custom", local_part: "shop+news" },
  { domain: "one.example", format: "custom", local_part: "r.reply" },
  { domain: "one.example", format: "custom", local_part: "R.reply" },
  { domain: "one.example", format: "random_characters", destination_id: "0" },
  { domain: "one.example", format: "random_characters", destination_id: "01" },
])("rejects invalid rich create input %# before fetching", async (input) => {
  const fetcher = vi.fn();
  await expect(createApi(config, fetcher).createAlias(input as never)).rejects.toMatchObject({ kind: "validation", message: "The alias request is invalid." });
  expect(fetcher).not.toHaveBeenCalled();
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

test.each(["list", "create", "activate"] as const)("accepts an existing overlong description in a %s response", async (operation) => {
  const alias = { id: "1", email: "a@one.example", local_part: "a", domain: "one.example", active: true, description: "x".repeat(256) };
  const api = createApi(config, vi.fn(async () => response(operation === "list" ? { data: [alias] } : { data: alias })));
  const result = operation === "list" ? api.listAliases() : operation === "create" ? api.createAlias({ domain: "one.example", format: "random_characters" }) : api.activateAlias("1");
  await expect(result).resolves.toEqual(operation === "list" ? [alias] : alias);
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
  { data: [{ id: "0", email: "real@me.example", isDefault: true }], defaultDestinationId: "0" },
  { data: [{ id: "7", email: "not-an-email", isDefault: true }], defaultDestinationId: "7" },
  { data: [{ id: "7", email: "real@me.example", isDefault: 1 }], defaultDestinationId: "7" },
  { data: [{ id: "7", email: "real@me.example", isDefault: true }], defaultDestinationId: "8" },
])("rejects malformed destination options %#", async (body) => {
  await expect(createApi(config, vi.fn(async () => response(body))).destinations()).rejects.toMatchObject({ kind: "malformed" });
});

test.each([
  { email: "xyz@one.example", local_part: "abc", domain: "one.example" },
  { email: "abc@other.example", local_part: "abc", domain: "other.example" },
  { email: "bad local@one.example", local_part: "bad local", domain: "one.example" },
])("rejects inconsistent alias %#", async (alias) => {
  const body = { data: { id: "1", active: true, ...alias } };
  await expect(createApi(config, vi.fn(async () => response(body))).createAlias("one.example", ["one.example"])).rejects.toMatchObject({ kind: "malformed" });
});
