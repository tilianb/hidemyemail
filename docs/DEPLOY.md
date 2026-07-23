# Deployment Guide

This guide sets up a new HideMyEmail instance with your own domain.

## 1. Create Cloudflare D1 databases

```bash
cd worker
npx wrangler d1 create hidemyemail
npx wrangler d1 create hidemyemail-preview
```

Paste the returned IDs into `worker/wrangler.jsonc` under `database_id` and `preview_database_id`. Keep the `assets` block intact so Cloudflare deploys the dashboard and Worker together.

Apply migrations:

```bash
npx wrangler d1 migrations apply DB --remote
```

## 2. Generate and set secrets

One command does the whole pass — generates the random secrets, hashes your
admin passphrase, prompts for the (optional) AWS credentials, and pushes
everything with `wrangler secret put`:

```bash
cd worker
npm run setup                    # or: npm run setup -- --env preview
```

Add `-- --print` to print `KEY=VALUE` lines instead of pushing (useful for the
Docker self-host `.env`).

<details>
<summary>Manual equivalent</summary>

Generate the admin password hash:

```bash
node scripts/hash-password.mjs 'your-admin-passphrase'
```

Generate random secrets:

```bash
openssl rand -hex 32      # SESSION_SECRET
openssl rand -hex 32      # ACTION_SECRET
openssl rand -base64 32   # DESTINATION_ENCRYPTION_KEY — must be base64 of
                          # exactly 32 bytes (a hex string breaks AES key import)
```

Set Cloudflare Worker secrets:

```bash
npx wrangler secret put AUTH_PASSWORD_SALT
npx wrangler secret put AUTH_PASSWORD_HASH
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ACTION_SECRET
npx wrangler secret put DESTINATION_ENCRYPTION_KEY
npx wrangler secret put SES_ACCESS_KEY_ID
npx wrangler secret put SES_SECRET_ACCESS_KEY
npx wrangler secret put SNS_ALLOWED_TOPIC_ARN
```

</details>

Set `SES_REGION`, `S3_INBOUND_BUCKET`, `SNS_INBOUND_TOPIC_ARN`, and the
canonical dashboard `APP_ORIGIN` as normal Cloudflare environment variables.
For Docker, set `APP_ORIGIN` in `docker/.env` to the externally visible HTTPS
origin with no path, query, fragment, credentials, or trailing slash.

`ACTION_SECRET` signs one-click unsubscribe addresses. Use a stable value; rotating it invalidates old unsubscribe links.

## 3. Create least-privilege AWS credentials

Create an IAM user or role for the Worker with permissions limited to:

- `ses:SendEmail`
- `ses:SendRawEmail`
- `s3:GetObject` on the inbound raw-email bucket

Example policy shape:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR-INBOUND-BUCKET/*"
    }
  ]
}
```

## 4. Configure AWS SES receiving

1. Verify your domain as an SES identity.
2. Publish SES DKIM CNAME records in DNS.
3. Create a private S3 bucket for raw inbound MIME.
4. Add an S3 bucket policy that allows SES to write objects for your account and receipt rule.
5. Create an SNS topic for inbound receipt notifications.
6. Create an SES receipt rule:
   - Recipients: your domain or subdomain.
   - Action 1: S3 bucket, object key prefix optional.
   - Action 2: SNS inbound topic.
7. Subscribe SNS inbound topic to:
   `https://YOUR-WORKER-HOST/api/ses/inbound`

The inbound endpoint verifies SNS signatures, checks `SNS_INBOUND_TOPIC_ARN`, fetches the raw MIME from S3, then routes the message.

## 5. Configure SES outbound notifications

1. Create a second SNS topic for bounces, complaints, and delivery events.
2. Configure SES identity notifications to publish to that topic.
3. Subscribe the topic to:
   `https://YOUR-WORKER-HOST/api/ses/notification`
4. Set `SNS_ALLOWED_TOPIC_ARN` to this outbound topic ARN.

## 6. Configure DNS for each domain

For each domain you want to use:

- MX: `10 inbound-smtp.YOUR-SES-REGION.amazonaws.com`
- SPF TXT: `v=spf1 include:amazonses.com ~all`
- DKIM: the 3 SES-provided CNAME records
- DMARC TXT at `_dmarc`: start with `v=DMARC1; p=quarantine; rua=mailto:dmarc@YOUR-DOMAIN`

Recommended custom MAIL FROM:

```bash
aws sesv2 put-email-identity-mail-from-attributes \
  --region YOUR-SES-REGION \
  --email-identity YOUR-DOMAIN \
  --mail-from-domain bounce.YOUR-DOMAIN \
  --behavior-on-mx-failure USE_DEFAULT_VALUE
```

DNS for `bounce.YOUR-DOMAIN`:

- MX: `10 feedback-smtp.YOUR-SES-REGION.amazonses.com`
- TXT: `v=spf1 include:amazonses.com ~all`

## 7. Deploy Worker and dashboard

```bash
cd dashboard
npm ci
npm run build

cd ../worker
npm ci
npx wrangler deploy
```

The Worker serves both API and dashboard through Wrangler Assets. You do not need a separate Cloudflare Pages project.

## 8. Cloudflare automatic deploys

When using Cloudflare Workers Builds (Git-connected), the included `worker/scripts/cf-build.sh` builds the dashboard, installs Worker deps, and applies D1 migrations to the right database before Cloudflare runs `wrangler deploy`. The script is cwd-agnostic. It self-locates to `worker/`. The root directory can be `worker` or the repo root.

Migrations are branch-aware:

- `main` → applies migrations to `hidemyemail` (production)
- `dev` → applies migrations to `hidemyemail-env` (preview env)
- other branches → migrations skipped

This repo uses **two separate Workers Builds projects**:

### `hidemyemail` (production, branch `main`)

- Root directory: `worker`
- Build command: `bash scripts/cf-build.sh`
- Deploy command: `npx wrangler deploy`

### `hidemyemail-preview` (preview, branch `dev`)

- Root directory: repo root
- Build command: `bash worker/scripts/cf-build.sh`
- Deploy command: `cd worker && npx wrangler deploy --env preview`

CF Builds injects an internal `CLOUDFLARE_API_TOKEN` for wrangler. Migrations and deploys need no extra secrets.

Store all Worker secrets in Cloudflare (`wrangler secret put …` or dashboard). Do not commit `.dev.vars`.

## 9. First-run dashboard setup

1. Log in with the admin passphrase used in `AUTH_PASSWORD_HASH`.
2. Go to Admin → Global domains.
3. Add your domain.
4. Publish the `_hidemyemail.YOUR-DOMAIN` TXT verification record shown by the dashboard.
5. Verify the domain.
6. Set it as the main global domain.
7. Set SES region, S3 bucket, and topic ARNs in Admin settings if you left Worker vars blank.
8. Add and verify your destination inbox in Destinations.
9. Create a test alias.

Public registration starts disabled. Enable it in Admin if other users should register themselves.

## 10. Smoke tests

- Send mail from an external account to a new alias.
- Confirm it arrives at your verified destination.
- Reply from your inbox.
- Confirm the external sender sees the alias as the sender and your real inbox address is absent from headers.
- Check `npx wrangler tail` for SNS signature, S3, or SES errors.
- Use mail-tester.com or equivalent to verify SPF, DKIM, and DMARC.

## Troubleshooting

- **SNS 401:** `SNS_*_TOPIC_ARN` does not match the posting topic or the SNS signature/cert region is wrong.
- **S3 403/404:** Worker AWS credentials lack `s3:GetObject`, bucket name is wrong, or receipt rule stores under a prefix not matching message ID lookup.
- **SES rejects outbound:** domain identity not verified, SES sandbox active, or MAIL FROM/DKIM not configured.
- **Dashboard loads but API 401:** cookies require HTTPS. They use `__Host-` and `Secure`.
- **New aliases do not auto-create:** check `catch_all_auto_create` and whether the domain is active/verified.
- **Cannot set main global domain:** domain must be global, active, and verified.
