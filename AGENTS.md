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
| `ios/` | Native SwiftUI app (XcodeGen `project.yml`) |
| `android/` | Native Android app — Kotlin + Jetpack Compose (Gradle, package `dev.hidemyemail.app`) |
| `website/` | Astro Starlight docs site, generated from `docs/` + README/CHANGELOG/ROADMAP by `scripts/sync-docs.mjs`; published to GitHub Pages |

## Mobile (iOS + Android)

- The SwiftUI app (`ios/`) is the product; the owner wants its look kept.
  Build: `cd ios && xcodegen generate` then xcodebuild. Team ID is in
  `project.yml`. Passkey login requires a paid Apple team (Associated
  Domains); on a personal team, strip `CODE_SIGN_ENTITLEMENTS` locally to
  sideload — never commit that strip. CI: `.github/workflows/ios.yml`
  (build + tests on a simulator).
- The Android app (`android/`) is a hand-written Kotlin/Jetpack Compose
  mirror of the iOS screens and theme tokens (the 2026-06-10 Skip
  transpilation spike was abandoned in favor of this native port). Both apps
  talk to the Worker in bearer-token mode (`X-Auth-Mode: token`); keep
  `ApiClient.kt` and `APIClient.swift` in feature parity. Build:
  `cd android && ./gradlew :app:assembleDebug` (needs `JAVA_HOME` +
  `ANDROID_HOME`). CI: `.github/workflows/android.yml` (build + lint).
- **Toolchain quirk:** Homebrew cannot install anything on this Mac (macOS 27
  beta → `unknown or unsupported macOS version`). The Android toolchain is
  hand-installed — source `~/dev-tools/env.sh` for JDK 21, Gradle, Android
  SDK 35, and PATH.

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

First-deploy secret bootstrap: `cd worker && npm run setup` (interactive;
`-- --print` emits KEY=VALUE lines for the Docker `.env`). It shares its
PBKDF2 derivation with `scripts/hash-password.mjs` via `scripts/pbkdf2.mjs`.

Docs site: `cd website && npm install && npm run dev` (build: `npm run build`).
`npm run sync` (auto-run before dev/build) regenerates `src/content/docs/` from
the repo markdown — never hand-edit that directory; edit `docs/`/README instead.
CI: `.github/workflows/docs.yml` builds and deploys to GitHub Pages on push to
`main`.

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
- API keys for the addy.io-compatible `/api/v1` surface are shown once and
  stored as SHA-256 only (`lib/api-keys.ts`); creating or revoking one is
  fresh-auth gated like passkey enrolment. `/api/v1` authenticates
  exclusively by Bearer key — it must never read session cookies, and its
  CORS policy (any origin, credentials OFF) depends on that.
- Sensitive account operations (MFA changes, data export, account deletion)
  require fresh auth via `hasFreshAuth` (`worker/src/api/auth-helpers.ts`),
  not just a session: the `__Host-fresh-auth` cookie for web clients, or the
  `X-Fresh-Auth` header (issued only in token-mode login responses) for
  native bearer clients.
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
  `/api/v1` follows the same pattern with its own Bearer-key middleware and
  its own CORS policy (see the dispatch at the top of `createApp`).
- Alias-creation rules (quota, local-part validation/generation, default-
  destination resolution) are shared between the dashboard route
  (`routes/aliases.ts`) and the addy.io API (`routes/v1.ts`) via
  `db/aliases.ts` + `lib/alias-format.ts`. Change the rules there so the two
  surfaces cannot drift.
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
