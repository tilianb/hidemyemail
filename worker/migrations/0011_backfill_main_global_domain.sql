-- Backfill main_global_domain from an existing active, verified global domain
-- so deployments that upgraded past 0007_settings (which seeded the row blank)
-- don't silently break system mail (noreply@), subdomain creation, recovery,
-- MFA, and destination verification until an admin manually sets the value.
--
-- Idempotent: only updates when the setting is still blank AND a suitable
-- domain exists. Fresh installs (no global domain yet) are a no-op.
UPDATE settings
SET value = (
  SELECT domain FROM domains
  WHERE is_global = 1
    AND active = 1
    AND verified_at IS NOT NULL
  ORDER BY created_at ASC
  LIMIT 1
),
    updated_at = unixepoch()
WHERE key = 'main_global_domain'
  AND (value IS NULL OR value = '')
  AND EXISTS (
    SELECT 1 FROM domains
    WHERE is_global = 1
      AND active = 1
      AND verified_at IS NOT NULL
  );
