ALTER TABLE destinations ADD COLUMN suppressed_at INTEGER;
ALTER TABLE destinations ADD COLUMN suppression_reason TEXT;
ALTER TABLE destinations ADD COLUMN suppression_class TEXT;
