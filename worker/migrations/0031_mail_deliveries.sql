-- Durable SNS/SES idempotency. Rows are retained for 30 days by callers,
-- beyond SNS's retry horizon. Expired processing leases may be reclaimed.
CREATE TABLE mail_deliveries (
  external_id TEXT PRIMARY KEY,
  semantic_id TEXT,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('processing', 'completed')),
  claim_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_mail_deliveries_created ON mail_deliveries(created_at);
CREATE UNIQUE INDEX idx_mail_deliveries_semantic ON mail_deliveries(kind, semantic_id) WHERE semantic_id IS NOT NULL;

-- A transaction-local assertion row used by fenced D1 batches. Successful
-- batches delete their row; a missing/mismatched owner inserts NULL and makes
-- the entire batch roll back under D1's transactional batch semantics.
CREATE TABLE mail_delivery_fences (
  delivery_id TEXT PRIMARY KEY,
  claim_token TEXT NOT NULL
);
