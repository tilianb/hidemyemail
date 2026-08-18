-- Hashed, generation-bound administrative recovery state.
ALTER TABLE users ADD COLUMN recovery_token_hash TEXT;
ALTER TABLE users ADD COLUMN recovery_code_hash TEXT;
ALTER TABLE users ADD COLUMN recovery_code_expires_at INTEGER;
ALTER TABLE users ADD COLUMN recovery_code_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN recovery_code_sent_at INTEGER;
ALTER TABLE users ADD COLUMN recovery_code_sends INTEGER NOT NULL DEFAULT 0;

-- A TOTP time step is a one-time credential. NULL means no code has been used.
ALTER TABLE mfa ADD COLUMN totp_last_used_counter INTEGER;

-- Session tokens remain stateless except for explicit revocations. Only token
-- digests are retained, so a database read cannot recover a bearer credential.
CREATE TABLE revoked_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER NOT NULL
);
CREATE INDEX idx_revoked_sessions_expiry ON revoked_sessions(expires_at);

-- Old administrative recovery credentials and 40-bit MFA backup codes are not
-- compatible with the hardened formats and must not survive this migration.
UPDATE users SET recovery_token = NULL, recovery_expires_at = NULL,
  recovery_mfa_code = NULL, recovery_token_hash = NULL,
  recovery_code_hash = NULL, recovery_code_expires_at = NULL,
  recovery_code_attempts = 0, recovery_code_sent_at = NULL,
  recovery_code_sends = 0;
UPDATE mfa SET totp_backup_codes = NULL;
