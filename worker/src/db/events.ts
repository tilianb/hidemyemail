import type { EventType } from "../types";

export async function insertEvent(
  db: D1Database,
  e: { alias_id?: number | null; type: EventType; external_sender?: string; subject?: string; bytes?: number; detail?: string; ts: number }
): Promise<void> {
  await db.prepare(
    "INSERT INTO events (alias_id, type, external_sender, subject, bytes, detail, ts) VALUES (?,?,?,?,?,?,?)"
  ).bind(e.alias_id ?? null, e.type, e.external_sender ?? null, e.subject ?? null, e.bytes ?? null, e.detail ?? null, e.ts).run();
}

// First-contact gate for replies: has this alias previously forwarded inbound mail
// FROM this external sender? Reverse addresses are guessable, so a reply is only
// authorised to a correspondent the alias has actually heard from. Case-insensitive
// because envelope MAIL FROM casing is not normalised on the inbound path.
export async function hasPriorInbound(db: D1Database, aliasId: number, externalSender: string): Promise<boolean> {
  const r = await db.prepare(
    "SELECT 1 AS n FROM events WHERE alias_id = ? AND type = 'forward' AND LOWER(external_sender) = LOWER(?) LIMIT 1"
  ).bind(aliasId, externalSender).first<{ n: number }>();
  return !!r;
}

// Count events of the given type(s) since `since`, optionally scoped to one
// alias (null = global across all aliases). Single implementation backing both
// the inbound forward/reply rate limit and the reply-only cap.
export async function countEventsByTypeSince(
  db: D1Database,
  aliasId: number | null,
  since: number,
  types: EventType[]
): Promise<number> {
  const placeholders = types.map(() => "?").join(",");
  const sql = aliasId == null
    ? `SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND type IN (${placeholders})`
    : `SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND alias_id = ? AND type IN (${placeholders})`;
  const binds = aliasId == null ? [since, ...types] : [since, aliasId, ...types];
  const r = await db.prepare(sql).bind(...binds).first<{ n: number }>();
  return r?.n ?? 0;
}

// Count destination-scoped events (bounce/soft_bounce/complaint) since `since`.
// Accepts multiple types so the dashboard can sum hard + soft bounces while the
// soft-suppression trigger counts only soft bounces.
export async function countEventsForDestinationSince(
  db: D1Database,
  destinationId: number,
  eventType: EventType | EventType[],
  since: number
): Promise<number> {
  const types = Array.isArray(eventType) ? eventType : [eventType];
  const placeholders = types.map(() => "?").join(",");
  const r = await db.prepare(
    `SELECT COUNT(*) AS n FROM events WHERE detail = ? AND ts >= ? AND type IN (${placeholders})`
  ).bind(`dest:${destinationId}`, since, ...types).first<{ n: number }>();
  return r?.n ?? 0;
}

// Distinct-recipient cap: has this alias already replied to this external sender
// in the given window? Exempts already-contacted correspondents from the cap so
// back-and-forth threads are never gated. Case-insensitive (mirrors hasPriorInbound).
export async function hasRepliedTo(db: D1Database, aliasId: number, externalSender: string, since: number): Promise<boolean> {
  const r = await db.prepare(
    "SELECT 1 AS n FROM events WHERE alias_id = ? AND type = 'reply' AND LOWER(external_sender) = LOWER(?) AND ts >= ? LIMIT 1"
  ).bind(aliasId, externalSender, since).first<{ n: number }>();
  return !!r;
}

// Count how many distinct external recipients this alias has replied to since `since`.
// Used to enforce the cold-outbound cap without penalising ongoing threads.
export async function countDistinctReplyRecipientsSince(db: D1Database, aliasId: number, since: number): Promise<number> {
  const r = await db.prepare(
    "SELECT COUNT(DISTINCT LOWER(external_sender)) AS n FROM events WHERE alias_id = ? AND type = 'reply' AND ts >= ? AND external_sender IS NOT NULL"
  ).bind(aliasId, since).first<{ n: number }>();
  return r?.n ?? 0;
}
