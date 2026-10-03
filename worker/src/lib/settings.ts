import { ENCRYPTED_SETTING_KEYS, SETTING_DEFAULTS, SETTING_DEFINITIONS, type SettingDefinition, type SettingKey } from "../config";
import { decryptDestination } from "./crypto";

/**
 * Read a single setting from the D1 settings table with fallback to defaults.
 * Designed to be lightweight — no caching (D1 is fast enough for per-request reads).
 */
export async function getSetting(db: D1Database, key: string, env?: any): Promise<string> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  const val = row?.value ?? SETTING_DEFAULTS[key] ?? "";

  if (val && env?.DESTINATION_ENCRYPTION_KEY && ENCRYPTED_SETTING_KEYS.has(key as SettingKey)) {
    return await decryptDestination(val, env.DESTINATION_ENCRYPTION_KEY);
  }
  return val;
}

/** Read a numeric setting with fallback. */
export async function getNumericSetting(db: D1Database, key: string): Promise<number> {
  const val = await getSetting(db, key);
  const num = parseInt(val, 10);
  return isNaN(num) ? parseInt(SETTING_DEFAULTS[key] ?? "0", 10) : num;
}

/** Read a boolean setting with fallback. */
export async function getBoolSetting(db: D1Database, key: string): Promise<boolean> {
  const val = await getSetting(db, key);
  return val === "true" || val === "1";
}

/** 
 * Resolve a sensitive value, preferring DB override, then falling back to environment variable.
 * Used for AWS settings that might be dynamically updated from the UI.
 */
export async function getEnvWithOverride(db: D1Database, env: any, key: string): Promise<string> {
  const normalized = key.toLowerCase();
  const row = await db.prepare("SELECT value, updated_at FROM settings WHERE key = ?")
    .bind(normalized).first<{ value: string; updated_at: number }>();
  // Seed rows use updated_at=0 and are defaults, not explicit overrides. An
  // explicit empty value is meaningful: it disables an inherited credential.
  if (row && row.updated_at > 0) {
    if (row.value && env?.DESTINATION_ENCRYPTION_KEY && ENCRYPTED_SETTING_KEYS.has(normalized as SettingKey)) {
      return decryptDestination(row.value, env.DESTINATION_ENCRYPTION_KEY);
    }
    return row.value;
  }
  const definition = SETTING_DEFINITIONS[normalized as SettingKey] as SettingDefinition | undefined;
  const envName = definition?.env ?? key.toUpperCase();
  return (env[envName] as string) || SETTING_DEFAULTS[normalized as SettingKey] || "";
}

/** Read all settings as a key-value map. */
export async function getAllSettings(db: D1Database, _env?: any): Promise<Record<string, { value: string; updated_at: number }>> {
  const result: Record<string, { value: string; updated_at: number }> = {};

  // Start with defaults
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    result[key] = { value, updated_at: 0 };
  }

  const rows = await db.prepare("SELECT key, value, updated_at FROM settings").all<{ key: string; value: string; updated_at: number }>();
  for (const row of rows.results ?? []) {
    result[row.key] = { value: row.value, updated_at: row.updated_at };
  }

  return result;
}

/** 
 * Resolve the main global domain, preferring DB override, then falling back to environment variable.
 */
export async function getMainGlobalDomain(db: D1Database, env: any): Promise<string> {
  const dbVal = await getSetting(db, "main_global_domain", env);
  if (dbVal) return dbVal;
  return (env.MAIN_GLOBAL_DOMAIN as string) || SETTING_DEFAULTS.main_global_domain || "";
}

/** Resolve the exact DNS targets shown and checked during domain setup. */
export async function getMailDnsTargets(db: D1Database, env: any): Promise<{ inboundMxHost: string; outboundSpfInclude: string }> {
  const sesRegion = await getEnvWithOverride(db, env, "ses_region") || "us-east-1";
  return {
    inboundMxHost: await getEnvWithOverride(db, env, "inbound_mx_host") || `inbound-smtp.${sesRegion}.amazonaws.com`,
    outboundSpfInclude: await getEnvWithOverride(db, env, "outbound_spf_include") || "amazonses.com",
  };
}

export function mxRecordMatches(data: string, expectedHost: string): boolean {
  const [priority, host, extra] = data.trim().split(/\s+/);
  if (!priority || !host || extra || !/^\d+$/.test(priority)) return false;
  return host.replace(/\.$/, "").toLowerCase() === expectedHost;
}

export function spfRecordIncludes(data: string, expectedHost: string): boolean {
  const terms = data.replace(/"/g, "").trim().toLowerCase().split(/\s+/);
  return terms[0] === "v=spf1" && terms.includes(`include:${expectedHost}`);
}
