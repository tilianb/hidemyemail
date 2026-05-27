-- Admin-selectable display format for forwarded email From headers.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('forwarded_from_format', 'name_address_parens', 0);
