export interface Env {
  ENVIRONMENT: string;
  DB: D1Database;
  SES_REGION: string;
  SES_ACCESS_KEY_ID: string;
  SES_SECRET_ACCESS_KEY: string;
  SESSION_SECRET: string;
  AUTH_PASSWORD_HASH: string;   // hex PBKDF2 output
  AUTH_PASSWORD_SALT: string;   // hex salt
  SNS_ALLOWED_TOPIC_ARN?: string;
  SNS_INBOUND_TOPIC_ARN?: string;   // SNS topic for SES inbound receipt notifications
  S3_INBOUND_BUCKET: string;        // S3 bucket where SES stores raw inbound emails
  TEST_MIGRATIONS?: unknown;
  DESTINATION_ENCRYPTION_KEY: string;
  ACTION_SECRET?: string;
}

export interface DomainRow { id: number; domain: string; default_destination: string; active: number; created_at: number; verified_at: number | null; verification_token: string | null; }
export interface AliasRow {
  id: number; user_id: number; domain_id: number; local_part: string; full_address: string;
  destination: string | null; label: string | null; active: number; source: string;
  fwd_count: number; blocked_count: number; reply_count: number;
  created_at: number; last_seen_at: number | null; muted_until: number | null;
}
export interface ReverseRow { id: number; token: string; alias_id: number; external_sender: string; created_at: number; last_used_at: number | null; }

// Decoded reverse address: "shop+alice=store.com@domain" → { aliasLocal: "shop", externalSender: "alice@store.com" }
export interface ParsedReverse { aliasLocal: string; externalSender: string; }
// SES receipt verdicts threaded into reply routing as the anti-spoof gate.
export interface ReplyAuth { spf?: string; dmarc?: string; }
export interface BlockRow { id: number; user_id: number; alias_id: number | null; pattern: string; created_at: number; }
export type EventType = "forward" | "reply" | "block" | "reject" | "error" | "bounce" | "complaint";

export interface DestinationRow {
  id: number;
  user_id: number;
  email: string;
  email_hash: string | null;
  token: string;
  verified_at: number | null;
  created_at: number;
  is_default: number;
  suppressed_at: number | null;
  suppression_reason: string | null;
  suppression_class: string | null;
}
