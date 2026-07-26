export interface Env {
  // In self-hosted mode the deployment wrapper must overwrite
  // X-HideMyEmail-Client-IP from its trusted socket/proxy boundary.
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
  // Web origin of the dashboard, e.g. https://app.hidemyemail.dev. Used as the
  // Canonical WebAuthn relying-party origin. Must be HTTPS except localhost.
  APP_ORIGIN?: string;
  // Apple App ID ("<TeamID>.<bundleId>", e.g. ABCDE12345.dev.hidemyemail.app)
  // published in the apple-app-site-association file for passkey association.
  APPLE_APP_ID?: string;
  // APNs push credentials (token-based auth). When any is missing, push is a
  // no-op: registration still works, but no notifications are sent.
  APNS_KEY_ID?: string;        // 10-char Key ID for the .p8 signing key
  APNS_TEAM_ID?: string;       // Apple Developer Team ID (falls back to APPLE_APP_ID prefix)
  APNS_AUTH_KEY?: string;      // contents of the AuthKey_XXXX.p8 (PEM) — a secret
  APNS_BUNDLE_ID?: string;     // apns-topic (falls back to APPLE_APP_ID suffix)
  APNS_HOST?: string;          // override host; default api.push.apple.com (use api.sandbox.push.apple.com for dev builds)
  // FCM push credentials (Android, HTTP v1 API). When missing, Android push is
  // a no-op: registration still works, but no notifications are sent.
  FCM_SERVICE_ACCOUNT?: string; // full Firebase service-account JSON (a secret)
  FCM_PROJECT_ID?: string;      // overrides the service account's project_id when set
}

export interface DomainRow { id: number; domain: string; default_destination: string; active: number; created_at: number; verified_at: number | null; verification_token: string | null; catch_all: number | null; inline_actions_pref: string | null; }
export interface AliasRow {
  id: number; user_id: number; domain_id: number; local_part: string; full_address: string;
  destination: string | null; label: string | null; active: number; source: string;
  fwd_count: number; blocked_count: number; reply_count: number;
  created_at: number; last_seen_at: number | null; muted_until: number | null;
}
export interface ReverseRow { id: number; token: string; alias_id: number; external_sender: string; created_at: number; last_used_at: number | null; }

// Decoded reverse address: "shop+alice=store.com@domain" → { aliasLocal: "shop", externalSender: "alice@store.com" }
export interface ParsedReverse { aliasLocal: string; externalSender: string; }
// SES receipt verdicts. spf/dmarc gate reverse-alias replies (anti-spoof);
// spam/virus gate inbound forwards (sender-reputation protection).
export interface ReplyAuth { spf?: string; dmarc?: string; spam?: string; virus?: string; }
export interface BlockRow { id: number; user_id: number; alias_id: number | null; domain_id: number | null; kind: string; pattern: string; created_at: number; }
export type EventType = "forward" | "reply" | "block" | "reject" | "error" | "bounce" | "soft_bounce" | "complaint";

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
