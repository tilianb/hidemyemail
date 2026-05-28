// Hardcoded fallback defaults — used when DB settings row is missing.
// These match the seed values in migration 0007_settings.sql.
export const SETTING_DEFAULTS: Record<string, string> = {
  rate_limit_per_alias: "20",
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
};

// Kept for backward-compat with any imports (tests, etc.)
export const RATE_PER_HOUR_ALIAS = 20;   // mirrors old ANONADDY_LIMIT
export const RATE_PER_HOUR_GLOBAL = 1000;
export const MAX_INBOUND_BYTES = 25 * 1024 * 1024;

/** All valid setting keys. Used to validate admin PATCH requests. */
export const VALID_SETTING_KEYS = Object.keys(SETTING_DEFAULTS);
