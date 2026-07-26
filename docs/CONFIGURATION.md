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

These are deployment-specific, not secrets. Store them in the Cloudflare dashboard, or pass them during deploy with `--var` and `--keep-vars`.

| Name | Required | Purpose |
|------|----------|---------|
| `ENVIRONMENT` | yes | `production`, `preview`, `local`, or `self-hosted`. The Docker host sets `self-hosted` and supplies the Worker's private client-IP header after validating the socket peer. Do not expose a self-hosted Worker without that host boundary. |
| `SES_REGION` | yes for mail | AWS SES/S3/SNS region, for example `ap-southeast-2`. |
| `S3_INBOUND_BUCKET` | yes for inbound | Bucket where SES stores raw MIME. |
| `SNS_INBOUND_TOPIC_ARN` | yes for inbound SNS | Exact SNS topic for SES receipt notifications. |
| `SNS_ALLOWED_TOPIC_ARN` | yes for outbound SNS | Exact SNS topic for SES bounce and complaint notifications. Topic ARNs identify webhook authority but are not secrets. |
| `APP_ORIGIN` | required for passkeys | Exact browser-visible dashboard origin, e.g. `https://app.hidemyemail.dev`. WebAuthn always derives its RP ID and expected origin from this value, never request headers. Production origins must use HTTPS and contain no path, query, fragment, credentials, or trailing slash; HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1` development. Docker deployments must set the externally visible origin explicitly in `docker/.env` to enable passkeys; ordinary authentication and mail continue to work when it is unset. |
| `APPLE_APP_ID` | for iOS passkeys | Apple App ID `<TeamID>.<bundleId>` (e.g. `ABCDE12345.dev.hidemyemail.app`) published in `/.well-known/apple-app-site-association`. The AASA route 404s until this is set. |
| `APNS_KEY_ID` | for iOS push | 10-char Key ID of the APNs `.p8` signing key. |
| `APNS_TEAM_ID` | for iOS push | Apple Developer Team ID. Falls back to the `<TeamID>` prefix of `APPLE_APP_ID` if unset. |
| `APNS_BUNDLE_ID` | for iOS push | APNs topic (the app bundle id, e.g. `dev.hidemyemail.app`). Falls back to the `<bundleId>` suffix of `APPLE_APP_ID`. |
| `APNS_HOST` | optional | Override the APNs host. Defaults to `api.push.apple.com`; use `api.sandbox.push.apple.com` for development-signed builds. |
| `FCM_PROJECT_ID` | optional (Android push) | Firebase project id. Falls back to the `project_id` inside `FCM_SERVICE_ACCOUNT` when unset. |

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
| `DESTINATION_ENCRYPTION_KEY` | yes | Base64 of exactly 32 random bytes — the AES-256-GCM key for encrypted destination emails. |
| `APNS_AUTH_KEY` | for iOS push | Contents of the APNs `AuthKey_XXXXXXXXXX.p8` (the full PEM, including the `BEGIN/END PRIVATE KEY` lines). With `APNS_KEY_ID` + team/bundle, enables push; omit and push is a no-op (device registration still works, nothing is sent). |
| `FCM_SERVICE_ACCOUNT` | for Android push | Full Firebase **service-account JSON** (with `client_email` + `private_key`) for the FCM HTTP v1 API. Enables Android push; omit and Android push is a no-op (device registration still works, nothing is sent). The Android app also needs a matching `google-services.json` at build time. |

## Generate secret values

From `worker/`:

```bash
npm run setup   # interactive one-shot: generates + pushes everything
```

Or manually:

```bash
node scripts/hash-password.mjs 'your-admin-passphrase'
openssl rand -hex 32     # SESSION_SECRET
openssl rand -hex 32     # ACTION_SECRET
openssl rand -base64 32  # DESTINATION_ENCRYPTION_KEY
```

`DESTINATION_ENCRYPTION_KEY` must be base64 of exactly 32 bytes (AES-256).
A hex string fails key import at runtime — do not use `openssl rand -hex`.

## Database settings

The app stores feature settings in D1. Important defaults:

| Setting | Public default | Notes |
|---------|----------------|-------|
| `registration_enabled` | `false` | Enable only if other users should self-register. |
| `cors_allowed_domains` | `http://localhost:5173` | Add deployed dashboard origins if needed. |
| `main_global_domain` | empty | Set after verifying a global domain. |
| `catch_all_auto_create` | enabled | Allows first inbound mail to create aliases. |
| `max_inbound_bytes` | `26214400` (25 MiB) | Hard cap applied while streaming raw MIME from S3 and before parsing replies. Oversize inbound mail is acknowledged without forwarding. |
| `rate_limit_per_alias` | `20` | Maximum inbound forwards per alias in the rolling one-hour window. |
| `rate_limit_reply_per_alias` | `10` | Maximum replies per alias in the rolling one-hour window. |
| `rate_limit_global` | `1000` | Maximum combined forwards and replies in the rolling one-hour window. |
| `reply_distinct_recipient_cap` | `15` | Maximum distinct external recipients per alias in 24 hours. Existing contacts remain allowed. |
| `spam_verdict_action` | `flag` | Action when SES marks inbound mail as spam: `forward`, `flag` (adds `X-Spam-Flag: YES`), or `drop`. Your domain DKIM-signs forwarded spam. Forwarding it untouched damages your sender reputation. |
| `virus_verdict_action` | `drop` | Same options for SES malware detection. |
| `unsubscribe_header_mode` | `bulk_only` | When to add the one-click List-Unsubscribe to forwards: `always`, `bulk_only` (when the original carried List-Unsubscribe or `Precedence: bulk`), or `never`. Adding it to personal mail makes forwards look like bulk mail to spam filters. |
| `soft_bounce_threshold` | `3` | Soft bounces within 24h before a destination is paused (0 disables). |

Most settings are editable from the Admin dashboard.
Mail limits reserve capacity before SES, so concurrent deliveries cannot share
the last quota slot. SES-accepted reservations continue to count until their
hourly or daily window closes if bookkeeping must retry.

## Per-subdomain policies

Each subdomain you own can override the global defaults, so a subdomain works
as a self-contained mail category. Settings resolve most-specific first:
**alias → subdomain → global**. On the Domains page:

- **Catch-all** — `Inherit` / `On` / `Off`. Overrides `catch_all_auto_create`
  for that subdomain. For example, `shop.example.com` auto-creates any address.
  Your primary domain accepts explicit aliases.
- **Inline actions** — `Inherit` / `On` / `Off`. Overrides the per-user inline
  toolbar preference for mail received on that subdomain.
- **Default destination** — The destination for mail without a per-alias destination.

## Sender rules (block / allow)

The Rules page manages sender rules scoped **globally**, to a **subdomain**, or
to a single **alias**:

- **Block** rules drop matching senders before forwarding.
- **Allow** rules enable allowlist mode for their scope. Once any allow rule
  exists, the system forwards only senders matching one and drops everything else.
  A matching block rule wins over an allow rule.

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
