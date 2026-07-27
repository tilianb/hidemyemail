import type { ExtensionConfig } from "./config";

export type ApiErrorKind = "auth" | "permission" | "quota" | "validation" | "server" | "network" | "malformed";
export class ApiError extends Error {
  constructor(public readonly kind: ApiErrorKind, message: string) { super(message); }
}

export type Alias = {
  id: string;
  email: string;
  active: boolean;
  description: string | null;
  domain: string;
  local_part: string;
};
export type AliasFormat = "random_characters" | "uuid" | "custom";
export type CreateAliasInput = {
  domain: string;
  description?: string;
  format: AliasFormat;
  local_part?: string;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const isValidDomain = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 253) return false;
  const labels = value.split(".");
  return labels.length > 1 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
};
const localPart = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value) && !value.includes("..");
const creatableLocalPart = (value: unknown): value is string => localPart(value) && !value.toLowerCase().startsWith("r.");
const aliasId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d*$/.test(value);
const inputDescription = (value: unknown): value is string => typeof value === "string" && value.length <= 255;

function parseAlias(value: unknown): Alias | null {
  if (!record(value) || !aliasId(value.id) || typeof value.email !== "string" || typeof value.active !== "boolean" || !(value.description === null || typeof value.description === "string")) return null;
  const at = value.email.lastIndexOf("@");
  if (at <= 0 || at === value.email.length - 1 || value.email.indexOf("@") !== at) return null;
  const emailLocal = value.email.slice(0, at);
  const emailDomain = value.email.slice(at + 1);
  if (!localPart(emailLocal) || !isValidDomain(emailDomain)) return null;
  if (!localPart(value.local_part) || value.local_part !== emailLocal) return null;
  if (!isValidDomain(value.domain) || value.domain !== emailDomain) return null;
  return {
    id: value.id,
    email: value.email,
    active: value.active,
    description: value.description,
    domain: value.domain,
    local_part: value.local_part,
  };
}

function httpError(status: number): ApiError {
  if (status === 401) return new ApiError("auth", "API key was rejected.");
  if (status === 403) return new ApiError("permission", "The API key does not have permission for this action.");
  if (status === 429) return new ApiError("quota", "The server quota or rate limit was reached.");
  if (status === 400 || status === 409 || status === 422) return new ApiError("validation", "The request was not accepted.");
  return new ApiError("server", "The server could not complete the request.");
}

export function createApi(config: ExtensionConfig, fetcher: Fetcher = fetch) {
  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(`${config.server}${path}`, { ...init, credentials: "omit", redirect: "error", headers: { Authorization: `Bearer ${config.key}`, ...init.headers } });
    } catch {
      throw new ApiError("network", "Could not reach the server. Check the deployment and try again.");
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw httpError(response.status);
    return body;
  }
  function requireId(id: string): void {
    if (!aliasId(id)) throw new ApiError("validation", "The alias ID is invalid.");
  }
  async function createRichAlias(input: CreateAliasInput): Promise<Alias> {
    const keys = record(input) ? Object.keys(input) : [];
    const validFormat = record(input) && (input.format === "random_characters" || input.format === "uuid" || input.format === "custom");
    const validDescription = record(input) && (input.description === undefined || inputDescription(input.description));
    const validLocal = record(input) && (input.format === "custom" ? creatableLocalPart(input.local_part) : input.local_part === undefined);
    if (!record(input) || !isValidDomain(input.domain) || !validFormat || !validDescription || !validLocal || keys.some((key) => !["domain", "description", "format", "local_part"].includes(key))) {
      throw new ApiError("validation", "The alias request is invalid.");
    }
    const normalizedInput = { ...input, domain: input.domain.toLowerCase() };
    const body = await request("/api/v1/aliases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(normalizedInput) });
    const alias = record(body) ? parseAlias(body.data) : null;
    if (!alias || alias.domain !== normalizedInput.domain) throw new ApiError("malformed", "The server returned an invalid alias.");
    return alias;
  }
  async function createAlias(input: CreateAliasInput): Promise<Alias>;
  async function createAlias(selectedDomain: string, allowedDomains: readonly string[]): Promise<string>;
  async function createAlias(input: CreateAliasInput | string, allowedDomains?: readonly string[]): Promise<Alias | string> {
    if (typeof input !== "string") return createRichAlias(input);
    if (!isValidDomain(input) || !Array.isArray(allowedDomains) || !allowedDomains.every(isValidDomain) || !allowedDomains.includes(input)) throw new ApiError("validation", "Select a domain supplied by the connected server.");
    return (await createRichAlias({ domain: input, format: "random_characters" })).email;
  }
  return {
    async probe() {
      const body = await request("/api/v1/api-token-details");
      if (!record(body) || typeof body.name !== "string" || body.name.length === 0 || !(body.created_at === null || typeof body.created_at === "string") || !(body.expires_at === null || typeof body.expires_at === "string")) throw new ApiError("malformed", "The server returned an unexpected response.");
    },
    async domains() {
      const body = await request("/api/v1/domain-options");
      if (!record(body) || !Array.isArray(body.data) || body.data.length === 0 || !body.data.every(isValidDomain) || new Set(body.data).size !== body.data.length || !(body.defaultAliasDomain === null || (isValidDomain(body.defaultAliasDomain) && body.data.includes(body.defaultAliasDomain))) || body.defaultAliasFormat !== "random_characters") throw new ApiError("malformed", "The server returned invalid domain options.");
      return { domains: body.data as string[], defaultDomain: typeof body.defaultAliasDomain === "string" ? body.defaultAliasDomain : body.data[0] as string };
    },
    async listAliases(search?: string) {
      if (!(search === undefined || typeof search === "string")) throw new ApiError("validation", "The alias search is invalid.");
      const query = search === undefined ? "" : `?${new URLSearchParams({ "filter[search]": search })}`;
      const body = await request(`/api/v1/aliases${query}`);
      if (!record(body) || !Array.isArray(body.data) || body.data.length > 100) throw new ApiError("malformed", "The server returned invalid aliases.");
      const aliases = body.data.map(parseAlias);
      if (aliases.some((alias) => alias === null)) throw new ApiError("malformed", "The server returned invalid aliases.");
      return aliases as Alias[];
    },
    createAlias,
    async activateAlias(id: string) {
      requireId(id);
      const body = await request("/api/v1/active-aliases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      const alias = record(body) ? parseAlias(body.data) : null;
      if (!alias || alias.id !== id || !alias.active) throw new ApiError("malformed", "The server returned an invalid alias.");
      return alias;
    },
    async deactivateAlias(id: string) {
      requireId(id);
      await request(`/api/v1/active-aliases/${id}`, { method: "DELETE" });
    },
    async deleteAlias(id: string) {
      requireId(id);
      await request(`/api/v1/aliases/${id}`, { method: "DELETE" });
    },
  };
}
