// Push-device registrations and per-device notification preferences.
// Tokens are opaque APNs device identifiers (hex). A token is globally unique
// (UNIQUE constraint): re-registering the same token re-points it at the
// current user and refreshes prefs/last_seen, which is exactly what we want
// when a device changes accounts.

export type PushCategory = "blocked" | "bounce" | "forward" | "reply";

const CATEGORY_COLUMN: Record<PushCategory, string> = {
  blocked: "notify_blocked",
  bounce: "notify_bounce",
  forward: "notify_forward",
  reply: "notify_reply",
};

export interface PushPrefs {
  blocked: boolean;
  bounce: boolean;
  forward: boolean;
  reply: boolean;
}

export interface PushDeviceRow {
  id: number;
  platform: string;
  token: string;
  notify_blocked: number;
  notify_bounce: number;
  notify_forward: number;
  notify_reply: number;
  created_at: number;
  last_seen_at: number | null;
}

const DEFAULT_PREFS: PushPrefs = { blocked: true, bounce: true, forward: false, reply: false };

// Register (or refresh) a device for a user. Idempotent on token: an existing
// token is reassigned to this user and its prefs/last_seen updated.
export async function upsertPushDevice(
  db: D1Database,
  userId: number,
  token: string,
  platform: string,
  prefs: Partial<PushPrefs> | undefined,
  now: number,
): Promise<void> {
  const p = { ...DEFAULT_PREFS, ...(prefs ?? {}) };
  await db.prepare(
    `INSERT INTO push_devices
       (user_id, platform, token, notify_blocked, notify_bounce, notify_forward, notify_reply, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET
       user_id = excluded.user_id,
       platform = excluded.platform,
       notify_blocked = excluded.notify_blocked,
       notify_bounce = excluded.notify_bounce,
       notify_forward = excluded.notify_forward,
       notify_reply = excluded.notify_reply,
       last_seen_at = excluded.last_seen_at`
  ).bind(
    userId, platform, token,
    p.blocked ? 1 : 0, p.bounce ? 1 : 0, p.forward ? 1 : 0, p.reply ? 1 : 0,
    now, now,
  ).run();
}

// Update only the preferences for a token the user owns. Returns true if a row
// was changed (false when the token is unknown or not theirs).
export async function updatePushPrefs(
  db: D1Database,
  userId: number,
  token: string,
  prefs: Partial<PushPrefs>,
): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [cat, col] of Object.entries(CATEGORY_COLUMN)) {
    const v = prefs[cat as PushCategory];
    if (v !== undefined) { sets.push(`${col} = ?`); binds.push(v ? 1 : 0); }
  }
  if (sets.length === 0) return false;
  binds.push(token, userId);
  const res = await db.prepare(
    `UPDATE push_devices SET ${sets.join(", ")} WHERE token = ? AND user_id = ?`
  ).bind(...binds).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function deletePushDevice(db: D1Database, userId: number, token: string): Promise<void> {
  await db.prepare("DELETE FROM push_devices WHERE token = ? AND user_id = ?").bind(token, userId).run();
}

// Hard-delete a dead token (e.g. APNs 410/Unregistered) regardless of owner.
export async function prunePushToken(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM push_devices WHERE token = ?").bind(token).run();
}

export async function listPushDevices(db: D1Database, userId: number): Promise<PushDeviceRow[]> {
  const res = await db.prepare(
    "SELECT id, platform, token, notify_blocked, notify_bounce, notify_forward, notify_reply, created_at, last_seen_at " +
    "FROM push_devices WHERE user_id = ? ORDER BY created_at DESC"
  ).bind(userId).all<PushDeviceRow>();
  return res.results ?? [];
}

// Tokens for a user that have opted in to a given category. This is the only
// query the dispatch path needs: it returns just the device tokens to push to.
export async function tokensForCategory(db: D1Database, userId: number, category: PushCategory): Promise<string[]> {
  const col = CATEGORY_COLUMN[category];
  const res = await db.prepare(
    `SELECT token FROM push_devices WHERE user_id = ? AND ${col} = 1`
  ).bind(userId).all<{ token: string }>();
  return (res.results ?? []).map((r) => r.token);
}
