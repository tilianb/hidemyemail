<p align="center">
  <img src="dashboard/public/favicon.svg" alt="HideMyEmail logo" width="96" height="96">
</p>

<p align="center">
  <a href="https://app.hidemyemail.dev">app.hidemyemail.dev</a>
</p>

# HideMyEmail

A self-hosted, serverless email-alias service for your own domains. HideMyEmail runs as a Cloudflare Worker with a React dashboard, Cloudflare D1 for state, and AWS SES/S3/SNS for email receiving and sending.

## Why HideMyEmail

Most alias services either lock you into someone else's domain (SimpleLogin,
Apple Hide My Email, Firefox Relay) or expect you to run a full mail stack on a
VPS (addy.io self-hosted, Postfix + custom scripts). HideMyEmail sits in
between: **your domain, your data, no mail server to babysit**. The whole
inbound path is event-driven serverless — SES receives the message, drops it
in S3, SNS pings a Cloudflare Worker, the Worker rewrites MIME and hands it
back to SES for delivery. Replies use a self-describing reverse address so you
can answer from your normal inbox and recipients only ever see the alias.

### Key features

- **One-click unsubscribe inside every forwarded mail.** Each forward carries
  a signed `List-Unsubscribe` / `List-Unsubscribe-Post: One-Click` header
  pointing at an `action+disable=<id>_<hmac>@yourdomain` address. Gmail,
  Apple Mail and Outlook surface this as a native "Unsubscribe" button — one
  tap disables the alias on the Worker, no dashboard visit, no login.
- **Catch-all aliases with quota grace.** First inbound mail to any
  `*@yourdomain` auto-creates the alias. When you cross the configured
  ceiling the next 10% are still delivered with an inline `[OVER QUOTA]`
  warning banner and a 1-hour grace window, then dropped with a system
  notification — no silent data loss, no surprise bounces.
- **Subdomain alias gating with live DNS health checks.** Subdomains stay
  blocked until the wildcard MX record actually resolves; per-record DNS
  status is checked on demand and persisted, so the Domains page tells you
  exactly which DNS entry is wrong before you create aliases that would
  black-hole mail.
- **DMARC-aligned reply gate.** Replies fail closed unless SES reports
  SPF=PASS on the envelope sender *or* DMARC=PASS on the header From, and
  that authenticated address belongs to a verified destination. Stops the
  guessable-reverse-address spoof class entirely.
- **Encrypted-at-rest secrets.** Destination inboxes and stored AWS
  credentials are AES-encrypted in D1 with a separate
  `DESTINATION_ENCRYPTION_KEY`, so a stolen DB dump leaks neither your
  recipients nor your SES keys.
- **Auth that doesn't suck.** Password + TOTP MFA + passkeys + recovery
  codes, plus admin controls for multi-user instances. Public registration
  is opt-in.
- **Block list, per-alias counters, MIME reinjection, custom forwarded-from
  display formats, sender notifications, rate limits per alias and
  globally** — the long tail of "I actually use this every day" features.

### Serverless infrastructure

```
AWS SES recv ──raw MIME──▶ S3 ──SNS──▶ Cloudflare Worker
                                        │
                                        ├─ D1 (aliases, users, events, settings)
                                        ├─ Worker Assets (React dashboard SPA)
                                        └─ SES SendRawEmail ──▶ verified inbox
```

No VPS, no Postfix, no cron. Cold start is a Worker isolate (sub-ms);
state lives in D1 at the edge; the React dashboard is served by the same
Worker through Wrangler Assets so `/api/*` and the SPA share a single
deploy. Self-host the *whole* stack via Docker (Miniflare runs the Worker
locally against a SQLite-backed D1) or wire it to Cloudflare Workers Builds
for Git-push deploys with automatic D1 migrations — see the
[architecture diagram below](#architecture).

## What it does

- Create aliases on your own domain, for example `shop@example.com`.
- Forward inbound mail to verified destination inboxes.
- Reply from your inbox while recipients see the alias address.
- Auto-create catch-all aliases on first inbound email.
- Block senders and disable aliases from the dashboard.
- Add one-click `List-Unsubscribe` headers so mail clients can disable aliases.
- Support multiple users, verified destinations, TOTP MFA, passkeys, and admin controls.

## Self-host in 60 seconds

Pre-built multi-arch images live on GHCR. You still need AWS SES for the mail
pipeline (no mail server included) — everything else runs locally.

```bash
git clone https://github.com/tilianb/hidemyemail.git
cd hidemyemail/docker
cp .env.example .env

# Generate the four secrets and paste them into .env
echo "SESSION_SECRET=$(openssl rand -hex 32)"
echo "DESTINATION_ENCRYPTION_KEY=$(openssl rand -hex 32)"
node ../worker/scripts/hash-password.mjs '<choose-a-password>'  # prints SALT + HASH

# Add your AWS SES creds (SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, etc.)
$EDITOR .env

docker compose pull
docker compose up -d
```

Open <http://localhost:8787>. Put Caddy/nginx/Cloudflare Tunnel in front for
TLS. See [`docker/README.md`](docker/README.md) for AWS setup, upgrades,
volumes, and troubleshooting.

## Documentation

- [Getting started](docs/GETTING_STARTED.md)
- [AWS SES setup](docs/AWS_SES_SETUP.md)
- [Configuration](docs/CONFIGURATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Security notes](docs/SECURITY.md)
- [Deployment guide](docs/DEPLOY.md)

## Architecture

```diagram
╭──────────────╮   raw MIME   ╭────╮   SNS   ╭──────────────────╮
│ AWS SES recv │─────────────▶│ S3 │────────▶│ Cloudflare Worker │
╰──────┬───────╯              ╰────╯         ╰────────┬─────────╯
       │                                             │
       │                                  D1 state + dashboard API
       │                                             │
       │       SES SendRawEmail                      ▼
       ╰────────────────────────────────────▶ verified inbox
```

The dashboard is served by the same Worker through Wrangler Assets. `/api/*` goes to the Worker; all other paths serve the React SPA from `dashboard/dist`.

## Requirements

- Cloudflare account with Workers and D1.
- AWS account with SES receiving enabled in a supported region.
- Domain DNS access.
- Node.js 22+.
- AWS SES production access if you want to send to unverified external recipients.

## Quick start

1. Fork or clone this repo.
2. Create D1 databases and paste IDs into `worker/wrangler.jsonc`:
   ```bash
   cd worker
   npx wrangler d1 create hidemyemail
   npx wrangler d1 create hidemyemail-preview
   ```
3. Install dependencies:
   ```bash
   cd ../dashboard && npm ci && npm run build
   cd ../worker && npm ci
   ```
4. Apply migrations:
   ```bash
   npx wrangler d1 migrations apply DB --remote
   ```
5. Set secrets:
   ```bash
   node scripts/hash-password.mjs 'your-admin-passphrase'
   openssl rand -hex 32      # SESSION_SECRET and ACTION_SECRET
   openssl rand -hex 32      # DESTINATION_ENCRYPTION_KEY

   npx wrangler secret put AUTH_PASSWORD_SALT
   npx wrangler secret put AUTH_PASSWORD_HASH
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put ACTION_SECRET
   npx wrangler secret put DESTINATION_ENCRYPTION_KEY
   npx wrangler secret put SES_ACCESS_KEY_ID
   npx wrangler secret put SES_SECRET_ACCESS_KEY
   npx wrangler secret put SNS_ALLOWED_TOPIC_ARN
   ```
   Set `SES_REGION`, `S3_INBOUND_BUCKET`, and `SNS_INBOUND_TOPIC_ARN` as normal Cloudflare environment variables.
6. Deploy unified Worker + dashboard:
   ```bash
   cd dashboard && npm run build
   cd ../worker && npx wrangler deploy
   ```
7. Configure AWS SES/S3/SNS and DNS using [Deployment Guide](docs/DEPLOY.md).
8. Log in, add your global domain in Admin, verify it with the TXT record, set it as main global domain, then add and verify your destination inbox.

## Cloudflare automatic deploys

Cloudflare Workers Builds (Git-connected) is supported via `worker/scripts/cf-build.sh`, which builds the dashboard, installs Worker deps, and applies the matching D1 migrations before Cloudflare runs the deploy command. The script is cwd-agnostic — it self-locates to `worker/`, so either root directory works.

This repo uses **two separate Workers Builds projects** (one per environment):

| Worker | Branch | D1 database | Build command | Deploy command |
|--------|--------|-------------|---------------|----------------|
| `hidemyemail` | `main` | `hidemyemail` | `bash scripts/cf-build.sh` (root: `worker`) | `npx wrangler deploy` |
| `hidemyemail-preview` | `dev` | `hidemyemail-env` | `bash worker/scripts/cf-build.sh` (root: repo root) | `cd worker && npx wrangler deploy --env preview` |

Output directory is not needed; Worker Assets uses `dashboard/dist`. CF Builds supplies wrangler with an implicit `CLOUDFLARE_API_TOKEN`, so no extra repo secrets are needed for migrations or deploys. Keep `worker/wrangler.jsonc` in the repo so Cloudflare can deploy the Worker and Assets binding. Put Worker secrets and deployment-specific variables in Cloudflare, not in git. The config preserves Cloudflare-managed variables during deploys.

## Security defaults

- Public registration is disabled by default. Enable it in Admin only if you want a multi-user instance.
- Destinations must be verified before they can receive forwarded mail.
- Replies fail closed unless the sender matches a verified destination and SES reports SPF or DMARC `PASS` for the authenticated sender.
- SNS webhooks require valid AWS SNS signatures and exact topic ARN matches.
- Destination emails are encrypted in D1.

See [SECURITY.md](SECURITY.md) for threat model and reporting.

## Development

```bash
cd worker
npm ci
npm test
npx tsc --noEmit

cd ../dashboard
npm ci
npm run build
```

For local Worker development, copy `worker/.dev.vars.example` to `worker/.dev.vars` and fill in local values.

## License

MIT. See [LICENSE](LICENSE).
