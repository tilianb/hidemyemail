export interface Env {
  DB: D1Database;
  SES_REGION: string;
  REVERSE_PREFIX: string;
  SES_ACCESS_KEY_ID: string;
  SES_SECRET_ACCESS_KEY: string;
  SESSION_SECRET: string;
  AUTH_PASSWORD_HASH: string;   // hex PBKDF2 output
  AUTH_PASSWORD_SALT: string;   // hex salt
  SNS_ALLOWED_TOPIC_ARN?: string;
  TEST_MIGRATIONS?: unknown;
}

export interface DomainRow { id: number; domain: string; default_destination: string; active: number; created_at: number; }
export interface AliasRow {
  id: number; domain_id: number; local_part: string; full_address: string;
  destination: string | null; label: string | null; active: number; source: string;
  fwd_count: number; blocked_count: number; reply_count: number;
  created_at: number; last_seen_at: number | null;
}
export interface ReverseRow { id: number; token: string; alias_id: number; external_sender: string; created_at: number; last_used_at: number | null; }
export interface BlockRow { id: number; alias_id: number | null; pattern: string; created_at: number; }
export type EventType = "forward" | "reply" | "block" | "reject" | "error";
