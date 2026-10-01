export interface SettingDefinition {
  default: string;
  validate?: (value: string) => string | null;
  env?: string;
  mail?: boolean;
  encrypted?: boolean;
  masked?: boolean;
  freshAuth?: boolean;
}

const integerAtLeast = (minimum: number, message: string) => (value: string) => {
  const number = parseInt(value, 10);
  return isNaN(number) || number < minimum ? message : null;
};
const oneOf = (allowed: readonly string[], message: string) => (value: string) =>
  allowed.includes(value) ? null : message;
const boolean = oneOf(["true", "false"], 'must be "true" or "false"');
const mail = (definition: Omit<SettingDefinition, "mail" | "freshAuth">): SettingDefinition =>
  ({ ...definition, mail: true, freshAuth: true });
const mailSecret = (definition: Omit<SettingDefinition, "mail" | "freshAuth" | "encrypted" | "masked">): SettingDefinition =>
  mail({ ...definition, encrypted: true, masked: true });

/** Canonical metadata for every runtime setting. */
export const SETTING_DEFINITIONS = {
  rate_limit_per_alias: { default: "20", validate: integerAtLeast(-1, "must be a number greater than or equal to -1") },
  rate_limit_reply_per_alias: { default: "10", validate: integerAtLeast(-1, "must be a number greater than or equal to -1") },
  rate_limit_global: { default: "1000", validate: integerAtLeast(-1, "must be a number greater than or equal to -1") },
  max_inbound_bytes: { default: String(25 * 1024 * 1024), validate: integerAtLeast(1024, "must be at least 1024 (1KB)") },
  catch_all_auto_create: { default: "true", validate: boolean },
  registration_enabled: { default: "false", validate: boolean },
  cors_allowed_domains: { default: "http://localhost:5173", validate: (value: string) => value.trim() ? null : "cannot be empty" },
  ses_region: mail({ default: "", env: "SES_REGION" }),
  ses_access_key_id: mail({ default: "", env: "SES_ACCESS_KEY_ID", masked: true }),
  ses_secret_access_key: mail({ default: "", env: "SES_SECRET_ACCESS_KEY", encrypted: true, masked: true }),
  mail_outbound_provider: mail({ default: "", env: "MAIL_OUTBOUND_PROVIDER", validate: oneOf(["", "ses", "smtp"], "must be ses or smtp") }),
  smtp_outbound_host: mail({ default: "", env: "SMTP_OUTBOUND_HOST", validate: noLineBreaks }),
  smtp_outbound_port: mail({ default: "", env: "SMTP_OUTBOUND_PORT", validate: port }),
  smtp_outbound_tls: mail({ default: "", env: "SMTP_OUTBOUND_TLS", validate: oneOf(["", "implicit", "starttls", "trusted-cleartext"], "invalid TLS mode") }),
  smtp_outbound_username: mailSecret({ default: "", env: "SMTP_OUTBOUND_USERNAME", validate: noLineBreaks }),
  smtp_outbound_password: mailSecret({ default: "", env: "SMTP_OUTBOUND_PASSWORD" }),
  smtp_inbound_enabled: mail({ default: "", env: "SMTP_INBOUND_ENABLED", validate: oneOf(["", "true", "false"], "must be true or false") }),
  smtp_inbound_host: mail({ default: "", env: "SMTP_INBOUND_HOST", validate: noLineBreaks }),
  smtp_inbound_port: mail({ default: "", env: "SMTP_INBOUND_PORT", validate: port }),
  smtp_inbound_tls: mail({ default: "", env: "SMTP_INBOUND_TLS", validate: oneOf(["", "implicit", "starttls"], "invalid TLS mode") }),
  smtp_inbound_username: mailSecret({ default: "", env: "SMTP_INBOUND_USERNAME", validate: noLineBreaks }),
  smtp_inbound_password: mailSecret({ default: "", env: "SMTP_INBOUND_PASSWORD" }),
  smtp_inbound_gateway_id: mail({ default: "", env: "SMTP_INBOUND_GATEWAY_ID", validate: gatewayId }),
  smtp_inbound_trusted_peers: mail({ default: "", env: "SMTP_INBOUND_TRUSTED_PEERS", validate: trustedPeers }),
  smtp_inbound_max_bytes: mail({ default: "", env: "SMTP_INBOUND_MAX_BYTES", validate: minimumBytes }),
  s3_inbound_bucket: { default: "", env: "S3_INBOUND_BUCKET" },
  sns_allowed_topic_arn: { default: "", env: "SNS_ALLOWED_TOPIC_ARN" },
  sns_inbound_topic_arn: { default: "", env: "SNS_INBOUND_TOPIC_ARN" },
  forwarded_from_format: { default: "name_address_parens", validate: oneOf([
    "name_address_parens", "name_address_parens_at", "name_address_dash", "name_address_dash_at",
    "name_only", "address_only", "address_only_at", "via_hidemyemail",
  ], "invalid format") },
  main_global_domain: { default: "", env: "MAIN_GLOBAL_DOMAIN" },
  max_total_aliases: { default: "10", validate: integerAtLeast(-1, "must be a number greater than or equal to -1") },
  alias_quota_buffer_enabled: { default: "true", validate: boolean },
  max_subdomains: { default: "5", validate: integerAtLeast(-1, "must be a number greater than or equal to -1") },
  inline_actions_default_enabled: { default: "false" },
  inline_actions_default_position: { default: "footer" },
  soft_bounce_threshold: { default: "3", validate: integerAtLeast(0, "must be a number greater than or equal to 0") },
  reply_distinct_recipient_cap: { default: "15", validate: integerAtLeast(-1, "must be a number greater than or equal to -1") },
  events_retention_days: { default: "90" },
  spam_verdict_action: { default: "flag", validate: oneOf(["forward", "flag", "drop"], 'must be "forward", "flag", or "drop"') },
  virus_verdict_action: { default: "drop", validate: oneOf(["forward", "flag", "drop"], 'must be "forward", "flag", or "drop"') },
  unsubscribe_header_mode: { default: "bulk_only", validate: oneOf(["always", "bulk_only", "never"], 'must be "always", "bulk_only", or "never"') },
} satisfies Record<string, SettingDefinition>;

function noLineBreaks(value: string): string | null {
  return /[\r\n]/.test(value) ? "must not contain line breaks" : null;
}
function port(value: string): string | null {
  if (value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 65535 ? null : "must be a port from 1 to 65535";
}
function gatewayId(value: string): string | null {
  if (noLineBreaks(value)) return "must not contain line breaks";
  return value && !/^[A-Za-z0-9._:-]{1,200}$/.test(value) ? "invalid gateway id" : null;
}
function trustedPeers(value: string): string | null {
  return value && value.split(",").some((peer) => !/^[0-9a-f:.]+$/i.test(peer.trim()))
    ? "use comma-separated exact IP addresses" : null;
}
function minimumBytes(value: string): string | null {
  if (value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 1024 ? null : "must be at least 1024";
}

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
export const SETTING_DEFAULTS: Record<string, string> = Object.fromEntries(
  Object.entries(SETTING_DEFINITIONS).map(([key, definition]) => [key, definition.default]),
) as Record<string, string>;
export const VALID_SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[];
const definitionFor = (key: SettingKey): SettingDefinition => SETTING_DEFINITIONS[key];
export const MAIL_SETTING_KEYS = VALID_SETTING_KEYS.filter((key) => definitionFor(key).mail);
export const ENCRYPTED_SETTING_KEYS = new Set(VALID_SETTING_KEYS.filter((key) => definitionFor(key).encrypted));
export const MASKED_SETTING_KEYS = new Set(VALID_SETTING_KEYS.filter((key) => definitionFor(key).masked));
export const FRESH_AUTH_SETTING_KEYS = new Set(VALID_SETTING_KEYS.filter((key) => definitionFor(key).freshAuth));
