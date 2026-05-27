// Hardcoded fallback defaults — used when DB settings row is missing.
// These match the seed values in migration 0007_settings.sql.
export const SETTING_DEFAULTS: Record<string, string> = {
  rate_limit_per_alias: "200",
  rate_limit_global: "1000",
  max_inbound_bytes: String(25 * 1024 * 1024),
  catch_all_auto_create: "true",
  registration_enabled: "true",
  cors_allowed_domains: "https://hidemyemail.dev,http://localhost:5173",
  ses_region: "",
  ses_access_key_id: "",
  ses_secret_access_key: "",
  s3_inbound_bucket: "",
  sns_allowed_topic_arn: "",
  sns_inbound_topic_arn: "",
  forwarded_from_format: "name_address_parens",
  main_global_domain: "hidemyemail.dev",
};

// Kept for backward-compat with any imports (tests, etc.)
export const RATE_PER_HOUR_ALIAS = 200;   // mirrors old ANONADDY_LIMIT
export const RATE_PER_HOUR_GLOBAL = 1000;
export const MAX_INBOUND_BYTES = 25 * 1024 * 1024;

/** All valid setting keys. Used to validate admin PATCH requests. */
export const VALID_SETTING_KEYS = Object.keys(SETTING_DEFAULTS);
