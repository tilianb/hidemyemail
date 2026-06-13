-- Per-subdomain alias policies + scoped allow/deny rules.
-- All new columns are nullable / inherit by default, so existing rows keep
-- their current behavior. Resolution order is alias > subdomain > global.

-- Catch-all per subdomain: NULL = inherit the global catch_all_auto_create
-- setting; 0/1 force off/on for this domain only.
ALTER TABLE domains ADD COLUMN catch_all INTEGER DEFAULT NULL;

-- Inline-actions preference per subdomain: NULL = inherit the user/global
-- default; 'on'/'off' override it for mail received on this domain.
ALTER TABLE domains ADD COLUMN inline_actions_pref TEXT DEFAULT NULL;

-- Scoped sender rules. blocks gains:
--   domain_id  — NULL keeps a rule per-alias (alias_id set) or user-wide
--                (both NULL); set scopes the rule to every alias on a subdomain.
--   kind       — 'block' (deny, existing behavior) or 'allow' (whitelist).
ALTER TABLE blocks ADD COLUMN domain_id INTEGER DEFAULT NULL REFERENCES domains(id);
ALTER TABLE blocks ADD COLUMN kind TEXT NOT NULL DEFAULT 'block';
