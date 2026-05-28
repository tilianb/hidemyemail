-- Align existing seeded DB rows with the current fallback default.
UPDATE settings
SET value = '20', updated_at = 0
WHERE key = 'rate_limit_per_alias' AND value = '200';
