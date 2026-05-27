-- Runtime-configurable settings (admin-editable via dashboard)
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- Seed defaults matching current hardcoded values
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('rate_limit_per_alias', '200', 0),
  ('rate_limit_global', '1000', 0),
  ('max_inbound_bytes', '26214400', 0),
  ('catch_all_auto_create', 'true', 0),
  ('registration_enabled', 'true', 0),
  ('main_global_domain', 'hidemyemail.dev', 0),
  ('cors_allowed_domains', 'https://hidemyemail.dev,http://localhost:5173', 0);
