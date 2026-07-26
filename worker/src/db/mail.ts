export type DeliveryClaim = { status: "claimed"; token: string } | { status: "completed" | "busy" };

const LEASE_MS = 5 * 60_000;
const SEND_DEADLINE_MS = 5 * 60_000;

export async function claimDelivery(db: D1Database, externalId: string, kind: string, now: number, semanticId?: string): Promise<DeliveryClaim> {
  const token = crypto.randomUUID();
  const leaseUntil = now + LEASE_MS;
  await db.batch([
    db.prepare("DELETE FROM mail_deliveries WHERE external_id IN (SELECT external_id FROM mail_deliveries WHERE (state='processing' AND lease_until<=?) OR (state='completed' AND completed_at<?) LIMIT 100)").bind(now - 24 * 3600_000, now - 30 * 86400_000),
    db.prepare("DELETE FROM mail_quota_reservations WHERE id IN (SELECT id FROM mail_quota_reservations WHERE (state='accepted' AND created_at<=?) OR (state!='accepted' AND expires_at<=?) LIMIT 100)").bind(now - 24 * 3600_000, now - 24 * 3600_000),
  ]);
  const inserted = await db.prepare(
    "INSERT OR IGNORE INTO mail_deliveries (external_id,semantic_id,kind,state,claim_token,lease_until,created_at) VALUES (?,?,?,'processing',?,?,?)"
  ).bind(externalId, semanticId ?? null, kind, token, leaseUntil, now).run();
  if ((inserted.meta.changes ?? 0) > 0) return { status: "claimed", token };

  const reclaimed = await db.prepare(
    "UPDATE mail_deliveries SET external_id=?, semantic_id=?, state='processing', claim_token=?, lease_until=?, created_at=?, completed_at=NULL " +
    "WHERE (external_id=? OR (kind=? AND semantic_id=?)) AND state='processing' AND lease_until<=? " +
    "AND NOT EXISTS (SELECT 1 FROM mail_quota_reservations WHERE id=mail_deliveries.external_id AND state='sending' AND send_deadline>?)"
  ).bind(externalId, semanticId ?? null, token, leaseUntil, now, externalId, kind, semanticId ?? null, now, now).run();
  if ((reclaimed.meta.changes ?? 0) > 0) return { status: "claimed", token };
  const row = await db.prepare("SELECT state FROM mail_deliveries WHERE external_id=? OR (kind=? AND semantic_id=?) LIMIT 1")
    .bind(externalId, kind, semanticId ?? null).first<{ state: string }>();
  return { status: row?.state === "completed" ? "completed" : "busy" };
}

export async function completeDelivery(db: D1Database, externalId: string, token: string, now: number): Promise<boolean> {
  const result = await db.prepare("UPDATE mail_deliveries SET state='completed', completed_at=?, lease_until=0 WHERE external_id=? AND claim_token=? AND state='processing'")
    .bind(now, externalId, token).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function commitDeliveryBatch(
  db: D1Database,
  externalId: string,
  token: string,
  now: number,
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  const owned = await db.prepare(
    "SELECT 1 ok FROM mail_deliveries WHERE external_id=? AND claim_token=? AND state='processing'"
  ).bind(externalId, token).first<{ ok: number }>();
  if (!owned) return [];

  try {
    const results = await db.batch([
      ...statements,
      db.prepare("UPDATE mail_deliveries SET state='completed', completed_at=?, lease_until=0 WHERE external_id=? AND claim_token=? AND state='processing'")
        .bind(now, externalId, token),
      db.prepare(
        "INSERT INTO mail_delivery_fences (delivery_id,claim_token) VALUES (?,(SELECT claim_token FROM mail_deliveries WHERE external_id=? AND claim_token=? AND state='completed'))"
      ).bind(externalId, externalId, token),
      db.prepare("DELETE FROM mail_delivery_fences WHERE delivery_id=? AND claim_token=?").bind(externalId, token),
    ]);
    const completion = results[statements.length];
    return (completion?.meta.changes ?? 0) === 1 ? results : [];
  } catch (error) {
    if (String(error).includes("mail_delivery_fences.claim_token")) return [];
    const stillOwned = await db.prepare(
      "SELECT 1 ok FROM mail_deliveries WHERE external_id=? AND claim_token=? AND state='processing'"
    ).bind(externalId, token).first<{ ok: number }>();
    if (!stillOwned) return [];
    throw error;
  }
}

export async function releaseDelivery(db: D1Database, externalId: string, token: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM mail_deliveries WHERE external_id=? AND claim_token=? AND state='processing'").bind(externalId, token).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function renewDelivery(db: D1Database, externalId: string, token: string, now: number): Promise<boolean> {
  const result = await db.prepare(
    "UPDATE mail_deliveries SET lease_until=? WHERE external_id=? AND claim_token=? AND state='processing'"
  ).bind(now + LEASE_MS, externalId, token).run();
  return (result.meta.changes ?? 0) > 0;
}

export type MailQuotaClaim = "reserved" | "sending" | "accepted" | "cap";

export async function countHourlyMailQuotaReservations(
  db: D1Database,
  aliasId: number,
  hourStart: number,
  now: number,
): Promise<{ global: number; aliasReplies: number }> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS global_n, SUM(CASE WHEN alias_id=? AND kind='reply' THEN 1 ELSE 0 END) AS alias_n " +
    "FROM mail_quota_reservations WHERE (state='accepted' AND created_at>=?) OR (state!='accepted' AND expires_at>?)"
  ).bind(aliasId, hourStart, now).first<{ global_n: number; alias_n: number | null }>();
  return { global: row?.global_n ?? 0, aliasReplies: row?.alias_n ?? 0 };
}

export async function reserveMailQuota(db: D1Database, input: {
  id: string; token: string; kind: "forward" | "reply"; aliasId: number; recipient: string; now: number;
  aliasCap: number; globalCap: number; distinctCap: number; deliveryToken?: string;
}): Promise<MailQuotaClaim> {
  const existing = await db.prepare(
    "SELECT state,send_deadline FROM mail_quota_reservations WHERE id=? AND kind=? AND alias_id=? AND recipient=LOWER(?)"
  ).bind(input.id, input.kind, input.aliasId, input.recipient).first<{ state: "reserved" | "sending" | "accepted"; send_deadline: number | null }>();
  if (existing && input.deliveryToken) {
    if (existing.state === "sending" && (existing.send_deadline ?? 0) > input.now) return "sending";
    const resumed = await db.prepare(
      "UPDATE mail_quota_reservations SET token=?, expires_at=?, state=CASE WHEN state='sending' THEN 'reserved' ELSE state END, send_deadline=NULL " +
      "WHERE id=? AND (state!='sending' OR send_deadline<=?) AND EXISTS (SELECT 1 FROM mail_deliveries WHERE external_id=? AND claim_token=? AND state='processing')"
    ).bind(input.token, input.now + LEASE_MS, input.id, input.now, input.id, input.deliveryToken).run();
    if ((resumed.meta.changes ?? 0) > 0) return existing.state === "sending" ? "reserved" : existing.state;
    return "cap";
  }
  const hour = input.now - 3600_000;
  const day = input.now - 86400_000;
  const result = await db.prepare(
    "INSERT INTO mail_quota_reservations (id,token,kind,state,alias_id,recipient,created_at,expires_at) " +
    "SELECT ?,?,?,'reserved',?,?,?,? WHERE " +
    "(? < 0 OR (SELECT COUNT(*) FROM events WHERE alias_id=? AND type IN (CASE WHEN ?='reply' THEN 'reply' ELSE 'forward' END, CASE WHEN ?='reply' THEN 'reply' ELSE 'reply' END) AND ts>=?) + (SELECT COUNT(*) FROM mail_quota_reservations WHERE alias_id=? AND ((state='accepted' AND created_at>=?) OR (state!='accepted' AND expires_at>?)) AND (?='forward' OR kind='reply')) < ?) AND " +
    "(? < 0 OR (SELECT COUNT(*) FROM events WHERE type IN ('forward','reply') AND ts>=?) + (SELECT COUNT(*) FROM mail_quota_reservations WHERE (state='accepted' AND created_at>=?) OR (state!='accepted' AND expires_at>?)) < ?) AND " +
    "(? < 0 OR ?='forward' OR EXISTS(SELECT 1 FROM events WHERE alias_id=? AND type='reply' AND LOWER(external_sender)=? AND ts>=?) OR EXISTS(SELECT 1 FROM mail_quota_reservations WHERE alias_id=? AND recipient=? AND kind='reply' AND ((state='accepted' AND created_at>=?) OR (state!='accepted' AND expires_at>?))) OR ((SELECT COUNT(DISTINCT LOWER(external_sender)) FROM events WHERE alias_id=? AND type='reply' AND external_sender IS NOT NULL AND ts>=?) + (SELECT COUNT(DISTINCT recipient) FROM mail_quota_reservations r WHERE alias_id=? AND kind='reply' AND ((state='accepted' AND created_at>=?) OR (state!='accepted' AND expires_at>?)) AND NOT EXISTS(SELECT 1 FROM events e WHERE e.alias_id=? AND e.type='reply' AND LOWER(e.external_sender)=r.recipient AND e.ts>=?))) < ?) " +
    "ON CONFLICT(id) DO UPDATE SET token=excluded.token, kind=excluded.kind, alias_id=excluded.alias_id, recipient=excluded.recipient, created_at=excluded.created_at, expires_at=excluded.expires_at WHERE mail_quota_reservations.state!='accepted' AND mail_quota_reservations.expires_at<=?"
  ).bind(input.id, input.token, input.kind, input.aliasId, input.recipient.toLowerCase(), input.now, input.now + LEASE_MS,
    input.aliasCap, input.aliasId, input.kind, input.kind, hour, input.aliasId, hour, input.now, input.kind, input.aliasCap,
    input.globalCap, hour, hour, input.now, input.globalCap,
    input.distinctCap, input.kind, input.aliasId, input.recipient.toLowerCase(), day, input.aliasId, input.recipient.toLowerCase(), day, input.now,
    input.aliasId, day, input.aliasId, day, input.now, input.aliasId, day, input.distinctCap,
    input.now).run();
  return (result.meta.changes ?? 0) > 0 ? "reserved" : "cap";
}

export async function startMailSend(db: D1Database, id: string, token: string, now: number): Promise<boolean> {
  const result = await db.prepare(
    "UPDATE mail_quota_reservations SET state='sending',send_deadline=?,expires_at=? WHERE id=? AND token=? AND state='reserved'"
  ).bind(now + SEND_DEADLINE_MS, now + SEND_DEADLINE_MS, id, token).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markMailQuotaAccepted(db: D1Database, id: string, token: string): Promise<boolean> {
  const result = await db.prepare("UPDATE mail_quota_reservations SET state='accepted',send_deadline=NULL WHERE id=? AND token=? AND state='sending'")
    .bind(id, token).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function releaseMailQuota(db: D1Database, id: string, token: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM mail_quota_reservations WHERE id=? AND token=?").bind(id, token).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function finishMailBookkeeping(db: D1Database, input: {
  id: string; token: string; aliasId: number; kind: "forward" | "reply"; sender: string;
  subject?: string; bytes?: number; now: number; deliveryToken?: string;
}): Promise<boolean> {
  const reservation = "EXISTS(SELECT 1 FROM mail_quota_reservations WHERE id=? AND token=? AND state='accepted')";
  const statements = [
    db.prepare(
      `INSERT INTO events (alias_id,type,external_sender,subject,bytes,detail,ts) SELECT ?,?,?,?,?,NULL,? WHERE ${reservation}`
    ).bind(input.aliasId, input.kind, input.sender, input.subject ?? null, input.bytes ?? null, input.now, input.id, input.token),
  ];
  if (input.kind === "forward") {
    statements.push(db.prepare(
      `INSERT INTO contacts (alias_id,external_sender,first_seen_at,last_seen_at) SELECT ?,LOWER(?),?,? WHERE ${reservation} ` +
      "ON CONFLICT(alias_id,external_sender) DO UPDATE SET last_seen_at=excluded.last_seen_at"
    ).bind(input.aliasId, input.sender, input.now, input.now, input.id, input.token));
  }
  statements.push(
    db.prepare(`UPDATE aliases SET ${input.kind === "forward" ? "fwd_count" : "reply_count"}=${input.kind === "forward" ? "fwd_count" : "reply_count"}+1,last_seen_at=? WHERE id=? AND ${reservation}`)
      .bind(input.now, input.aliasId, input.id, input.token),
    db.prepare("DELETE FROM mail_quota_reservations WHERE id=? AND token=? AND state='accepted'").bind(input.id, input.token),
  );
  const results = input.deliveryToken
    ? await commitDeliveryBatch(db, input.id, input.deliveryToken, input.now, statements)
    : await db.batch(statements);
  return (results[0]?.meta.changes ?? 0) > 0;
}
