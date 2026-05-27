import { SETTING_DEFAULTS } from "../config";
import { decryptDestination } from "./crypto";

/**
 * Read a single setting from the D1 settings table with fallback to defaults.
 * Designed to be lightweight — no caching (D1 is fast enough for per-request reads).
 */
export async function getSetting(db: D1Database, key: string, env?: any): Promise<string> {
  let val = "";
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
    val = row?.value ?? SETTING_DEFAULTS[key] ?? "";
  } catch {
    // If table doesn't exist yet (pre-migration), fall back gracefully
    val = SETTING_DEFAULTS[key] ?? "";
  }
  
  if (val && env?.DESTINATION_ENCRYPTION_KEY && key === "ses_secret_access_key") {
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
  // Try DB first
  const dbVal = await getSetting(db, key.toLowerCase(), env);
  if (dbVal) return dbVal;
  // Fall back to environment variable
  return (env[key.toUpperCase()] as string) || "";
}

/** Read all settings as a key-value map. */
export async function getAllSettings(db: D1Database, env?: any): Promise<Record<string, { value: string; updated_at: number }>> {
  const result: Record<string, { value: string; updated_at: number }> = {};

  // Start with defaults
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    result[key] = { value, updated_at: 0 };
  }

  try {
    const rows = await db.prepare("SELECT key, value, updated_at FROM settings").all<{ key: string; value: string; updated_at: number }>();
    for (const row of rows.results ?? []) {
      let val = row.value;
      if (val && env?.DESTINATION_ENCRYPTION_KEY && row.key === "ses_secret_access_key") {
        val = await decryptDestination(val, env.DESTINATION_ENCRYPTION_KEY);
      }
      result[row.key] = { value: val, updated_at: row.updated_at };
    }
  } catch {
    // Pre-migration: just return defaults
  }

  return result;
}

/** 
 * Resolve the main global domain, preferring DB override, then falling back to environment variable.
 */
export async function getMainGlobalDomain(db: D1Database, env: any): Promise<string> {
  const dbVal = await getSetting(db, "main_global_domain", env);
  if (dbVal) return dbVal;
  return (env.MAIN_GLOBAL_DOMAIN as string) || SETTING_DEFAULTS.main_global_domain;
}
