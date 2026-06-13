// Hardcoded fallback defaults — used when DB settings row is missing.
// These match the seed values in migration 0007_settings.sql.
export const SETTING_DEFAULTS: Record<string, string> = {
  rate_limit_per_alias: "20",
  rate_limit_reply_per_alias: "10",
  rate_limit_global: "1000",
  max_inbound_bytes: String(25 * 1024 * 1024),
  catch_all_auto_create: "true",
  registration_enabled: "false",
  cors_allowed_domains: "http://localhost:5173",
  ses_region: "",
  ses_access_key_id: "",
  ses_secret_access_key: "",
  s3_inbound_bucket: "",
  sns_allowed_topic_arn: "",
  sns_inbound_topic_arn: "",
  forwarded_from_format: "name_address_parens",
  main_global_domain: "",
  max_total_aliases: "10",
  alias_quota_buffer_enabled: "true",
  max_subdomains: "5",
  inline_actions_default_enabled: "false",
  inline_actions_default_position: "footer",
  soft_bounce_threshold: "3",
  reply_distinct_recipient_cap: "15",
  // SES receipt verdict handling for inbound forwards. Forwarded spam is
  // re-signed with the alias domain's DKIM, so it burns OUR reputation:
  // spam → flag (X-Spam-Flag, recipient filters can act), virus → drop.
  spam_verdict_action: "flag",   // "forward" | "flag" | "drop"
  virus_verdict_action: "drop",  // "forward" | "flag" | "drop"
  // When to add our List-Unsubscribe header to forwards. Adding it to
  // person-to-person mail makes it look like bulk mail to spam filters;
  // "bulk_only" adds it only when the original message already carried
  // List-Unsubscribe or Precedence: bulk/list.
  unsubscribe_header_mode: "bulk_only", // "always" | "bulk_only" | "never"
};

/** All valid setting keys. Used to validate admin PATCH requests. */
export const VALID_SETTING_KEYS = Object.keys(SETTING_DEFAULTS);
