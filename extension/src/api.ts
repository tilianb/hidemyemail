import type { ExtensionConfig } from "./config";

export type ApiErrorKind = "auth" | "permission" | "quota" | "validation" | "server" | "network" | "malformed";
export class ApiError extends Error {
  constructor(public readonly kind: ApiErrorKind, message: string) { super(message); }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const isValidDomain = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 253) return false;
  const labels = value.split(".");
  return labels.length > 1 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
};
const localPart = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(value) && !value.startsWith(".") && !value.endsWith(".") && !value.includes("..");

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
      response = await fetcher(`${config.server}${path}`, { ...init, headers: { Authorization: `Bearer ${config.key}`, ...init.headers } });
    } catch {
      throw new ApiError("network", "Could not reach the server. Check the deployment and try again.");
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw httpError(response.status);
    return body;
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
    async createAlias(selectedDomain: string, allowedDomains: readonly string[]) {
      if (!isValidDomain(selectedDomain) || !allowedDomains.includes(selectedDomain)) throw new ApiError("validation", "Select a domain supplied by the connected server.");
      const body = await request("/api/v1/aliases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain: selectedDomain, format: "random_characters" }) });
      if (!record(body) || !record(body.data) || typeof body.data.id !== "string" || !localPart(body.data.local_part) || body.data.domain !== selectedDomain || body.data.email !== `${body.data.local_part}@${selectedDomain}` || typeof body.data.active !== "boolean") throw new ApiError("malformed", "The server returned an invalid alias.");
      return body.data.email;
    },
  };
}
