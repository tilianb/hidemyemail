ALTER TABLE domains ADD COLUMN allow_subdomain_aliases INTEGER DEFAULT 0;

-- Enable by default for the current primary domain
UPDATE domains
SET allow_subdomain_aliases = 1
WHERE is_global = 1
  AND domain = (SELECT value FROM settings WHERE key = 'main_global_domain' AND value != '');
