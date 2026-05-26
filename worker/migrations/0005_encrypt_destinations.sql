ALTER TABLE destinations ADD COLUMN email_hash TEXT;
ALTER TABLE domains ADD COLUMN default_destination_hash TEXT;
ALTER TABLE aliases ADD COLUMN destination_hash TEXT;
