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
- Mail can use AWS SES, built-in SMTP, an external gateway, a provider SMTP
  relay, or direct-to-MX delivery.

See [Docker self-hosting](../docker/README.md) and [Mail providers](MAIL_PROVIDERS.md).

## Cloudflare deployment prerequisites

- Cloudflare account with Workers and D1.
- AWS account with SES receiving in your chosen region.
- Domain DNS access.
- Node.js 24+.
- AWS SES production access if sending to unverified external recipients.

Docker users need Docker Compose, domain DNS access, and the prerequisites for
their selected providers. Continue in [Docker self-hosting](../docker/README.md)
instead of the Cloudflare steps below.

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

Back up an existing D1 database before upgrading. Apply all migrations before
deploying code that depends on them, and do not run mixed old/new Worker
versions during the migration. Security migrations `0030` through `0033` add
auth-artifact replay protection, delivery idempotency, mail-quota reservations,
and the in-flight SES send fence.

## 4. Generate secrets

From `worker/`, one interactive pass generates and pushes everything
(admin passphrase, random secrets, optional AWS credentials):

```bash
npm run setup   # new deployments only; never key rotation
```

See [Configuration](CONFIGURATION.md) for the manual per-secret equivalent
and what each value does.

Repeat with `--env preview` for preview secrets you actually use.

## 5. Configure plain environment variables

These are not secrets, but they are deployment-specific:

- `SES_REGION`
- `S3_INBOUND_BUCKET`
- `SNS_INBOUND_TOPIC_ARN`
- `SNS_ALLOWED_TOPIC_ARN`
- `APP_ORIGIN` if passkeys are enabled

Set them in the Cloudflare dashboard or via Wrangler deploy flags. The Wrangler config sets `keep_vars: true` to preserve Cloudflare-managed vars.

`APP_ORIGIN` must exactly match the browser-visible HTTPS origin. iOS native
passkeys also require `APPLE_APP_ID` and a matching AASA response; see
[Configuration](CONFIGURATION.md). Native Android passkey enrollment requires
`ANDROID_APP_ORIGINS` derived from the release signing certificate and a
matching `assetlinks.json` response. Self-hosted apps use the authenticated
browser handoff instead and do not need a mobile-app association.

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

`npm run deploy` applies production D1 migrations before publishing the
Worker. If migration fails, the Worker is not published. If deploy fails after
a backward-compatible migration, the old Worker remains active; retrying
`npm run deploy` is safe.

Preview:

```bash
cd worker
npm run deploy:preview
```

### Automatic deploys (Cloudflare Workers Builds)

Configure separate Workers Builds projects to isolate production and preview:

| Worker | Branch | Root dir | Build command | Deploy command |
|--------|--------|----------|---------------|----------------|
| `hidemyemail` | `main` | `worker` | `bash scripts/cf-build.sh` | `npx wrangler deploy` |
| `hidemyemail-preview` | selected short-lived branch | repo root | `cd dashboard && npm ci && npm run build && cd ../worker && npm ci` | `cd worker && npm run deploy:preview` |

`worker/scripts/cf-build.sh` builds the dashboard and migrates production on
`main`. It retains legacy `dev` handling but skips migrations for other branch
names. The preview command above uses the npm predeploy hook to migrate the
preview database before publishing. CF Builds supplies Wrangler authentication;
configure the preview project's secrets separately. See [automatic deployment](DEPLOY.md#8-cloudflare-automatic-deploys).

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
- [Mail providers](MAIL_PROVIDERS.md)
- [Configuration](CONFIGURATION.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Security](SECURITY.md)
