-- Rotate all signed credentials after account recovery. Existing session and
-- fresh-auth tokens map to version 0 so this is non-disruptive until recovery.
ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;

-- Codes generated before this migration contain only 40 bits of entropy.
UPDATE users SET recovery_codes = NULL WHERE recovery_codes IS NOT NULL;
