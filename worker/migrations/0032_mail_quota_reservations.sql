-- Short-lived reservations close the read-count/send race in reply quotas.
CREATE TABLE mail_quota_reservations (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('forward', 'reply')),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'accepted')),
  alias_id INTEGER NOT NULL REFERENCES aliases(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_mail_quota_alias_created ON mail_quota_reservations(alias_id, created_at);
CREATE INDEX idx_mail_quota_expiry ON mail_quota_reservations(expires_at);
