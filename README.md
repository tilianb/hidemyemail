<p align="center">
  <img src="dashboard/public/favicon.svg" alt="HideMyEmail logo" width="96" height="96">
</p>

<p align="center">
  <a href="https://app.hidemyemail.dev">app.hidemyemail.dev</a>
</p>

# HideMyEmail

Self-hosted, **serverless** email aliases for your domains. No VPS, no
Postfix, no mail stack. It runs as a Cloudflare Worker with a React
dashboard, Cloudflare D1 for state, and AWS SES/S3/SNS for receiving and
sending mail. The running cost is **~$0/month** on the Cloudflare free tier
plus AWS SES usage.

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/tilianb/hidemyemail">
    <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare Workers">
  </a>
</p>

## Why

Use your domain without running Postfix, a VPS, or a full mail stack. SES
receives mail, S3 stores the raw MIME, SNS calls the Worker, and the Worker
rewrites and forwards mail through SES. Replies work from your normal inbox.
Recipients see the alias.

## How it compares

|  | HideMyEmail | SimpleLogin | addy.io | Cloudflare Email Routing | ImprovMX |
|---|---|---|---|---|---|
| Self-host without a mail server | ✅ serverless (Workers + SES) | ❌ full mail stack (Postfix) | ❌ full mail stack | n/a (hosted only) | n/a (hosted only) |
| Reply / send from alias | ✅ | ✅ | ✅ | ❌ | ✅ paid |
| Catch-all + on-the-fly aliases | ✅ | ✅ | ✅ | ❌ manual rules | ✅ |
| Per-alias / per-subdomain block & allow rules | ✅ | ✅ | ✅ | ❌ | ❌ |
| Bounce/complaint auto-suppression | ✅ | ✅ | ✅ | n/a | n/a |
| Multi-user with admin panel | ✅ | hosted plans | hosted plans | ❌ | ❌ |
| Typical self-host cost | ~$0 + SES cents | VPS $5+/mo | VPS $5+/mo | free (limited) | $9+/mo |
| Open source | ✅ MIT | ✅ | ✅ | ❌ | ❌ |

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
- Forwarding to verified destination inboxes. Spam and virus verdict handling
  protects your domain's sender reputation from forwarded junk.
- Reply-from-alias without exposing your inbox. SPF/DMARC
  checks, first-contact verification, and outbound rate caps gate this feature.
- RFC 8058 one-click unsubscribe to disable aliases. It applies to mail
  resembling bulk mail. Personal forwards stay clean.
- Bounce/complaint feedback loop with automatic destination suppression.
- Per-subdomain policies and scoped block/allow sender rules.
- Dashboard for aliases, domains, destinations, rules, users, MFA,
  passkeys, and admin settings. It includes data export and account deletion.
- SNS signature checks, encrypted destination addresses, and rate limits.

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

For local Worker development, copy `worker/.dev.vars.example` to `worker/.dev.vars` and supply local values.

## License

MIT. See [LICENSE](LICENSE).
