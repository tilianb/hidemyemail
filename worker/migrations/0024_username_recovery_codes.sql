-- Self-service username (public display + recovery handle) and self-service
-- recovery codes. Username is NOT a secret and NOT a login identifier — login
-- stays passphrase/passkey. Recovery codes are the secret proof; username only
-- identifies which account to recover.
ALTER TABLE users ADD COLUMN username TEXT;

-- Case-insensitive uniqueness. SQLite treats NULLs as distinct, so the many
-- users without a username never collide. lower() expression index lets the
-- recovery lookup match regardless of the case the user typed.
CREATE UNIQUE INDEX idx_users_username_lower ON users (lower(username));

-- JSON array of SHA-256 hashes of one-time recovery codes (same hashing as MFA
-- backup codes). Plaintext is shown once at generation and never stored.
ALTER TABLE users ADD COLUMN recovery_codes TEXT;
