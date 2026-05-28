ALTER TABLE users ADD COLUMN inline_actions_enabled INTEGER DEFAULT 0;

-- Drop the old global setting; preference is now per-user.
DELETE FROM settings WHERE key = 'inline_actions_enabled';
