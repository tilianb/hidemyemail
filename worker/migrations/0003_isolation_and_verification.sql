-- 1. Create destinations table
CREATE TABLE destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  email TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, email)
);

-- 2. Alter domains table
-- We have to use a workaround because SQLite doesn't allow dropping NOT NULL without recreating
-- Instead, we just add the columns and allow default_destination to technically be NULL by creating a new table
CREATE TABLE domains_new (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) DEFAULT 1,
  is_global INTEGER DEFAULT 0,
  domain TEXT UNIQUE NOT NULL,
  default_destination TEXT,
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

INSERT INTO domains_new (id, user_id, is_global, domain, default_destination, active, created_at)
SELECT id, 1, CASE WHEN domain = 'hidemyemail.dev' THEN 1 ELSE 0 END, domain, CASE WHEN domain = 'hidemyemail.dev' THEN NULL ELSE default_destination END, active, created_at
FROM domains;

DROP TABLE domains;
ALTER TABLE domains_new RENAME TO domains;
