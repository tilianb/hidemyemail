-- Fence an SES side effect independently of the shorter delivery-processing
-- lease. A sender crash after SES accepts but before state='accepted' remains
-- irreducibly ambiguous; takeover is therefore delayed until send_deadline.
DROP INDEX idx_mail_quota_alias_created;
DROP INDEX idx_mail_quota_expiry;
ALTER TABLE mail_quota_reservations RENAME TO mail_quota_reservations_old;
CREATE TABLE mail_quota_reservations (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('forward', 'reply')),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'sending', 'accepted')),
  alias_id INTEGER NOT NULL REFERENCES aliases(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  send_deadline INTEGER
);
INSERT INTO mail_quota_reservations (id,token,kind,state,alias_id,recipient,created_at,expires_at)
SELECT id,token,kind,state,alias_id,recipient,created_at,expires_at FROM mail_quota_reservations_old;
DROP TABLE mail_quota_reservations_old;
CREATE INDEX idx_mail_quota_alias_created ON mail_quota_reservations(alias_id, created_at);
CREATE INDEX idx_mail_quota_expiry ON mail_quota_reservations(expires_at);
