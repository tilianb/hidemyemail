# Security Notes

For vulnerability reporting and supported versions, see the root [Security Policy](../SECURITY.md).

## Threat model

HideMyEmail handles email relay. The main security goals are:

- Do not become an open relay.
- Do not expose real destination inbox addresses to external senders.
- Do not trust spoofable webhook input.
- Protect destination email addresses stored in D1.
- Keep admin and user operations scoped to the authenticated user.
- Keep bearer credentials bound to the server origin that issued them.
- Prevent retries and concurrent requests from repeating external side effects.

## Relay controls

Reply-from-alias is gated by multiple checks:

1. The reverse alias must decode to a known alias/external sender pair.
2. The envelope sender must match a verified destination for the alias owner.
3. SES SPF or DMARC verdict must pass.
4. Failures are rejected instead of relayed.

## SNS webhook validation

SNS endpoints validate AWS SNS signatures and exact topic ARNs:

- `SNS_INBOUND_TOPIC_ARN` for `/api/ses/inbound`
- `SNS_ALLOWED_TOPIC_ARN` for `/api/ses/notification`

Use separate topics for inbound receipts and outbound SES events.
Both ARNs must be configured for their endpoint to operate. The Worker verifies
the AWS signature and certificate before checking the exact `TopicArn`.
`SNS_SECRET` is obsolete; do not add a shared secret to webhook URLs.

## Authentication boundaries

- WebAuthn derives its RP ID and expected origin from canonical `APP_ORIGIN`,
  never a request header.
- Authentication rate-limit admission and MFA backup-code consumption use
  conditional D1 writes so concurrent requests cannot share the final slot or
  code.
- Password-authenticated MFA login challenges contain a random nonce and are
  claimed once in D1. TOTP, backup-code, and passkey completion share that
  parent claim, and backup-code or passkey state changes commit atomically with
  it so a replay cannot mint another session or partially advance state.
- Passkey challenges and native app-auth codes are one-time artifacts. Passkey
  assertion counters use compare-and-swap updates, so concurrent assertions
  verified against the same positive counter cannot both succeed.
- Sensitive account operations require a 10-minute fresh-auth credential in
  addition to the seven-day session. When it expires, the dashboard and native
  apps confirm the current account in place with its passphrase and enabled MFA
  or with one of that account's passkeys, then retry only the interrupted
  operation once. Web elevation replaces only the HttpOnly fresh-auth cookie;
  native elevation replaces only the memory-held fresh-auth token. Neither path
  changes the session principal or returns a bearer credential to browser code.
- Account recovery revokes sessions, fresh-auth credentials, MFA, passkeys,
  and API keys by advancing `auth_version` in the winning transaction.
- Native credentials are bound to canonical HTTPS origins. Origin changes,
  sign-out, and stale request failures cannot affect a replacement session.

## MIME handling

The Worker performs header surgery on raw MIME bytes:

- Headers are parsed and rewritten.
- Body bytes are preserved.
- Unsafe authentication and routing headers are stripped before re-injection.
- Forwarded mail gets traceability headers.
- SNS JSON, S3 MIME, reply MIME, error bodies, and signing certificates are
  bounded before full allocation.

Do not decode an entire MIME message as text when changing this code; attachments can be binary.

SNS and SES identities are stored in durable delivery claims. Claim tokens
fence expired workers, quota is reserved before SES, and durable bookkeeping
completes in one fenced D1 batch. A process crash after SES accepts a message
but before local acceptance is recorded remains ambiguous; retries wait for the
five-minute send fence before reclaiming it.

## Secret handling

Keep these private:

- `SESSION_SECRET`
- `ACTION_SECRET`
- `DESTINATION_ENCRYPTION_KEY`
- `SES_ACCESS_KEY_ID`
- `SES_SECRET_ACCESS_KEY`
- password hash and salt values

`SES_REGION`, `S3_INBOUND_BUCKET`, and SNS topic ARNs are not secret, but they are deployment-specific. Store them in Cloudflare environment variables. Do not hard-code public repo defaults.

## Destination encryption

Destination emails are encrypted in D1 with `DESTINATION_ENCRYPTION_KEY`.
Use base64 encoding of exactly 32 random bytes:

```bash
openssl rand -base64 32
```

Do not rotate this key unless you plan a data migration. Existing encrypted destination rows need the same key to decrypt.

## Public registration

Registration is disabled by default. Enable it if you intentionally run a multi-user instance.

If enabled:

- Keep rate limits active.
- Review CORS origins.
- Verify all user/domain scoping changes carefully.

## Operational checklist

Before making an instance public:

- Use least-privilege AWS IAM credentials.
- Verify SPF, DKIM, and DMARC for every sending domain.
- Configure exact SNS topic ARNs.
- Configure exact `APP_ORIGIN` before enabling passkeys. A newly verified
  passkey can also confirm MFA disable and MFA backup-code regeneration without
  requiring access to the current authenticator. The Worker binds each
  passkey challenge to the current account, authentication version, and one
  selected MFA action, then consumes it once without replacing the session.
  The same account-bound passkey can refresh the 10-minute authorization window
  for exports, recovery-code changes, API-key management, and passkey changes.
- Confirm SES production access if needed.
- Run a full send-forward-reply test.
- Monitor SES bounces, complaints, and quotas.
- Keep Docker on loopback behind TLS, preserve container confinement, and
  configure an overwrite-only trusted client-IP header when proxying.
- Back up D1 or the Docker `/data` volume before migrations and do not run old
  and new application versions against the database during an upgrade.
