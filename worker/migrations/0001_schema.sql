CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  passphrase_hash TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

-- Insert the admin user with a placeholder hash (we'll check the env var at runtime)
INSERT INTO users (id, passphrase_hash, created_at) VALUES (1, 'ADMIN_PLACEHOLDER', unixepoch());

CREATE TABLE destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  email TEXT NOT NULL,
  email_hash TEXT,
  token TEXT UNIQUE NOT NULL,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, email_hash)
);

CREATE TABLE domains (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) DEFAULT 1,
  is_global INTEGER DEFAULT 0,
  domain TEXT UNIQUE NOT NULL,
  default_destination TEXT,
  default_destination_hash TEXT,
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE aliases (
  id INTEGER PRIMARY KEY,
  domain_id INTEGER NOT NULL REFERENCES domains(id),
  user_id INTEGER REFERENCES users(id) DEFAULT 1,
  local_part TEXT NOT NULL,
  full_address TEXT UNIQUE NOT NULL,
  destination TEXT,
  destination_hash TEXT,
  label TEXT,
  active INTEGER DEFAULT 1,
  source TEXT NOT NULL,
  fwd_count INTEGER DEFAULT 0,
  blocked_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE reverse_map (
  id INTEGER PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  alias_id INTEGER NOT NULL REFERENCES aliases(id),
  external_sender TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  UNIQUE(alias_id, external_sender)
);

CREATE TABLE blocks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) DEFAULT 1,
  alias_id INTEGER REFERENCES aliases(id),
  pattern TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  alias_id INTEGER REFERENCES aliases(id),
  type TEXT NOT NULL,
  external_sender TEXT,
  subject TEXT,
  bytes INTEGER,
  detail TEXT,
  ts INTEGER NOT NULL
);

CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_alias ON events(alias_id, ts);

-- Rate limiting for authentication
CREATE TABLE rate_limits (
  ip TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO domains (id, user_id, is_global, domain, active, created_at) VALUES (1, 1, 1, 'hidemyemail.dev', 1, unixepoch());
