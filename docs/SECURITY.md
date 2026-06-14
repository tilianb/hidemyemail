# Security Notes

For vulnerability reporting and supported versions, see the root [Security Policy](../SECURITY.md).

## Threat model

HideMyEmail handles email relay. The main security goals are:

- Do not become an open relay.
- Do not expose real destination inbox addresses to external senders.
- Do not trust spoofable webhook input.
- Protect destination email addresses stored in D1.
- Keep admin and user operations scoped to the authenticated user.

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

## MIME handling

The Worker performs header surgery on raw MIME bytes:

- Headers are parsed and rewritten.
- Body bytes are preserved.
- Unsafe authentication and routing headers are stripped before re-injection.
- Forwarded mail gets traceability headers.

Do not decode an entire MIME message as text when changing this code; attachments can be binary.

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
Use a 32-byte hex key:

```bash
openssl rand -hex 32
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
- Confirm SES production access if needed.
- Run a full send-forward-reply test.
- Monitor SES bounces, complaints, and quotas.
