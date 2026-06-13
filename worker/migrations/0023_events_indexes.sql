-- Covering indexes for the events table. Every inbound forward runs two
-- rate-limit counts, and every reply additionally runs the first-contact
-- gate and the distinct-recipient cap — all of which scan events. The
-- table has no retention policy (the first-contact reply gate depends on
-- old 'forward' rows), so it only grows.
CREATE INDEX IF NOT EXISTS idx_events_alias_type_ts ON events(alias_id, type, ts);
-- Global rate-limit counts: WHERE ts >= ? AND type IN (...)
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);
-- Destination-scoped bounce/complaint counts: WHERE detail = ? AND ts >= ?
CREATE INDEX IF NOT EXISTS idx_events_detail_ts ON events(detail, ts);
