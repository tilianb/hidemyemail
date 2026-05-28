# Security Policy

## Reporting a vulnerability

Please report security issues privately by email to the repository owner before opening a public issue. Include affected version or commit, reproduction steps, impact, and any suggested fix.

## Supported versions

Security fixes target the current `main` branch. Public releases should be tagged from `main` after CI passes.

## Security model

HideMyEmail is designed to avoid open-relay behavior:

- Inbound mail is received by AWS SES, stored in S3, and delivered to the Worker through SNS.
- SNS messages are signature-verified and restricted to configured topic ARNs.
- Raw MIME is fetched from S3 and only headers are rewritten; message body bytes are preserved.
- Replies through aliases require the sender to match a verified destination for the alias owner and require SES SPF or DMARC verdicts to pass for the authenticated principal.
- Destination emails are encrypted in D1 with `DESTINATION_ENCRYPTION_KEY`.
- Dashboard sessions use signed `__Host-` cookies and admin APIs require user id `1`.

## Operational responsibilities

- Keep `SESSION_SECRET`, `ACTION_SECRET`, `DESTINATION_ENCRYPTION_KEY`, and AWS credentials private.
- Use least-privilege AWS IAM credentials limited to SES send and S3 read for the inbound bucket.
- Configure exact `SNS_ALLOWED_TOPIC_ARN` and `SNS_INBOUND_TOPIC_ARN` values per environment.
- Disable public registration unless you intentionally run a multi-user instance.
- Monitor SES bounces, complaints, and quotas. Catch-all forwarding can consume SES quota when spam arrives.
