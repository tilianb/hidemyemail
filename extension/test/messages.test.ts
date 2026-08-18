import { expect, test, vi } from "vitest";
import { handleContentMessage } from "../src/messages";

const sender = { id: "extension-id", tab: { id: 3, url: "https://site.example/form" }, url: "https://site.example/form" } as chrome.runtime.MessageSender;
const popup = { id: "extension-id", url: "chrome-extension://extension-id/popup.html" } as chrome.runtime.MessageSender;
const generate = { type: "hme:generate" as const, domain: "one.example", destinationId: "7" };
const destination = { id: "7", email: "real@me.example", isDefault: true };
const deps = () => ({
  extensionId: "extension-id",
  loadConfig: vi.fn(async () => ({ server: "https://mail.example", key: "hme_secret" })),
  domains: vi.fn(async () => ({ domains: ["one.example"], defaultDomain: "one.example" })),
  destinations: vi.fn(async () => ({ destinations: [destination], defaultDestinationId: destination.id })),
  createRich: vi.fn(async () => ({ id: "1", email: "shop@one.example", active: true, description: "Shopping", domain: "one.example", local_part: "shop" })),
  list: vi.fn(async () => [{ id: "1", email: "shop@one.example", active: true, description: null, domain: "one.example", local_part: "shop" }]),
  activate: vi.fn(async () => undefined),
  deactivate: vi.fn(async () => undefined),
  delete: vi.fn(async () => undefined),
});

test("returns only safe domain options and generated alias", async () => {
  const d = deps();
  await expect(handleContentMessage({ type: "hme:domain-options" }, sender, d)).resolves.toEqual({ ok: true, domains: ["one.example"], defaultDomain: "one.example", destinations: [destination], defaultDestinationId: "7" });
  await expect(handleContentMessage(generate, sender, d)).resolves.toEqual({ ok: true, alias: "shop@one.example" });
  expect(d.createRich).toHaveBeenCalledWith(expect.anything(), { domain: "one.example", destination_id: "7", format: "random_characters", description: "site.example" });
  expect(JSON.stringify(await handleContentMessage({ type: "hme:domain-options" }, sender, d))).not.toContain("hme_secret");
});

test("derives only the canonical top-level hostname for inline creation", async () => {
  const d = deps();
  const from = { ...sender, url: "https://iframe.attacker.test/form", tab: { id: 3, url: "https://ACCOUNTS.Example.COM:8443/private?token=secret#field" } } as chrome.runtime.MessageSender;
  await handleContentMessage(generate, from, d);
  expect(d.createRich).toHaveBeenCalledWith(expect.anything(), { domain: "one.example", destination_id: "7", format: "random_characters", description: "accounts.example.com" });
});

test.each([undefined, "not a URL", "file:///private/path", "https:///", "https://bad_host.example/form"])("omits description for unusable top-level URL %s", async (url) => {
  const d = deps();
  const from = { ...sender, tab: { id: 3, url } } as chrome.runtime.MessageSender;
  await expect(handleContentMessage(generate, from, d)).resolves.toEqual({ ok: true, alias: "shop@one.example" });
  expect(d.createRich).toHaveBeenCalledWith(expect.anything(), { domain: "one.example", destination_id: "7", format: "random_characters" });
});

test.each([
  ["http://localhost:3000/form", "localhost"],
  ["https://[2001:DB8::1]:8443/form", "[2001:db8::1]"],
])("accepts supported HTTP(S) hostname %s", async (url, hostname) => {
  const d = deps();
  await handleContentMessage(generate, { ...sender, tab: { id: 3, url } } as chrome.runtime.MessageSender, d);
  expect(d.createRich).toHaveBeenCalledWith(expect.anything(), { domain: "one.example", destination_id: "7", format: "random_characters", description: hostname });
});

test("content sender cannot provide or override an inline description", async () => {
  const d = deps();
  await expect(handleContentMessage({ type: "hme:generate", domain: "one.example", description: "attacker.test" }, sender, d)).resolves.toEqual({ ok: false, error: "Unsupported request." });
  expect(d.loadConfig).not.toHaveBeenCalled();
});

test("content sender can select only a destination returned for its account", async () => {
  const d = deps();
  await expect(handleContentMessage({ ...generate, destinationId: "99" }, sender, d)).resolves.toEqual({ ok: false, error: "Unsupported request." });
  expect(d.createRich).not.toHaveBeenCalled();
});

test("rejects an inline alias returned for a different domain without leaking URLs", async () => {
  const d = deps();
  d.createRich.mockResolvedValueOnce({ id: "2", email: "wrong@other.example", active: true, description: "site.example", domain: "other.example", local_part: "wrong" });
  const response = await handleContentMessage(generate, { ...sender, tab: { id: 3, url: "https://private.example/path?secret=yes" } } as chrome.runtime.MessageSender, d);
  expect(response).toEqual({ ok: false, error: "HideMyEmail could not complete the request. Try again." });
  expect(JSON.stringify(response)).not.toMatch(/private\.example|secret/);
});

test.each([
  [{ type: "unknown" }, sender],
  [{ type: "hme:generate", domain: "bad domain" }, sender],
  [{ type: "hme:generate", domain: "one.example", destinationId: "0" }, sender],
  [{ type: "hme:domain-options", extra: true }, sender],
  [{ type: "hme:domain-options" }, { ...sender, id: "other" }],
  [{ type: "hme:domain-options" }, { id: "extension-id" }],
])("rejects malformed messages or non-content senders", async (message, from) => {
  const d = deps();
  await expect(handleContentMessage(message, from as chrome.runtime.MessageSender, d)).resolves.toEqual({ ok: false, error: "Unsupported request." });
  expect(d.loadConfig).not.toHaveBeenCalled();
});

test("maps auth and unknown failures to fixed safe guidance", async () => {
  const auth = deps(); auth.domains.mockRejectedValueOnce(Object.assign(new Error("hme_secret"), { kind: "auth" }));
  await expect(handleContentMessage({ type: "hme:domain-options" }, sender, auth)).resolves.toEqual({ ok: false, error: "Reconnect HideMyEmail from the extension popup." });
  const unknown = deps(); unknown.domains.mockRejectedValueOnce(new Error("private URL hme_secret"));
  await expect(handleContentMessage({ type: "hme:domain-options" }, sender, unknown)).resolves.toEqual({ ok: false, error: "HideMyEmail could not complete the request. Try again." });
});

test("admits valid popup-only inventory and mutation messages", async () => {
  const d = deps();
  await expect(handleContentMessage({ type: "hme:aliases:list", search: "shop" }, popup, d)).resolves.toMatchObject({ ok: true, aliases: [{ id: "1" }] });
  await expect(handleContentMessage({ type: "hme:aliases:create", input: { domain: "one.example", format: "custom", local_part: "shop", description: "Shopping" } }, popup, d)).resolves.toMatchObject({ ok: true, alias: { email: "shop@one.example" } });
  await expect(handleContentMessage({ type: "hme:aliases:activate", id: "1" }, popup, d)).resolves.toEqual({ ok: true });
  await expect(handleContentMessage({ type: "hme:aliases:deactivate", id: "1" }, popup, d)).resolves.toEqual({ ok: true });
  await expect(handleContentMessage({ type: "hme:aliases:delete", id: "1" }, popup, d)).resolves.toEqual({ ok: true });
  expect(d.list).toHaveBeenCalledWith(expect.anything(), "shop");
});

test.each([
  { type: "hme:aliases:list", search: "" },
  { type: "hme:aliases:create", input: { domain: "bad domain", format: "custom", local_part: "x" } },
  { type: "hme:aliases:create", input: { domain: "one.example", format: "custom" } },
  { type: "hme:aliases:delete", id: "0" },
  { type: "hme:aliases:activate", id: "1", extra: true },
])("rejects malformed privileged popup messages", async (message) => {
  const d = deps();
  await expect(handleContentMessage(message, popup, d)).resolves.toEqual({ ok: false, error: "Unsupported request." });
  expect(d.loadConfig).not.toHaveBeenCalled();
});

test.each([
  { type: "hme:aliases:list", search: "shop" },
  { type: "hme:aliases:delete", id: "1" },
  { type: "hme:aliases:deactivate", id: "1" },
])("denies privileged messages from content/page senders", async (message) => {
  const d = deps();
  await expect(handleContentMessage(message, sender, d)).resolves.toEqual({ ok: false, error: "Unsupported request." });
  expect(d.loadConfig).not.toHaveBeenCalled();
});

test("does not leak privileged operation failures", async () => {
  const d = deps(); d.list.mockRejectedValueOnce(new Error("hme_secret https://private.example"));
  const response = await handleContentMessage({ type: "hme:aliases:list", search: "x" }, popup, d);
  expect(response).toEqual({ ok: false, error: "HideMyEmail could not complete the request. Try again." });
  expect(JSON.stringify(response)).not.toMatch(/hme_secret|private\.example/);
});
