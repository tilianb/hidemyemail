# Troubleshooting

## Dashboard loads but API returns 401

- Confirm you are using HTTPS in deployed environments. Session cookies are `Secure`.
- Confirm `SESSION_SECRET` is set and stable.
- Confirm `AUTH_PASSWORD_SALT` and `AUTH_PASSWORD_HASH` match the passphrase.
- In local dev, use the same origin through Wrangler or the configured Vite proxy.

## Login always fails

Regenerate the password hash:

```bash
cd worker
node scripts/hash-password.mjs 'your-admin-passphrase'
```

Update both:

- `AUTH_PASSWORD_SALT`
- `AUTH_PASSWORD_HASH`

## SNS inbound returns 401 or 403

- `SNS_INBOUND_TOPIC_ARN` must exactly match the inbound SNS topic ARN.
- The SNS message signature must be valid.
- The SNS certificate URL must be an AWS SNS certificate URL.
- Ensure you subscribed the correct topic to `/api/ses/inbound`.

An unset `SNS_INBOUND_TOPIC_ARN` returns a server configuration error rather
than accepting an unsigned authority. Set the exact ARN as a plain environment
variable; do not configure `SNS_SECRET`.

## SNS outbound notification returns 401 or 403

- `SNS_ALLOWED_TOPIC_ARN` must exactly match the outbound SES event topic.
- Use `/api/ses/notification`, not `/api/ses/inbound`.

## SNS subscription remains pending

- Check `wrangler tail` or Docker logs for `SubscriptionConfirmation` errors.
- Confirm the endpoint is reachable over public HTTPS.
- Confirm any reverse proxy forwards POST requests and request bodies.
- Confirm the Worker has the right topic ARN for that endpoint.

## SNS returns 503 or logs "Already processing"

Another worker owns the delivery lease. Allow SNS to retry. Do not manually
republish under a different topic or bypass the delivery claim; completed
duplicates are acknowledged without repeating mail side effects.

## S3 fetch fails with 403

- AWS credentials need `s3:GetObject` on `arn:aws:s3:::YOUR-BUCKET/*`.
- `S3_INBOUND_BUCKET` must match the receipt rule bucket.
- `SES_REGION` must match the bucket region.
- If using SSE-KMS, the Worker credentials also need KMS decrypt permission.

## S3 fetch fails with 404

- Confirm SES receipt rule stores the message in the configured bucket.
- Check whether your receipt rule uses an object key prefix.
- Confirm SNS `mail.messageId` matches the S3 object key format used by the rule.

## Inbound mail is acknowledged but not forwarded

Check whether raw MIME exceeds `max_inbound_bytes` (25 MiB by default). Oversize
mail is intentionally acknowledged and dropped so SNS does not retry a payload
the instance will never accept. Raise the setting only after accounting for
Worker memory and attachment risk.

## SES outbound send fails

- Confirm the domain identity is verified in SES.
- Confirm DKIM records are published and verified.
- If the account is in SES sandbox, recipients must be verified.
- Confirm AWS credentials allow `ses:SendEmail` and `ses:SendRawEmail`.
- Confirm `SES_REGION` is the same region as the identity.

## Replies are rejected

Replies are intentionally strict to prevent open relay abuse.

Check:

- The replying mailbox is a verified destination for that user.
- SES verdicts include SPF or DMARC `PASS`.
- The reverse alias address was not altered by the mail client.
- The alias still exists and is active.

## New aliases do not auto-create

Check:

- The domain exists in the dashboard.
- The domain is active and verified.
- `catch_all_auto_create` is enabled.
- SES receipt rule and DNS MX route mail to the right Worker.

## Domain cannot become main global domain

The domain must be:

- global
- active
- verified

Add the TXT verification record shown in Admin, wait for DNS propagation, then verify again.

## One-click unsubscribe links do not work

- Confirm `ACTION_SECRET` is set.
- Old links stop working if `ACTION_SECRET` is rotated.
- Confirm the action address reaches the same Worker and domain.

## Destination decrypt errors

- `DESTINATION_ENCRYPTION_KEY` must be the same value used when destinations were stored.
- The key must be base64 encoding of exactly 32 random bytes. Generate it with
  `openssl rand -base64 32`; a hex string fails key import.
- Legacy plaintext destination rows are still supported, but invalid ciphertext fails closed.

## Docker container will not start

Run:

```bash
cd docker
cp .env.example .env
$EDITOR .env
docker compose config
```

Common causes:

- `.env` missing.
- Required env var blank.
- `HOST_PORT` already in use.
- Wrong password hash/salt copied into `.env`.

## Docker image pull fails

- The GHCR package may be private in your fork.
- Make the package public, authenticate with `docker login ghcr.io`, or build locally:

```bash
PULL_POLICY=never docker compose build
PULL_POLICY=never docker compose up -d
```

## How to inspect live logs

Cloudflare:

```bash
cd worker
npx wrangler tail
```

Docker:

```bash
cd docker
docker compose logs -f app
```
