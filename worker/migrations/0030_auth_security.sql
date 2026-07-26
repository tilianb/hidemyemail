ALTER TABLE users ADD COLUMN passphrase_verifier TEXT;

CREATE TABLE consumed_auth_artifacts (
  artifact_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_consumed_auth_artifacts_expiry ON consumed_auth_artifacts(expires_at);
