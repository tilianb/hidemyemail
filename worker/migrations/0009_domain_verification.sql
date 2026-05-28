ALTER TABLE domains ADD COLUMN verified_at INTEGER;
ALTER TABLE domains ADD COLUMN verification_token TEXT;

-- Update existing domains to be verified to prevent breaking existing installations
UPDATE domains SET verified_at = strftime('%s', 'now');
