-- Separate MFA table so admin (userId=1) can enroll
-- without requiring a corresponding users row.
CREATE TABLE IF NOT EXISTS mfa (
  user_id INTEGER PRIMARY KEY,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_backup_codes TEXT
);
