# AGENTS.md

Guidance for AI coding agents (and new contributors) working in this repo.

> **Keep this file current.** If your change adds/renames a top-level
> directory, npm script, migration convention, CI workflow, or security
> invariant listed here, update this file in the same PR. Treat a stale
> AGENTS.md as a bug.

## What this project is

Self-hosted, serverless email alias service ("hide my email" style):
Cloudflare Worker (Hono) + D1 (SQLite) + React dashboard, with AWS SES/S3/SNS
for receiving and sending mail. Single Worker serves both the API and the
built dashboard assets.

## Repo layout

| Path | What lives there |
|---|---|
| `worker/` | Cloudflare Worker — all backend logic |
| `worker/src/api/` | Hono app (`app.ts` wires routes + session guard) and `routes/` |
| `worker/src/email/` | Mail pipeline: `router.ts` dispatch → `inbound.ts` (forward), `reply.ts` (reverse-alias replies), `action.ts` (signed mailto actions) |
| `worker/src/db/` | D1 query helpers, re-exported via `db/queries.ts` (`import * as q`) |
| `worker/src/lib/` | Crypto, auth primitives, settings, MIME, SES SigV4 client |
| `worker/migrations/` | D1 migrations, numbered `00NN_name.sql`, append-only |
| `worker/test/` | Vitest + `@cloudflare/vitest-pool-workers` (`cloudflare:test` env) |
| `dashboard/` | React 19 + Vite SPA (TypeScript), no UI framework — hand-rolled CSS in `src/index.css` |
| `docker/` | Self-host runtime: Node server wrapping the Worker via Miniflare |
| `docs/` | Setup/deploy/config docs + `ROADMAP.md` (tracked backlog) |
| `ios/` | Native SwiftUI app (XcodeGen `project.yml`) — only on its feature branch until merged |

## Build & test

```bash
# Worker — tests run against a real workerd runtime
cd worker && npm ci && npm test && npx tsc --noEmit

# Dashboard — tsc is part of the build
cd dashboard && npm ci && npm run build
```

Always run both before committing; CI (`.github/workflows`) runs them too.
There is no lint step beyond tsc. Local dev: `npx wrangler dev` in `worker/`
plus `npm run dev` in `dashboard/` (Vite proxies to the Worker).

## Conventions

- **Branches:** work lands on `dev` via feature branches; `main` is release.
  PRs to `dev` unless told otherwise. Never merge a PR before CI is green.
- **Commits:** conventional commits (`feat(worker): …`, `fix(email): …`).
  Bodies explain *why*. No AI co-author trailers.
- **Migrations:** new numbered file in `worker/migrations/`; never edit an
  applied one. Keep columns nullable / defaulted so existing rows keep their
  behavior. Code does NOT tolerate missing tables (no try/catch migration
  fallbacks — that pattern was deliberately removed).
- **Settings:** runtime-tunable knobs go in `SETTING_DEFAULTS`
  (`worker/src/config.ts`), get validation in
  `worker/src/api/routes/admin/settings.ts`, a UI row in
  `dashboard/src/pages/Admin.tsx`, and a row in `docs/CONFIGURATION.md`.
  All four or it's not done.
- **Tests:** every behavior change gets a test in `worker/test/`. Pattern:
  build the Hono app with `createApp()`, call `app.request(...)` with a
  signed cookie, or call `handleInbound`/`handleReply` directly with a
  `__sesSend` sentinel env to capture outbound mail.

## Security invariants (do not weaken)

- Destination emails are AES-encrypted at rest (`lib/crypto.ts`) and looked
  up by HMAC hash (`email_hash`) — never store or log plaintext addresses.
- Sensitive account operations (MFA changes, data export, account deletion)
  require the `__Host-fresh-auth` cookie via `hasFreshAuth`
  (`worker/src/api/auth-helpers.ts`), not just a session.
- Reverse-alias replies are gated by SES SPF/DMARC verdicts AND a
  first-contact check (`hasPriorInbound`) — reverse addresses are guessable.
  The events table is the source of truth for that gate; do not add events
  retention without replacing it.
- Inbound forwards respect SES spam/virus verdicts (`spam_verdict_action`,
  `virus_verdict_action`). Forwarded mail is DKIM-signed by the alias
  domain, so forwarding junk burns the operator's sender reputation.
- SNS webhooks verify signatures and TopicArn before acting.
- State-changing public endpoints must be POST (e.g. unsubscribe: GET only
  renders a confirm form — mail scanners prefetch GET links).
- Unauthenticated auth-adjacent endpoints (`/login`, `/register`,
  `/restore`, recovery) are IP-rate-limited via the `rate_limits` table.

## Gotchas

- `app.ts` route order matters: public routers are mounted BEFORE the
  session-guard middleware; the guard's exempt-path list is belt-and-braces.
  New public endpoints need both (mount before guard + add to the list).
- Two forwarding paths in `inbound.ts`: raw-MIME header rewrite (default)
  and full mimetext rebuild (inline-actions / over-quota). Header changes
  must be applied to BOTH.
- D1 in tests is real SQLite — migrations from `worker/migrations/` are
  applied by the vitest pool config automatically.
- `worker/wrangler.jsonc` sets `keep_vars: true`; deploys must not clobber
  dashboard-managed vars (`npm run deploy` already passes `--keep-vars`).
- Docker self-host runs the same Worker under Miniflare
  (`docker/server.mjs`) — Worker features used must exist there too (e.g.
  the cron `scheduled()` handler is invoked by a `setInterval` shim).
