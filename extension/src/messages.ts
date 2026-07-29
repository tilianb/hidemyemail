import { creatableLocalPart, inputDescription, isValidDomain, type Alias, type CreateAliasInput, type DestinationOption } from "./api";
import type { ExtensionConfig } from "./config";

export type ContentRequest = { type: "hme:domain-options" } | { type: "hme:generate"; domain: string; destinationId: string };
export type ContentResponse =
  | { ok: true; domains: string[]; defaultDomain: string; destinations: DestinationOption[]; defaultDestinationId: string | null }
  | { ok: true; alias: string }
  | { ok: false; error: string };
export type PopupRequest =
  | { type: "hme:aliases:list"; search?: string }
  | { type: "hme:aliases:create"; input: CreateAliasInput }
  | { type: "hme:aliases:activate" | "hme:aliases:deactivate" | "hme:aliases:delete"; id: string };
export type PopupResponse = { ok: true; aliases: Alias[] } | { ok: true; alias: Alias } | { ok: true } | { ok: false; error: string };

type Dependencies = {
  extensionId: string;
  loadConfig(): Promise<ExtensionConfig | null>;
  domains(config: ExtensionConfig): Promise<{ domains: string[]; defaultDomain: string }>;
  destinations(config: ExtensionConfig): Promise<{ destinations: DestinationOption[]; defaultDestinationId: string | null }>;
  createRich(config: ExtensionConfig, input: CreateAliasInput): Promise<Alias>;
  list(config: ExtensionConfig, search?: string): Promise<Alias[]>;
  activate(config: ExtensionConfig, id: string): Promise<void>;
  deactivate(config: ExtensionConfig, id: string): Promise<void>;
  delete(config: ExtensionConfig, id: string): Promise<void>;
};

const unsupported = (): ContentResponse => ({ ok: false, error: "Unsupported request." });
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function request(value: unknown): ContentRequest | null {
  if (!record(value)) return null;
  const keys = Object.keys(value);
  if (value.type === "hme:domain-options" && keys.length === 1) return { type: value.type };
  if (value.type === "hme:generate" && keys.length === 3 && isValidDomain(value.domain) && validId(value.destinationId)) return { type: value.type, domain: value.domain, destinationId: value.destinationId };
  return null;
}

const validId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d*$/.test(value);
function popupRequest(value: unknown): PopupRequest | null {
  if (!record(value)) return null;
  const keys = Object.keys(value);
  if (value.type === "hme:aliases:list" && keys.every((key) => key === "type" || key === "search") &&
      (value.search === undefined || (typeof value.search === "string" && value.search.length > 0 && value.search.length <= 200))) {
    return value as PopupRequest;
  }
  if (value.type === "hme:aliases:create" && keys.length === 2 && record(value.input)) {
    const input = value.input;
    const inputKeys = Object.keys(input);
    const format = input.format;
    const descriptionOk = input.description === undefined || inputDescription(input.description);
    const localOk = format === "custom" ? creatableLocalPart(input.local_part) : input.local_part === undefined;
    const destinationOk = input.destination_id === undefined || validId(input.destination_id);
    if (isValidDomain(input.domain) && (format === "random_characters" || format === "uuid" || format === "custom") && descriptionOk && localOk && destinationOk && inputKeys.every((key) => ["domain", "format", "description", "local_part", "destination_id"].includes(key))) return value as PopupRequest;
  }
  if ((value.type === "hme:aliases:activate" || value.type === "hme:aliases:deactivate" || value.type === "hme:aliases:delete") && keys.length === 2 && validId(value.id)) return value as PopupRequest;
  return null;
}

function contentSender(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
  if (sender.id !== extensionId || !sender.tab || typeof sender.url !== "string") return false;
  try { const protocol = new URL(sender.url).protocol; return protocol === "http:" || protocol === "https:"; }
  catch { return false; }
}

function senderHostname(sender: chrome.runtime.MessageSender): string | undefined {
  if (typeof sender.tab?.url !== "string") return undefined;
  try {
    const url = new URL(sender.tab.url);
    const hostname = url.hostname.toLowerCase();
    const validHostname = hostname === "localhost" || /^\[[0-9a-f:.]+\]$/.test(hostname) ||
      hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
    if ((url.protocol === "http:" || url.protocol === "https:") && hostname.length > 0 && hostname.length <= 253 && validHostname) return hostname;
  } catch { /* Omit the description when Chrome has no usable top-level URL. */ }
  return undefined;
}

function popupSender(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
  return sender.id === extensionId && !sender.tab && sender.url === `chrome-extension://${extensionId}/popup.html`;
}

export async function handleContentMessage(value: unknown, sender: chrome.runtime.MessageSender, deps: Dependencies): Promise<ContentResponse | PopupResponse> {
  const content = request(value);
  const popup = popupRequest(value);
  if ((!content || !contentSender(sender, deps.extensionId)) && (!popup || !popupSender(sender, deps.extensionId))) return unsupported();
  try {
    const config = await deps.loadConfig();
    if (!config) return { ok: false, error: "Reconnect HideMyEmail from the extension popup." };
    if (popup) {
      if (popup.type === "hme:aliases:list") return { ok: true, aliases: await deps.list(config, popup.search) };
      if (popup.type === "hme:aliases:create") return { ok: true, alias: await deps.createRich(config, popup.input) };
      if (popup.type === "hme:aliases:activate") await deps.activate(config, popup.id);
      if (popup.type === "hme:aliases:deactivate") await deps.deactivate(config, popup.id);
      if (popup.type === "hme:aliases:delete") await deps.delete(config, popup.id);
      return { ok: true };
    }
    const message = content!;
    const [options, destinationOptions] = await Promise.all([deps.domains(config), deps.destinations(config)]);
    if (message.type === "hme:domain-options") return { ok: true, domains: [...options.domains], defaultDomain: options.defaultDomain, destinations: destinationOptions.destinations.map((destination) => ({ ...destination })), defaultDestinationId: destinationOptions.defaultDestinationId };
    if (!options.domains.includes(message.domain) || !destinationOptions.destinations.some(({ id }) => id === message.destinationId)) return unsupported();
    const description = senderHostname(sender);
    const alias = await deps.createRich(config, { domain: message.domain, destination_id: message.destinationId, format: "random_characters", ...(description ? { description } : {}) });
    if (alias.domain !== message.domain || !alias.email.endsWith(`@${message.domain}`)) throw new Error("Unexpected alias domain");
    return { ok: true, alias: alias.email };
  } catch (error) {
    if (record(error) && error.kind === "auth") return { ok: false, error: "Reconnect HideMyEmail from the extension popup." };
    return { ok: false, error: "HideMyEmail could not complete the request. Try again." };
  }
}
