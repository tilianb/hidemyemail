-- 'both' rendered the toolbar twice and competed with the email body — drop it.
UPDATE users SET inline_actions_position = 'footer' WHERE inline_actions_position = 'both';
UPDATE settings SET value = 'footer' WHERE key = 'inline_actions_default_position' AND value = 'both';
