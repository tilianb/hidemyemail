import { SETTING_DEFAULTS } from "../config";

/**
 * Read a single setting from the D1 settings table with fallback to defaults.
 * Designed to be lightweight — no caching (D1 is fast enough for per-request reads).
 */
export async function getSetting(db: D1Database, key: string): Promise<string> {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? SETTING_DEFAULTS[key] ?? "";
  } catch {
    // If table doesn't exist yet (pre-migration), fall back gracefully
    return SETTING_DEFAULTS[key] ?? "";
  }
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

/** Read all settings as a key-value map. */
export async function getAllSettings(db: D1Database): Promise<Record<string, { value: string; updated_at: number }>> {
  const result: Record<string, { value: string; updated_at: number }> = {};

  // Start with defaults
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    result[key] = { value, updated_at: 0 };
  }

  try {
    const rows = await db.prepare("SELECT key, value, updated_at FROM settings").all<{ key: string; value: string; updated_at: number }>();
    for (const row of rows.results ?? []) {
      result[row.key] = { value: row.value, updated_at: row.updated_at };
    }
  } catch {
    // Pre-migration: just return defaults
  }

  return result;
}
