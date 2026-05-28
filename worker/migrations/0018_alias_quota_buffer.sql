-- Allow admins to disable the one-alias catch-all quota buffer.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('alias_quota_buffer_enabled', 'true', 0);
