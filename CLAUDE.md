# hidemyemail.dev — Project Context

Personal **serverless email-alias service** with full two-way reply-from-alias.
Replaces a self-hosted addy.io (AnonAddy) Docker stack (decommission after cutover).

## Stack
Cloudflare Email Routing (inbound) + one Worker (`email()` + `fetch()`) + Amazon SES (outbound via `aws4fetch`) + D1 + React/Vite dashboard on Pages. Hono API. Runs on CF free tier + SES pennies (SES via HTTPS, NOT the CF `send_email` binding → no Workers Paid).

## Status
**Built + merged to `main`** (2026-05-25). All 18 plan tasks complete; worker 30 tests pass,
dashboard builds, `wrangler deploy --dry-run` validates. **Not yet deployed** — see pre-prod
checklist in `docs/DEPLOY.md §8` (live SES signing, CF throw→tempfail, SNS signature verify).

Test stack modernized vs plan: `@cloudflare/vitest-pool-workers` ^0.16, vitest ^4.1, wrangler ^4.94
(`cloudflareTest` plugin API — async must live *inside* `cloudflareTest()`, not around `defineConfig`,
or the Workers pool never activates).

- Spec: `docs/superpowers/specs/2026-05-24-hidemyemail-alias-service-design.md`
- Plan (18 TDD tasks, full code): `docs/superpowers/plans/2026-05-24-hidemyemail-alias-service.md`
- Resume state: `…-alias-service.md.tasks.json` (all complete)

## Locked design decisions
- **Personal, single owner.** Auth = password (PBKDF2) + signed session cookie (HMAC). No users table.
- **Multi-domain** (N CF zones, catch-all each → one Worker). **Per-alias destination**, falling back to per-domain default.
- **Catch-all auto-create** aliases on first inbound + dashboard CRUD.
- **Full two-way reply-from-alias** via reverse-alias `r.{token}@D` (120-bit random token in D1, stable per (alias,sender)).
- **Inbound = naive-A: SES re-inject for ALL mail** (rewrite `From` → `"Name via alias" <r.token@D>`, strip DKIM, set Reply-To). Risk accepted: catch-all spam re-sent through SES counts against SES reputation. Guard = sender blocks + rate limits run **before** SES. Future fallback if reputation suffers: hybrid routing (SES only for clean mail to active aliases).
- Features: sender block/rules, stats/activity log, rate limits. **No PGP.**
- Fresh start, no migration.

## Critical gotchas (cost real time if forgotten)
1. **`forward()` allows only `X-*` headers** → cannot inject `Reply-To`. This is *why* inbound must go through SES re-inject (to control `From`/`Reply-To`). DMARC alignment then forces `From` = your domain.
2. **SES SigV4 service name must be overridden to `"ses"`** in `aws4fetch`. Host is `email.{region}.amazonaws.com`, so auto-parse picks `"email"` → signature fails. Always `new AwsClient({..., service: "ses"})`.
3. **MIME surgery on bytes, not strings** — attachments are binary. Split at first `CRLFCRLF`, edit only the ASCII header block, keep body bytes verbatim, then base64. Never `TextDecode` the whole message.
4. **Security:** reverse-alias send requires envelope `from` ∈ owner destinations (every `domains.default_destination` + non-NULL `aliases.destination`). Random token alone is not enough; this check stops relay even if a token leaks. Reply flow must strip `From/Sender/Reply-To/Return-Path/Message-ID/DKIM` to avoid leaking the real inbox.
5. **Repo security hook flags the bare `exec`-with-paren pattern** (it scans for command-injection risk). It false-positives on D1's batch-SQL method (the one that runs a multi-statement string). Avoid that method in code/docs; tests use a `resetDb()` helper built from `prepare().run()` per table.
6. **SES v2 endpoint:** `POST https://email.{region}.amazonaws.com/v2/email/outbound-emails`, body `{FromEmailAddress, Destination:{ToAddresses}, Content:{Raw:{Data:<base64>}}}`.
7. **Transient SES error → throw in `email()`** so CF tempfails and the sender's MTA retries; permanent error → log + drop. (Verify CF's throw→retry behavior in testing — open item.)

## Open items to verify before prod (spec §10)
CF throw→tempfail retry behavior · 25 MB inbound vs base64-inflated SES 40 MB ceiling · SES sending quota vs catch-all volume · multi-zone catch-all all reach one Worker · SNS signature verification (only TopicArn gate implemented so far).

## Env / ops
- Domain `hidemyemail.dev` (app at `app.hidemyemail.dev`). SES production account already approved.
- Commits must be **signed** via 1Password SSH agent. When the agent is already unlocked, signing works directly from a non-interactive tool shell — no GUI prompt (verified 2026-05-25). Only when the agent is locked does it fall back to the desktop GUI prompt; in that case run signing in an interactive shell (`!`-prefixed or your terminal). Always pass the agent socket:
  `SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" git commit -S`
- See `docs/DEPLOY.md` (created in Task 17) for D1 create, secrets, SES/SNS, DNS, Pages.

## Dev commands
- `cd worker && npm install && npm test` — worker test suite (Vitest + `@cloudflare/vitest-pool-workers`)
- `cd worker && npx wrangler dev` — local worker
- `cd dashboard && npm install && npm run dev` — dashboard against local worker
