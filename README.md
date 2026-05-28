# HideMyEmail

A self-hosted, serverless email-alias service for your own domains. HideMyEmail runs as a Cloudflare Worker with a React dashboard, Cloudflare D1 for state, and AWS SES/S3/SNS for email receiving and sending.

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
