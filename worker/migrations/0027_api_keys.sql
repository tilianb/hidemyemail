-- API keys for the addy.io-compatible /api/v1 surface (password managers,
-- browser extensions). Tokens are shown once and stored hashed (SHA-256 hex);
-- token_prefix keeps the first characters for display in the dashboard.
CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  token_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);
