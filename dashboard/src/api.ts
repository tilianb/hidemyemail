async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const errBody = await res.json();
      if (errBody && typeof errBody === "object" && "error" in errBody && typeof errBody.error === "string") {
        msg = errBody.error;
      }
    } catch {
      // Ignore JSON parse errors for non-JSON error responses
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}
export const api = {
  login: (password: string) => req<{ ok: true }>("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => req("/api/logout", { method: "POST" }),
  stats: () => req<any>("/api/stats"),
  domains: () => req<any[]>("/api/domains"),
  createDomain: (domain: string, default_destination: string) => req("/api/domains", { method: "POST", body: JSON.stringify({ domain, default_destination }) }),
  aliases: (q = "") => req<any[]>(`/api/aliases${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  createAlias: (b: { domain_id: number; local_part: string; destination?: string; label?: string }) => req("/api/aliases", { method: "POST", body: JSON.stringify(b) }),
  patchAlias: (id: number, b: Record<string, unknown>) => req(`/api/aliases/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deleteAlias: (id: number) => req(`/api/aliases/${id}`, { method: "DELETE" }),
  events: (id: number) => req<any[]>(`/api/aliases/${id}/events`),
  blocks: () => req<any[]>("/api/blocks"),
  createBlock: (pattern: string, alias_id?: number) => req("/api/blocks", { method: "POST", body: JSON.stringify({ pattern, alias_id }) }),
  deleteBlock: (id: number) => req(`/api/blocks/${id}`, { method: "DELETE" }),
};
