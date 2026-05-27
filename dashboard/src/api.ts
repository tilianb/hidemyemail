export interface Domain {
  id: number;
  user_id: number;
  is_global: 0 | 1;
  domain: string;
  default_destination: string | null;
  active: 0 | 1;
  created_at: number;
}

export interface Alias {
  id: number;
  domain_id: number;
  local_part: string;
  full_address: string;
  destination: string | null;
  label: string | null;
  active: 0 | 1;
  source: string;
  fwd_count: number;
  blocked_count: number;
  reply_count: number;
  created_at: number;
  last_seen_at: number | null;
}

export interface Block {
  id: number;
  alias_id: number | null;
  pattern: string;
  created_at: number;
}

export interface EmailEvent {
  id: number;
  alias_id: number | null;
  type: string;
  external_sender: string | null;
  subject: string | null;
  bytes: number | null;
  detail: string | null;
  ts: number;
}

export interface StatsData {
  totals: { aliases: number; active: number };
  last24h: { forward: number; reply: number; block: number; reject: number; error: number };
  topAliases: {
    full_address: string;
    fwd_count: number;
    reply_count: number;
    blocked_count: number;
  }[];
  isAdmin?: boolean;
  userName?: string;
}

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

export interface Destination {
  id: number;
  email: string;
  is_default: number;
  verified_at: number | null;
  created_at: number;
}

export const api = {
  login: (password: string) => req<{ ok: true; userId: number } | { mfa_required: true }>("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  completeMfa: (code: string) => req<{ ok: true; userId: number }>("/api/mfa/complete", { method: "POST", body: JSON.stringify({ code }) }),
  register: (password: string) => req<{ ok: true, userId: number }>("/api/register", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => req<{ ok: true }>("/api/logout", { method: "POST" }),
  stats: () => req<StatsData>("/api/stats"),
  
  destinations: () => req<Destination[]>("/api/destinations"),
  createDestination: (email: string) => req<{ ok: true }>("/api/destinations", { method: "POST", body: JSON.stringify({ email }) }),
  deleteDestination: (id: number) => req<{ ok: true }>(`/api/destinations/${id}`, { method: "DELETE" }),
  setDefaultDestination: (id: number) => req<{ ok: true }>(`/api/destinations/${id}/default`, { method: "PATCH" }),

  domains: () => req<Domain[]>("/api/domains"),
  createDomain: (domain: string, default_destination: string) => req<Domain>("/api/domains", { method: "POST", body: JSON.stringify({ domain, default_destination }) }),
  deleteDomain: (id: number) => req<{ ok: true }>(`/api/domains/${id}`, { method: "DELETE" }),

  aliases: (q = "") => req<Alias[]>(`/api/aliases${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  createAlias: (b: { domain_id: number; local_part: string; destination?: string; label?: string }) => req<Alias>("/api/aliases", { method: "POST", body: JSON.stringify(b) }),
  patchAlias: (id: number, b: Record<string, unknown>) => req<{ ok: true }>(`/api/aliases/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deleteAlias: (id: number) => req<{ ok: true }>(`/api/aliases/${id}`, { method: "DELETE" }),
  events: (id: number) => req<EmailEvent[]>(`/api/aliases/${id}/events`),

  blocks: () => req<Block[]>("/api/blocks"),
  createBlock: (pattern: string, alias_id?: number) => req<Block>("/api/blocks", { method: "POST", body: JSON.stringify({ pattern, alias_id }) }),
  deleteBlock: (id: number) => req<{ ok: true }>(`/api/blocks/${id}`, { method: "DELETE" }),

  // Admin endpoints
  adminStats: () => req<{ totals: { users: number; aliases: number; active: number }; last24h: Record<string, number> }>("/api/admin/stats"),
  adminUsers: () => req<{ users: { id: number; created_at: number; alias_count: number; active: number; forwarding: number; name: string | null }[] }>("/api/admin/users"),
  adminDeleteUser: (id: number) => req<{ ok: true }>(`/api/admin/users/${id}`, { method: "DELETE" }),
  adminUpdateUser: (id: number, data: { active?: number; forwarding?: number; name?: string }) => req<{ ok: true }>(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  adminRecoverUser: (id: number, sendEmail: boolean) => req<{ token: string; ok?: boolean }>(`/api/admin/users/${id}/recovery`, { method: "POST", body: JSON.stringify({ sendEmail }) }),
  adminCreateDomain: (domain: string) => req<{ ok: true }>("/api/admin/domains", { method: "POST", body: JSON.stringify({ domain }) }),

  // Passkey endpoints
  passkeyList: () => req<{ id: string; device_name: string | null; created_at: number }[]>("/api/settings/passkeys"),
  passkeyChallenge: () => req<Record<string, unknown>>("/api/settings/passkeys/challenge", { method: "POST" }),
  passkeyRegister: (body: { response: unknown; deviceName?: string }) => req<{ ok: true; id: string }>("/api/settings/passkeys/register", { method: "POST", body: JSON.stringify(body) }),
  passkeyRename: (id: string, deviceName: string) => req<{ ok: true }>(`/api/settings/passkeys/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ deviceName }) }),
  passkeyDelete: (id: string) => req<{ ok: true }>(`/api/settings/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  passkeyLoginChallenge: () => req<Record<string, unknown>>("/api/passkey/challenge", { method: "POST" }),
  passkeyLoginVerify: (response: unknown) => req<{ ok: true; userId: number }>("/api/passkey/verify", { method: "POST", body: JSON.stringify(response) }),

  // MFA settings endpoints
  mfaStatus: () => req<{ enabled: boolean; backupCodesRemaining: number }>("/api/settings/mfa"),
  mfaSetup: () => req<{ secret: string; uri: string }>("/api/settings/mfa/setup", { method: "POST" }),
  mfaVerify: (code: string) => req<{ ok: true; backupCodes: string[] }>("/api/settings/mfa/verify", { method: "POST", body: JSON.stringify({ code }) }),
  mfaDisable: (code: string) => req<{ ok: true }>("/api/settings/mfa/disable", { method: "POST", body: JSON.stringify({ code }) }),
  mfaRegenerateBackupCodes: (code: string) => req<{ ok: true; backupCodes: string[] }>("/api/settings/mfa/backup-codes", { method: "POST", body: JSON.stringify({ code }) }),

  // Recovery endpoints
  recoverSendCode: (token: string) => req<{ ok: true }>("/api/recover/send-code", { method: "POST", body: JSON.stringify({ token }) }),
  recoverVerify: (token: string, code: string) => req<{ ok: true; passphrase: string }>("/api/recover/verify", { method: "POST", body: JSON.stringify({ token, code }) }),

  // Admin environment & settings
  adminEnv: () => req<{ vars: Record<string, { value: string; secret: false }>; secrets: Record<string, { configured: boolean; preview?: string }> }>("/api/admin/env"),
  adminSettings: () => req<{ settings: Record<string, { value: string; updated_at: number }> }>("/api/admin/settings"),
  adminUpdateSettings: (data: Record<string, string>) => req<{ ok: true; updated: number }>("/api/admin/settings", { method: "PATCH", body: JSON.stringify(data) }),
};
