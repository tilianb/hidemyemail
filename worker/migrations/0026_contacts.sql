-- Durable first-contact record per (alias, external sender).
--
-- The reply first-contact gate previously scanned `events` for an old `forward`
-- row from the sender. That made it impossible to add `events` retention: any
-- prune would silently revoke the ability to reply to a long-standing
-- correspondent. This table is the durable store the reply gate reads instead,
-- so events can be retention-pruned without affecting reply authorisation.
--
-- external_sender is stored lower-cased (envelope MAIL FROM casing is not
-- normalised on the inbound path), matching the case-insensitive gate.
CREATE TABLE IF NOT EXISTS contacts (
  alias_id        INTEGER NOT NULL REFERENCES aliases(id),
  external_sender TEXT    NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  PRIMARY KEY (alias_id, external_sender)
);

-- Backfill from existing forward events so every current correspondent keeps
-- reply access immediately after this migration.
INSERT OR IGNORE INTO contacts (alias_id, external_sender, first_seen_at, last_seen_at)
SELECT alias_id, LOWER(external_sender), MIN(ts), MAX(ts)
  FROM events
 WHERE type = 'forward' AND external_sender IS NOT NULL
 GROUP BY alias_id, LOWER(external_sender);
