export interface Domain {
  id: number;
  user_id: number;
  is_global: 0 | 1;
  domain: string;
  default_destination: string | null;
  active: 0 | 1;
  allow_custom_aliases: 0 | 1;
  allow_subdomain_aliases: 0 | 1;
  created_at: number;
  verified_at: number | null;
  verification_token: string | null;
  catch_all: 0 | 1 | null;
  inline_actions_pref: "on" | "off" | null;
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
  muted_until: number | null;
}

export interface Block {
  id: number;
  alias_id: number | null;
  domain_id: number | null;
  kind: "block" | "allow";
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

// Fresh-auth expiry is not a dead session: the Worker 401s with this message
// when the session is valid but the 10-minute freshness window lapsed. Surface
// it so callers (AppAuth, Settings) can prompt a re-login for that one action
// instead of treating the whole session as gone.
const FRESH_AUTH_REQUIRED = "Fresh authentication required";

async function error401(res: Response): Promise<Error> {
  try {
    const b = await res.json();
    if (b && typeof b === "object" && "error" in b && b.error === FRESH_AUTH_REQUIRED) {
      return new Error(FRESH_AUTH_REQUIRED);
    }
  } catch {
    // Ignore JSON parse errors for non-JSON error responses
  }
  return new Error("unauthorized");
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (res.status === 401) throw await error401(res);
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
  suppressed_at: number | null;
  suppression_reason: string | null;
  suppression_class: string | null;
}

export interface SuppressionEntry {
  id: number;
  user_id: number;
  suppressed_at: number;
  suppression_reason: string | null;
  suppression_class: string | null;
  bounce_24h: number;
  bounce_7d: number;
  complaint_24h: number;
  complaint_7d: number;
}

export interface SuppressionSummary {
  bounce_24h: number;
  bounce_7d: number;
  complaint_24h: number;
  complaint_7d: number;
  suppressed: number;
  hard_suppressed: number;
  soft_suppressed: number;
}

export const api = {
  config: () => req<{
    main_global_domain: string;
    max_subdomains: number;
    max_total_aliases: number;
    registration_enabled: boolean;
    alias_quota_buffer_enabled: boolean;
    catch_all_auto_create: boolean;
    inline_actions_default_enabled: boolean;
  }>("/api/config"),
  login: (password: string) => req<{ ok: true; userId: number } | { mfa_required: true }>("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  completeMfa: (code: string) => req<{ ok: true; userId: number }>("/api/mfa/complete", { method: "POST", body: JSON.stringify({ code }) }),
  register: (password: string) => req<{ ok: true, userId: number; recovery_codes: string[] }>("/api/register", { method: "POST", body: JSON.stringify({ password }) }),
  // Cancel a pending account deletion during the 7-day grace window
  restoreAccount: (password: string) => req<{ ok: true }>("/api/restore", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => req<{ ok: true }>("/api/logout", { method: "POST" }),
  stats: () => req<StatsData>("/api/stats"),
  
  destinations: () => req<Destination[]>("/api/destinations"),
  createDestination: (email: string) => req<{ ok: true }>("/api/destinations", { method: "POST", body: JSON.stringify({ email }) }),
  resendDestinationVerification: (id: number) => req<{ ok: true }>(`/api/destinations/${id}/resend`, { method: "POST" }),
  deleteDestination: (id: number) => req<{ ok: true }>(`/api/destinations/${id}`, { method: "DELETE" }),
  setDefaultDestination: (id: number) => req<{ ok: true }>(`/api/destinations/${id}/default`, { method: "PATCH" }),
  unsuppressDestination: (id: number) => req<{ ok: true }>(`/api/destinations/${id}/unsuppress`, { method: "POST" }),

  domains: () => req<Domain[]>("/api/domains"),
  createDomain: (domain: string, default_destination: string, base_domain_id?: number) => req<Domain>("/api/domains", { method: "POST", body: JSON.stringify({ domain, default_destination, base_domain_id }) }),
  updateDomainDestination: (id: number, default_destination: string) => req<{ ok: true; default_destination: string }>(`/api/domains/${id}`, { method: "PATCH", body: JSON.stringify({ default_destination }) }),
  patchDomain: (id: number, data: { catch_all?: 0 | 1 | null; inline_actions_pref?: "on" | "off" | null; default_destination?: string | null }) => req<{ ok: true }>(`/api/domains/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteDomain: (id: number) => req<{ ok: true }>(`/api/domains/${id}`, { method: "DELETE" }),

  aliases: (q = "") => req<Alias[]>(`/api/aliases${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  createAlias: (b: { domain_id: number; local_part: string; destination?: string; label?: string }) => req<Alias>("/api/aliases", { method: "POST", body: JSON.stringify(b) }),
  patchAlias: (id: number, b: Record<string, unknown>) => req<{ ok: true }>(`/api/aliases/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deleteAlias: (id: number) => req<{ ok: true }>(`/api/aliases/${id}`, { method: "DELETE" }),
  events: (id: number) => req<EmailEvent[]>(`/api/aliases/${id}/events`),

  blocks: () => req<Block[]>("/api/blocks"),
  createBlock: (pattern: string, opts?: { alias_id?: number; domain_id?: number; kind?: "block" | "allow" }) => req<Block>("/api/blocks", { method: "POST", body: JSON.stringify({ pattern, ...opts }) }),
  deleteBlock: (id: number) => req<{ ok: true }>(`/api/blocks/${id}`, { method: "DELETE" }),

  // Admin endpoints
  adminStats: () => req<{ totals: { users: number; aliases: number; active: number }; last24h: Record<string, number> }>("/api/admin/stats"),
  adminUsers: () => req<{ users: { id: number; created_at: number; alias_count: number; active: number; forwarding: number; name: string | null }[] }>("/api/admin/users"),
  adminDeleteUser: (id: number) => req<{ ok: true }>(`/api/admin/users/${id}`, { method: "DELETE" }),
  adminUpdateUser: (id: number, data: { active?: number; forwarding?: number; name?: string }) => req<{ ok: true }>(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  adminRecoverUser: (id: number, sendEmail: boolean) => req<{ token: string; ok?: boolean }>(`/api/admin/users/${id}/recovery`, { method: "POST", body: JSON.stringify({ sendEmail }) }),
  adminCreateDomain: (domain: string) => req<{ ok: true }>("/api/admin/domains", { method: "POST", body: JSON.stringify({ domain }) }),
  adminUpdateDomain: (id: number, data: { allow_custom_aliases?: number; allow_subdomain_aliases?: number; active?: number }) => req<{ ok: true }>(`/api/admin/domains/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  adminVerifyDomain: (id: number) => req<{ ok: true; verified: boolean; error?: string; results?: { verify_txt: boolean; mx: boolean; spf: boolean; wildcard_mx: boolean } }>(`/api/admin/domains/${id}/verify`, { method: "POST" }),

  // Push notification endpoints
  pushTest: () => req<{ ok: boolean; sent: number; failures: { token: string; status: number; reason?: string }[]; reason?: string }>("/api/push/test", { method: "POST" }),

  // API keys (addy.io-compatible /api/v1 surface)
  apiKeys: () => req<{ id: number; name: string; token_prefix: string; created_at: number; last_used_at: number | null }[]>("/api/settings/api-keys"),
  createApiKey: (name: string) => req<{ id: number; name: string; token_prefix: string; created_at: number; token: string }>("/api/settings/api-keys", { method: "POST", body: JSON.stringify({ name }) }),
  deleteApiKey: (id: number) => req<{ ok: true }>(`/api/settings/api-keys/${id}`, { method: "DELETE" }),

  // Passkey endpoints
  passkeyList: () => req<{ id: string; device_name: string | null; created_at: number }[]>("/api/settings/passkeys"),
  passkeyChallenge: () => req<Record<string, unknown>>("/api/settings/passkeys/challenge", { method: "POST" }),
  passkeyRegister: (body: { response: unknown; deviceName?: string }) => req<{ ok: true; id: string }>("/api/settings/passkeys/register", { method: "POST", body: JSON.stringify(body) }),
  passkeyRename: (id: string, deviceName: string) => req<{ ok: true }>(`/api/settings/passkeys/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ deviceName }) }),
  passkeyDelete: (id: string) => req<{ ok: true }>(`/api/settings/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  passkeyLoginChallenge: () => req<Record<string, unknown>>("/api/passkey/challenge", { method: "POST" }),
  passkeyLoginVerify: (response: unknown) => req<{ ok: true; userId: number }>("/api/passkey/verify", { method: "POST", body: JSON.stringify(response) }),

  // User preferences
  preferences: () => req<{
    inline_actions_pref: "on" | "off" | null;
    inline_actions_position: "header" | "footer" | null;
    defaults: { inline_actions_enabled: boolean; inline_actions_position: string };
  }>("/api/settings/preferences"),
  updatePreferences: (data: {
    inline_actions_pref?: "on" | "off" | null;
    inline_actions_position?: "header" | "footer" | null;
  }) => req<{ ok: true }>("/api/settings/preferences", { method: "PATCH", body: JSON.stringify(data) }),

  // MFA settings endpoints
  mfaStatus: () => req<{ enabled: boolean; backupCodesRemaining: number }>("/api/settings/mfa"),
  mfaSetup: () => req<{ secret: string; uri: string }>("/api/settings/mfa/setup", { method: "POST" }),
  mfaVerify: (code: string) => req<{ ok: true; backupCodes: string[] }>("/api/settings/mfa/verify", { method: "POST", body: JSON.stringify({ code }) }),
  mfaDisable: (code: string) => req<{ ok: true }>("/api/settings/mfa/disable", { method: "POST", body: JSON.stringify({ code }) }),
  mfaRegenerateBackupCodes: (code: string) => req<{ ok: true; backupCodes: string[] }>("/api/settings/mfa/backup-codes", { method: "POST", body: JSON.stringify({ code }) }),

  // Account data export — returns a JSON Blob for download
  exportAccount: async (): Promise<void> => {
    const res = await fetch("/api/account/export", { credentials: "include" });
    if (res.status === 401) throw await error401(res);
    if (!res.ok) {
      let msg = `${res.status}`;
      try { const b = await res.json(); if (b && typeof b === "object" && "error" in b) msg = (b as any).error; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hidemyemail-export-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // Account deletion — tombstones the account (7-day grace, then hard-delete)
  deleteAccount: (password: string, confirm: string) =>
    req<{ ok: true }>("/api/account/delete", { method: "POST", body: JSON.stringify({ password, confirm }) }),

  // Recovery endpoints
  recoverSendCode: (token: string) => req<{ ok: true }>("/api/recover/send-code", { method: "POST", body: JSON.stringify({ token }) }),
  recoverVerify: (token: string, code: string) => req<{ ok: true; passphrase: string }>("/api/recover/verify", { method: "POST", body: JSON.stringify({ token, code }) }),
  // Self-service recovery: username identifies the account, a one-time recovery
  // code is the secret proof. No admin token or destination email needed.
  recoverWithCode: (username: string, code: string) => req<{ ok: true; passphrase: string; codes_remaining: number }>("/api/recover/code", { method: "POST", body: JSON.stringify({ username, code }) }),

  // Account profile (username + recovery-code status)
  profile: () => req<{ id: number; username: string | null; name: string | null; isAdmin: boolean; recovery_codes_remaining: number }>("/api/account/profile"),
  setUsername: (username: string | null) => req<{ ok: true; username: string | null }>("/api/account/username", { method: "PATCH", body: JSON.stringify({ username }) }),
  recoveryCodesStatus: () => req<{ remaining: number }>("/api/account/recovery-codes"),
  regenerateRecoveryCodes: () => req<{ codes: string[] }>("/api/account/recovery-codes", { method: "POST" }),

  // Admin environment & settings
  adminEnv: () => req<{ vars: Record<string, { value: string; secret: false }>; secrets: Record<string, { configured: boolean; preview?: string }> }>("/api/admin/env"),
  adminSettings: () => req<{ settings: Record<string, { value: string; updated_at: number }> }>("/api/admin/settings"),
  adminUpdateSettings: (data: Record<string, string>) => req<{ ok: true; updated: number }>("/api/admin/settings", { method: "PATCH", body: JSON.stringify(data) }),
  adminSendTestEmail: (data: { type: string; to: string }) => req<{ ok: true; type: string; to: string }>("/api/admin/test-email", { method: "POST", body: JSON.stringify(data) }),
  adminSuppressions: () => req<{ suppressions: SuppressionEntry[]; totals: SuppressionSummary; health: "healthy" | "attention" }>("/api/admin/suppressions"),
  adminClearSuppression: (id: number) => req<{ ok: true }>(`/api/admin/suppressions/${id}/clear`, { method: "POST" }),
};
