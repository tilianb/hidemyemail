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

## Provider SMTP outbound fails

- Confirm `MAIL_OUTBOUND_PROVIDER=smtp`. Restart after an Admin change; use
  `docker compose up -d --force-recreate app` after editing `.env`.
- Use `starttls` on port 587 or `implicit` on port 465. HideMyEmail rejects a
  missing STARTTLS upgrade and invalid certificates.
- Set both SMTP username and password, or leave both empty. Verify that the
  supplier accepts the alias domain and From address.
- If the host setting is an IP address, set `SMTP_OUTBOUND_TLS_SERVERNAME` to
  the certificate's DNS name.
- Confirm the supplier's SPF include and DKIM records. SMTP acceptance does not
  guarantee inbox delivery, and non-SES providers do not feed bounce or
  complaint events back to HideMyEmail.

## Docker SMTP or mail queue fails

- Run `docker compose logs -f app`. A configured listener logs `SMTP ingress
  listening`; startup errors usually identify a missing hostname, credential,
  TLS file, or provider binding.
- Restart the app after mail settings change. The dashboard shows configured
  state, while the process keeps its startup configuration until restart.
- Built-in reception requires the mail Compose overlay, inbound TCP port 25,
  valid MX/A/AAAA records, and healthy Rspamd and ClamAV containers. Check
  `docker compose -f docker-compose.yml -f docker-compose.mail.yml ps`.
- Gateway reception requires `MAIL_INBOUND_PROVIDER=gateway` and
  `SMTP_INBOUND_ENABLED=true`. A non-loopback bind also requires readable PEM
  paths mounted in the app container.
- A gateway `530` means STARTTLS is required, `535` means authentication failed,
  `550` means the recipient or trusted verdict metadata was rejected, and `451`
  means the gateway should retain the message and retry.
- The gateway must add exactly one valid `X-HideMyEmail-Gateway-Result` header.
  See [Mail providers](MAIL_PROVIDERS.md#2-add-the-gateway-verdict-header).
- For the reference stack, include `-f docker-compose.yml -f docker-compose.gateway.yml`
  in Compose commands. Check `logs gateway rspamd clamav`; the gateway reports
  its own queue counts, which do not appear in the app dashboard. A healthy
  listener does not prove scanner readiness.
- `Cannot find module ...gateway-server.mjs` means the image predates the
  reference gateway. Build this branch until a release includes the entrypoint.
- Reference handoff TLS errors: verify certificate SAN `DNS:app`, expiration,
  certificate mounts on both services, and private-key readability by UID
  65532. Recreate both services after replacing mounted certificate files.
- Unknown aliases within an allowed domain become retained failed items after
  private handoff rejection. The reference gateway sends no bounce. Do not
  expect retries of permanent failures; monitor failed counts and queue capacity.
- Check free space in the `/data` volume when the built-in/direct queue stops
  accepting mail. `MAIL_QUEUE_MAX_BYTES` defaults to 1 GiB.
- Direct delivery requires outbound TCP port 25, matching forward and reverse
  DNS, SPF, and every DKIM record shown in Admin. Provider SMTP is the fallback
  when the host blocks port 25 or the IP lacks mail reputation.

## Replies are rejected

Replies are intentionally strict to prevent open relay abuse.

Check:

- The replying mailbox is a verified destination for that user.
- The inbound provider reports SPF `PASS` for the verified envelope owner or
  DMARC `PASS` for the verified header-From owner.
- The external recipient has sent prior inbound mail through that alias.
- The reverse alias address was not altered by the mail client.
- The alias still exists and is active.

## New aliases do not auto-create

Check:

- The domain exists in the dashboard.
- The domain is active and verified.
- `catch_all_auto_create` is enabled.
- The configured inbound provider and DNS MX route mail to the right SES rule,
  built-in listener, or external gateway.

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
