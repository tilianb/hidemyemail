-- Default alias limits settings (-1 means unlimited)
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('max_total_aliases', '10', 0),
  ('max_subdomains', '5', 0);
