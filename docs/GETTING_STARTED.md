# Getting Started

This guide gets a new HideMyEmail instance running with your own domain.

## Choose a deployment mode

### Cloudflare Worker, recommended

Use this for the intended serverless setup:

- Cloudflare Worker + Worker Assets for API and dashboard.
- Cloudflare D1 for state.
- AWS SES/S3/SNS for inbound and outbound email.

Follow this page, then continue with [AWS SES setup](AWS_SES_SETUP.md).

### Docker self-host

Use this to run the Worker locally in a container with Miniflare:

- Docker hosts the API and dashboard.
- Local SQLite stores D1 data.
- AWS SES/S3/SNS still handles mail.

See [Docker self-hosting](../docker/README.md).

## Prerequisites

- Cloudflare account with Workers and D1.
- AWS account with SES receiving in your chosen region.
- Domain DNS access.
- Node.js 22+.
- AWS SES production access if sending to unverified external recipients.

## 1. Fork or clone

```bash
git clone https://github.com/tilianb/hidemyemail.git
cd hidemyemail
```

## 2. Install and build

```bash
cd dashboard
npm ci
npm run build

cd ../worker
npm ci
```

## 3. Create D1 databases

```bash
npx wrangler d1 create hidemyemail
npx wrangler d1 create hidemyemail-preview
```

Paste the returned IDs into `worker/wrangler.jsonc`:

- production `database_id`
- production `preview_database_id`, if you use Wrangler preview databases
- `env.preview.d1_databases[0].database_id`, if you deploy the preview environment

Apply migrations:

```bash
npx wrangler d1 migrations apply DB --remote --env=""
```

For preview:

```bash
npx wrangler d1 migrations apply DB --remote --env preview
```

## 4. Generate secrets

From `worker/`:

```bash
node scripts/hash-password.mjs 'your-admin-passphrase'
openssl rand -hex 32  # SESSION_SECRET
openssl rand -hex 32  # ACTION_SECRET
openssl rand -hex 32  # DESTINATION_ENCRYPTION_KEY
```

Set the generated values and AWS credentials:

```bash
npx wrangler secret put AUTH_PASSWORD_SALT --env=""
npx wrangler secret put AUTH_PASSWORD_HASH --env=""
npx wrangler secret put SESSION_SECRET --env=""
npx wrangler secret put ACTION_SECRET --env=""
npx wrangler secret put DESTINATION_ENCRYPTION_KEY --env=""
npx wrangler secret put SES_ACCESS_KEY_ID --env=""
npx wrangler secret put SES_SECRET_ACCESS_KEY --env=""
npx wrangler secret put SNS_ALLOWED_TOPIC_ARN --env=""
```

Repeat with `--env preview` for preview secrets you actually use.

## 5. Configure plain environment variables

These are not secrets, but they are deployment-specific:

- `SES_REGION`
- `S3_INBOUND_BUCKET`
- `SNS_INBOUND_TOPIC_ARN`

Set them in the Cloudflare dashboard or via Wrangler deploy flags. The Wrangler config sets `keep_vars: true` to preserve Cloudflare-managed vars.

## 6. Configure AWS and DNS

Continue with [AWS SES setup](AWS_SES_SETUP.md). You need SES domain verification, an S3 bucket, SNS topics, and DNS records before mail will flow.

## 7. Deploy

Manual deploy from your machine:

```bash
cd dashboard
npm run build

cd ../worker
npm run deploy
```

Preview:

```bash
cd worker
npm run deploy:preview
```

### Automatic deploys (Cloudflare Workers Builds)

This repo deploys via **two separate Workers Builds projects** so prod and preview stay fully isolated:

| Worker | Branch | Root dir | Build command | Deploy command |
|--------|--------|----------|---------------|----------------|
| `hidemyemail` | `main` | `worker` | `bash scripts/cf-build.sh` | `npx wrangler deploy` |
| `hidemyemail-preview` | `dev` | repo root | `bash worker/scripts/cf-build.sh` | `cd worker && npx wrangler deploy --env preview` |

`worker/scripts/cf-build.sh` is cwd-agnostic. It builds the dashboard and runs `wrangler d1 migrations apply --remote` against the correct D1 (`hidemyemail` for main, `hidemyemail-env` for dev) before Cloudflare runs the deploy command. The schema stays in sync with the code being deployed. CF Builds provides wrangler auth implicitly. You do not need GitHub secrets.

## 8. First dashboard setup

1. Open your Worker URL.
2. Log in with the admin passphrase used to create `AUTH_PASSWORD_HASH`.
3. Go to Admin → Global domains.
4. Add your domain.
5. Publish the TXT verification record shown in the dashboard.
6. Verify the domain and set it as the main global domain.
7. Add and verify a destination inbox.
8. Send a test email to a new alias.

## Next docs

- [AWS SES setup](AWS_SES_SETUP.md)
- [Configuration](CONFIGURATION.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Security](SECURITY.md)
