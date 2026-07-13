CREATE TABLE identifier_reservations (
  kind TEXT NOT NULL CHECK (kind IN ('alias', 'subdomain')),
  value TEXT NOT NULL COLLATE NOCASE,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, value)
);

INSERT OR IGNORE INTO identifier_reservations (kind, value, user_id, created_at)
SELECT 'alias', lower(full_address), user_id, created_at
FROM aliases
WHERE user_id IS NOT NULL;

INSERT OR IGNORE INTO identifier_reservations (kind, value, user_id, created_at)
SELECT 'subdomain', lower(domain), user_id, created_at
FROM domains
WHERE is_global = 0 AND user_id IS NOT NULL;

-- Keep each trigger on one physical line. Remote D1's migration parser splits
-- multiline CREATE TRIGGER statements incorrectly (workers-sdk#4998).
CREATE TRIGGER reserve_alias_identifier BEFORE INSERT ON aliases BEGIN INSERT OR IGNORE INTO identifier_reservations (kind, value, user_id, created_at) VALUES ('alias', lower(NEW.full_address), NEW.user_id, NEW.created_at); SELECT CASE WHEN (SELECT user_id FROM identifier_reservations WHERE kind = 'alias' AND value = lower(NEW.full_address)) = NEW.user_id THEN NULL ELSE RAISE(ABORT, 'identifier reserved') END; END;

CREATE TRIGGER reserve_subdomain_identifier BEFORE INSERT ON domains WHEN NEW.is_global = 0 BEGIN INSERT OR IGNORE INTO identifier_reservations (kind, value, user_id, created_at) VALUES ('subdomain', lower(NEW.domain), NEW.user_id, NEW.created_at); SELECT CASE WHEN (SELECT user_id FROM identifier_reservations WHERE kind = 'subdomain' AND value = lower(NEW.domain)) = NEW.user_id THEN NULL ELSE RAISE(ABORT, 'identifier reserved') END; END;
