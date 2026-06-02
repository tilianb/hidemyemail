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
| `SNS_INBOUND_TOPIC_ARN` | yes for inbound SNS | Exact SNS topic for SES receipt notifications. |
| `APP_ORIGIN` | for native passkeys | Dashboard web origin, e.g. `https://app.hidemyemail.dev`. WebAuthn relying-party origin for native clients, which send no `Origin` header. Defaults to `https://app.hidemyemail.dev` if unset. |
| `APPLE_APP_ID` | for iOS passkeys | Apple App ID `<TeamID>.<bundleId>` (e.g. `ABCDE12345.dev.hidemyemail.app`) published in `/.well-known/apple-app-site-association`. The AASA route 404s until this is set. |

`worker/wrangler.jsonc` sets `keep_vars: true` so dashboard-managed variables are preserved even when Cloudflare Git deploys run plain `wrangler deploy`.

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

## Per-subdomain policies

Each subdomain you own can override the global defaults, so a subdomain works
as a self-contained mail category. Settings resolve most-specific first:
**alias → subdomain → global**. On the Domains page:

- **Catch-all** — `Inherit` / `On` / `Off`. Overrides `catch_all_auto_create`
  for that subdomain, e.g. let `shop.example.com` auto-create any address while
  your primary domain only accepts explicit aliases.
- **Inline actions** — `Inherit` / `On` / `Off`. Overrides your per-user inline
  toolbar preference for mail received on that subdomain.
- **Default destination** — where mail without a per-alias destination is sent.

## Sender rules (block / allow)

The Blocks page manages sender rules scoped **globally**, to a **subdomain**, or
to a single **alias**:

- **Block** rules drop matching senders before forwarding.
- **Allow** rules enable allowlist mode for their scope: once any allow rule
  exists, only senders matching one are forwarded and everything else is
  dropped. A matching block rule always wins over an allow rule.

Patterns support wildcards (`*@spam.com`, `evil@badactor.org`).

## Cloudflare automatic deploys

Cloudflare Workers Builds are supported with `worker/scripts/cf-build.sh`.
Use the full [automatic deploy setup](DEPLOY.md#8-cloudflare-automatic-deploys) in the deployment guide.

Keep Cloudflare-managed variables in the dashboard. The Wrangler config sets `keep_vars: true`, and deploy commands should preserve dashboard-managed vars.

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
