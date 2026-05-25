CREATE TABLE domains (
  id INTEGER PRIMARY KEY, domain TEXT UNIQUE NOT NULL,
  default_destination TEXT NOT NULL, active INTEGER DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE aliases (
  id INTEGER PRIMARY KEY, domain_id INTEGER NOT NULL REFERENCES domains(id),
  local_part TEXT NOT NULL, full_address TEXT UNIQUE NOT NULL,
  destination TEXT, label TEXT, active INTEGER DEFAULT 1, source TEXT NOT NULL,
  fwd_count INTEGER DEFAULT 0, blocked_count INTEGER DEFAULT 0, reply_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL, last_seen_at INTEGER
);
CREATE TABLE reverse_map (
  id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL,
  alias_id INTEGER NOT NULL REFERENCES aliases(id), external_sender TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_used_at INTEGER, UNIQUE(alias_id, external_sender)
);
CREATE TABLE blocks (
  id INTEGER PRIMARY KEY, alias_id INTEGER REFERENCES aliases(id),
  pattern TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY, alias_id INTEGER REFERENCES aliases(id),
  type TEXT NOT NULL, external_sender TEXT, subject TEXT, bytes INTEGER, detail TEXT, ts INTEGER NOT NULL
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_alias ON events(alias_id, ts);
