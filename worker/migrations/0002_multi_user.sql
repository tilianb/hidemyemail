CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  passphrase_hash TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

-- Insert the admin user with a placeholder hash (we'll check the env var at runtime)
INSERT INTO users (id, passphrase_hash, created_at) VALUES (1, 'ADMIN_PLACEHOLDER', unixepoch());

-- Associate aliases with the admin user by default
ALTER TABLE aliases ADD COLUMN user_id INTEGER REFERENCES users(id) DEFAULT 1;

-- Rate limiting for authentication
CREATE TABLE rate_limits (
  ip TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);
