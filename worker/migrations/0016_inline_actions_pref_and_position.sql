-- Tri-state per-user override + position; NULL means inherit global default.
ALTER TABLE users ADD COLUMN inline_actions_pref TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN inline_actions_position TEXT DEFAULT NULL;

-- Carry forward any users who already opted in under the old boolean column.
UPDATE users SET inline_actions_pref = 'on' WHERE inline_actions_enabled = 1;

-- Global defaults that apply when a user hasn't expressed a preference.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('inline_actions_default_enabled', 'false', 0),
  ('inline_actions_default_position', 'footer', 0);
