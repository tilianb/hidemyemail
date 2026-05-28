# Configuration

This page lists the runtime settings used by HideMyEmail.

## Cloudflare config

`worker/wrangler.jsonc` contains deploy structure:

- Worker name and entrypoint.
- Worker Assets binding for `dashboard/dist`.
- D1 database bindings.
- Non-sensitive defaults such as `ENVIRONMENT`.

Do not commit real secrets or `.dev.vars`.

## Plain environment variables

These are deployment-specific but not secrets. Store them in Cloudflare dashboard, or pass them during deploy with `--var` and `--keep-vars`.

| Name | Required | Purpose |
|------|----------|---------|
| `ENVIRONMENT` | yes | `production`, `preview`, or `local`. |
| `SES_REGION` | yes for mail | AWS SES/S3/SNS region, for example `ap-southeast-2`. |
| `S3_INBOUND_BUCKET` | yes for inbound | Bucket where SES stores raw MIME. |

The npm deploy scripts use `--keep-vars` so dashboard-managed variables are preserved.

## Worker secrets

Set with `wrangler secret put`.

| Name | Required | Purpose |
|------|----------|---------|
| `SES_ACCESS_KEY_ID` | yes for mail | AWS access key for SES send and S3 read. |
| `SES_SECRET_ACCESS_KEY` | yes for mail | AWS secret access key. |
| `SESSION_SECRET` | yes | Signs dashboard session cookies. |
| `ACTION_SECRET` | yes | Signs one-click unsubscribe/action links. |
| `AUTH_PASSWORD_SALT` | first user bootstrap | PBKDF2 salt from `hash-password.mjs`. |
| `AUTH_PASSWORD_HASH` | first user bootstrap | PBKDF2 hash from `hash-password.mjs`. |
| `DESTINATION_ENCRYPTION_KEY` | yes | 32-byte hex key for encrypted destination emails. |
| `SNS_ALLOWED_TOPIC_ARN` | yes for outbound SNS | Exact SNS topic for bounces/complaints. |
| `SNS_INBOUND_TOPIC_ARN` | yes for inbound SNS | Exact SNS topic for SES receipt notifications. |

## Generate secret values

From `worker/`:

```bash
node scripts/hash-password.mjs 'your-admin-passphrase'
openssl rand -hex 32  # SESSION_SECRET
openssl rand -hex 32  # ACTION_SECRET
openssl rand -hex 32  # DESTINATION_ENCRYPTION_KEY
```

`DESTINATION_ENCRYPTION_KEY` must be hex. Do not use base64.

## Database settings

The app stores feature settings in D1. Important defaults:

| Setting | Public default | Notes |
|---------|----------------|-------|
| `registration_enabled` | `false` | Enable only if other users should self-register. |
| `cors_allowed_domains` | `http://localhost:5173` | Add deployed dashboard origins if needed. |
| `main_global_domain` | empty | Set after verifying a global domain. |
| `catch_all_auto_create` | enabled | Allows first inbound mail to create aliases. |

Most settings are editable from the Admin dashboard.

## Cloudflare automatic deploys

Use these settings for Workers Git deployments:

- Root directory: repository root
- Build command: `cd dashboard && npm ci && npm run build && cd ../worker && npm ci`
- Deploy command: `cd worker && npm run deploy`
- Output directory: not needed

Keep Cloudflare-managed variables in the dashboard. The deploy script uses `--keep-vars`.

## Preview environment

Preview has its own Worker and D1 binding under `env.preview`.

Set preview-specific secrets with:

```bash
npx wrangler secret put NAME --env preview
```

Set preview plain vars in Cloudflare dashboard or deploy with:

```bash
npx wrangler deploy --env preview --keep-vars \
  --var SES_REGION:YOUR-SES-REGION \
  --var S3_INBOUND_BUCKET:YOUR-INBOUND-BUCKET \
  --var SNS_INBOUND_TOPIC_ARN:YOUR-INBOUND-TOPIC-ARN
```

## Local development

Copy the example file:

```bash
cp worker/.dev.vars.example worker/.dev.vars
```

Fill in local values. Never commit `.dev.vars`.

Run locally:

```bash
cd dashboard
npm run dev

cd ../worker
npx wrangler dev
```
