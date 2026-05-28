<p align="center">
  <img src="dashboard/public/favicon.svg" alt="HideMyEmail logo" width="96" height="96">
</p>

<p align="center">
  <a href="https://app.hidemyemail.dev">app.hidemyemail.dev</a>
</p>

# HideMyEmail

Self-hosted, serverless email aliases for your own domains. HideMyEmail runs as
a Cloudflare Worker with a React dashboard, Cloudflare D1 for state, and AWS
SES/S3/SNS for receiving and sending mail.

## Why

Use your own domain without running Postfix, a VPS, or a full mail stack. SES
receives mail, S3 stores the raw MIME, SNS calls the Worker, and the Worker
rewrites and forwards mail through SES. Replies work from your normal inbox
while recipients only see the alias.

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

## Features

- Aliases on your own domain, including catch-all auto-create.
- Forwarding to verified destination inboxes.
- Reply-from-alias without exposing your real inbox.
- One-click unsubscribe headers that can disable aliases.
- Dashboard for aliases, domains, destinations, block lists, users, MFA, and admin settings.
- Strict reply gate, SNS signature checks, encrypted destination addresses, and rate limits.

## Quick start

### Docker self-host

```bash
git clone https://github.com/tilianb/hidemyemail.git
cd hidemyemail/docker
cp .env.example .env
$EDITOR .env
docker compose pull
docker compose up -d
```

Open <http://localhost:8787>. AWS SES is still required for mail. See [Docker self-hosting](docker/README.md).

### Cloudflare Worker

```bash
git clone https://github.com/tilianb/hidemyemail.git
cd hidemyemail
cd dashboard && npm ci && npm run build
cd ../worker && npm ci
npx wrangler deploy
```

You also need D1 databases, Worker secrets, SES/S3/SNS, and DNS. Follow [Getting started](docs/GETTING_STARTED.md), then [Deployment guide](docs/DEPLOY.md).

## Documentation

- [Getting started](docs/GETTING_STARTED.md)
- [Deployment guide](docs/DEPLOY.md)
- [AWS SES setup](docs/AWS_SES_SETUP.md)
- [Configuration](docs/CONFIGURATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Security notes](docs/SECURITY.md)
- [Docker self-hosting](docker/README.md)

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
