ALTER TABLE aliases ADD COLUMN muted_until INTEGER DEFAULT NULL;

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('inline_actions_enabled', 'false', 0);
