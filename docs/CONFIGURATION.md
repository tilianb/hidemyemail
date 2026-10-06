# Configuration

This page lists the runtime settings used by HideMyEmail.

The system-settings editor saves only changed values. Mail configuration
changes request fresh authentication when needed. An empty credential override
disables inheritance; **Use environment** removes the override instead. The UI
never returns stored SMTP credentials. Settings JSON must be an object whose
values are strings or `null` (reset); malformed values return HTTP 400.

In **Admin → System Settings**, use the section buttons to jump to mail,
limits, account defaults, filtering, or test mail. **Discard changes** restores
the saved values without writing to the server. Save or discard a draft before
using **Use environment** or sending a test email. SMTP transport/listener
changes need a Docker restart before testing. Test success confirms provider
acceptance, not delivery to the recipient's inbox.

The **Users** panel supports name and exact user-ID search (with or without `#`).
If the dashboard cannot load admin data or alias creation options, retry from
the error banner rather than treating the missing data as an empty account.

For maintainers, `SETTING_DEFINITIONS` in `worker/src/config.ts` owns defaults,
field validation, environment names, and secret/fresh-auth classifications.
The settings route retains checks that require database state or multiple
fields. This refactor does not change existing setting defaults or introduce
new environment overrides for legacy policy settings.

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
| `BLOCKED_SUBDOMAINS` | no | Comma-separated exact DNS labels that cannot be claimed as new personal subdomains. An absent or whitespace-only value uses `admin,api,www,dev,mail,smtp,imap,pop,pop3,webmail,autoconfig,autodiscover`; a nonblank value replaces that default list. Entries are trimmed and lowercased; requests are likewise trimmed and lowercased before exact matching, so `api` does not block `myapi` or `api2`. Each nonempty component must be a single 1–63 character ASCII DNS label containing only letters, digits, and interior hyphens, and starting and ending alphanumeric. Empty components, dots, wildcards, regex/glob syntax, underscores, embedded spaces, edge hyphens, and overlong labels make the configuration malformed. Malformed nonempty configuration fails closed: new claims return a server configuration error until the value is corrected, while the raw value is never logged. Valid blocked labels return “Subdomain is not available.” This affects only new claims: existing subdomains remain visible, editable, and deletable. Set this plain variable in the Cloudflare dashboard / Wrangler config or as `BLOCKED_SUBDOMAINS` in Docker. |
| `SES_REGION` | for SES | AWS SES/S3/SNS region, for example `ap-southeast-2`. |
| `INBOUND_MX_HOST` | no | Exact public MX host for SES or external-gateway reception. Empty preserves the SES target derived from `SES_REGION`. Built-in reception automatically uses `MAIL_HOSTNAME`. |
| `OUTBOUND_SPF_INCLUDE` | no | Exact supplier domain used in the SPF `include:` mechanism for SES or provider SMTP. Empty preserves `amazonses.com`. Direct sending automatically uses `a:MAIL_HOSTNAME` instead. |
| `MAIL_INBOUND_PROVIDER` | no | `ses` (default), Docker `builtin`, or advanced `gateway`. A D1 admin override wins over this environment default. |
| `MAIL_OUTBOUND_PROVIDER` | no | `ses` (default), Docker `smtp`, or Docker `direct`. Provider SMTP works on 587/465 when outbound port 25 is blocked. |
| `MAIL_HOSTNAME` | for built-in/direct | Canonical lowercase mail hostname with A/AAAA records pointing to the Docker server. Direct sending also needs matching PTR/reverse DNS. |
| `SMTP_OUTBOUND_HOST`, `SMTP_OUTBOUND_PORT` | for custom SMTP | Supplier or private relay endpoint. |
| `SMTP_OUTBOUND_TLS` | for custom SMTP | `starttls` (required upgrade, normally 587), `implicit` (normally 465), or `trusted-cleartext` for an explicitly trusted port-25 connector only. Certificate verification never downgrades. |
| `SMTP_OUTBOUND_TLS_SERVERNAME` | when outbound host is an IP | DNS name used for SMTP certificate verification. Environment-only. |
| `SMTP_OUTBOUND_USERNAME`, `SMTP_OUTBOUND_PASSWORD` | if relay requires auth | SMTP credentials, independent from inbound listener credentials. |
| `SMTP_INBOUND_ENABLED` | for external gateway | Must be `true` with `MAIL_INBOUND_PROVIDER=gateway`; lets operators stage gateway settings without opening the listener. Built-in reception does not use it. |
| `SMTP_INBOUND_HOST`, `SMTP_INBOUND_PORT`, `SMTP_INBOUND_TLS` | for SMTP ingress | Internal listener bind and port. Built-in reception uses `0.0.0.0:2525`, published as host port 25 by `docker-compose.mail.yml`; gateway mode defaults private. |
| `SMTP_INBOUND_USERNAME`, `SMTP_INBOUND_PASSWORD`, `SMTP_INBOUND_GATEWAY_ID` | for SMTP ingress | Dedicated upstream-gateway authentication and stable dedup namespace. Never reuse outbound credentials. |
| `SMTP_INBOUND_TRUSTED_PEERS` | recommended | Comma-separated exact socket peer IPs. Authentication remains mandatory. |
| `SMTP_INBOUND_TLS_CERT`, `SMTP_INBOUND_TLS_KEY` | non-loopback ingress | Deployment-managed PEM paths. The UI cannot choose arbitrary filesystem paths. |
| `SMTP_INBOUND_MAX_BYTES` | no | Maximum raw SMTP message size in bytes. Empty or invalid values use 25 MiB. |
| `SMTP_LISTEN_IP`, `SMTP_INBOUND_PUBLIC_PORT` | no | Host bind address and public port used only by `docker-compose.mail.yml`. Defaults to `0.0.0.0:25`. These do not change the listener inside the container. |
| `MAIL_QUEUE_MAX_BYTES` | no | Maximum encrypted built-in/direct queue size. Defaults to 1 GiB. |
| `RSPAMD_URL`, `CLAMAV_HOST`, `CLAMAV_PORT` | no | Private bundled-scanner endpoints. Defaults match the mail Compose overlay. Do not publish them. |
| `S3_INBOUND_BUCKET` | for SES inbound | Bucket where SES stores raw MIME. |
| `SNS_INBOUND_TOPIC_ARN` | for SES inbound | Exact SNS topic for SES receipt notifications. |
| `SNS_ALLOWED_TOPIC_ARN` | for SES outbound feedback | Exact SNS topic for SES bounce and complaint notifications. Topic ARNs identify webhook authority but are not secrets. |
| `APP_ORIGIN` | required for passkeys | Exact browser-visible dashboard origin, e.g. `https://app.hidemyemail.dev`. WebAuthn always derives its RP ID and expected origin from this value, never request headers. Production origins must use HTTPS and contain no path, query, fragment, credentials, or trailing slash; HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1` development. Docker deployments must set the externally visible origin explicitly in `docker/.env` to enable passkeys; ordinary authentication and mail continue to work when it is unset. |
| `APPLE_APP_ID` | for iOS passkeys | Apple App ID `<TeamID>.<bundleId>` (e.g. `ABCDE12345.dev.hidemyemail.app`) published in `/.well-known/apple-app-site-association`. The AASA route 404s until this is set. |
| `ANDROID_APP_ORIGINS` | for native Android passkeys | Comma-separated WebAuthn APK origins in the form `android:apk-key-hash:<base64url SHA-256 signing-certificate digest>`. Values authorize native registration and token-mode authentication assertions, and publish matching colon-delimited fingerprints at `/.well-known/assetlinks.json`; malformed nonempty configuration fails closed. Browser assertions accept only canonical `APP_ORIGIN`. Include both old and new certificate origins during a signing-key rotation. This is not needed for the authenticated browser handoff used by self-hosted mobile clients. |
| `APNS_KEY_ID` | for iOS push | 10-char Key ID of the APNs `.p8` signing key. |
| `APNS_TEAM_ID` | for iOS push | Apple Developer Team ID. Falls back to the `<TeamID>` prefix of `APPLE_APP_ID` if unset. |
| `APNS_BUNDLE_ID` | for iOS push | APNs topic (the app bundle id, e.g. `dev.hidemyemail.app`). Falls back to the `<bundleId>` suffix of `APPLE_APP_ID`. |
| `APNS_HOST` | optional | Override the APNs host. Defaults to `api.push.apple.com`; use `api.sandbox.push.apple.com` for development-signed builds. |
| `FCM_PROJECT_ID` | optional (Android push) | Firebase project id. Falls back to the `project_id` inside `FCM_SERVICE_ACCOUNT` when unset. |

`worker/wrangler.jsonc` sets `keep_vars: true` so dashboard-managed variables are preserved even when Cloudflare Git deploys run plain `wrangler deploy`.

Derive an Android APK origin from the certificate that signs the release APK:

```bash
digest=$(apksigner verify --print-certs app-release.apk \
  | sed -n 's/^Signer #1 certificate SHA-256 digest: //p')
printf 'android:apk-key-hash:'
printf '%s' "$digest" | xxd -r -p | openssl base64 -A \
  | tr '+/' '-_' | tr -d '='
printf '\n'
```

After deployment, verify `/.well-known/assetlinks.json` returns package
`dev.hidemyemail.app` with the expected release-certificate fingerprint before
offering native Android passkey enrollment.

## Worker secrets

Set with `wrangler secret put`.

| Name | Required | Purpose |
|------|----------|---------|
| `SES_ACCESS_KEY_ID` | for SES | AWS access key for SES send and S3 read. |
| `SES_SECRET_ACCESS_KEY` | for SES | AWS secret access key. |
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
npm run setup   # new deployments only; never key rotation
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

## Pre-v1.3 encryption preflight

Run this preflight while v1.2.1 is still deployed. First export D1 and preserve
the original encryption key from your secure backup:

```bash
cd worker
umask 077
backup_dir="$(mktemp -d "$HOME/hidemyemail-backup.XXXXXX")"
npx wrangler d1 export DB --remote --output "$backup_dir/hidemyemail-v1.2.1-backup.sql"
```

Keep this protected backup directory outside the repository and outside version
control.

Cloudflare secrets cannot be read back. If the original
`DESTINATION_ENCRYPTION_KEY` is not available from a secure backup, stop and
stay on v1.2.1. Validate a locally supplied key without printing or logging it:

```bash
printf 'DESTINATION_ENCRYPTION_KEY: ' >&2
IFS= read -rs DESTINATION_ENCRYPTION_KEY
printf '\n' >&2
export DESTINATION_ENCRYPTION_KEY
node -e '
const v = process.env.DESTINATION_ENCRYPTION_KEY;
const b = Buffer.from(v, "base64");
if (b.length !== 32 || b.toString("base64") !== v) process.exit(1);
'
unset DESTINATION_ENCRYPTION_KEY
```

Exit status 0 means canonical Base64 decoding to exactly 32 bytes. Before
continuing, verify account export succeeds, TOTP login succeeds if enabled, and
send test mail if the `ses_secret_access_key` DB override is configured. Then
check for legacy plaintext hashes:

```bash
npx wrangler d1 execute DB --remote --command "SELECT COUNT(*) AS plaintext_destination_hashes FROM destinations WHERE email_hash LIKE '%@%';"
npx wrangler d1 execute DB --remote --command "SELECT COUNT(*) AS plaintext_alias_hashes FROM aliases WHERE destination_hash LIKE '%@%';"
npx wrangler d1 execute DB --remote --command "SELECT COUNT(*) AS plaintext_domain_hashes FROM domains WHERE default_destination_hash LIKE '%@%';"
```

All three counts must be zero. Any failed check, unknown key history, or nonzero
count means stop and remain on v1.2.1. Never generate a new key as a repair.
Data written with one stable canonical 32-byte key remains compatible; v1.3
does not provide automated key rotation or migration for unsupported configs.

## Database settings

The app stores feature settings in D1. Important defaults:

| Setting | Public default | Notes |
|---------|----------------|-------|
| `registration_enabled` | `false` | Enable only if other users should self-register. |
| `cors_allowed_domains` | `http://localhost:5173` | Add deployed dashboard origins if needed. |
| `main_global_domain` | empty | Set after verifying a global domain. |
| `inbound_mx_host` | empty | Exact inbound MX target checked for global domains, wildcard MX, and personal subdomains. Empty derives the SES regional inbound host. Environment source: `INBOUND_MX_HOST`. |
| `outbound_spf_include` | empty | Exact outbound SPF include target checked during global-domain verification. Empty uses `amazonses.com`. Environment source: `OUTBOUND_SPF_INCLUDE`. |
| `catch_all_auto_create` | enabled | Allows first inbound mail to create aliases. |
| `max_inbound_bytes` | `26214400` (25 MiB) | Hard cap applied to inbound MIME before routing and reply parsing. SES streams to this limit from S3; SMTP listeners also enforce `SMTP_INBOUND_MAX_BYTES`. |
| `rate_limit_per_alias` | `20` | Maximum inbound forwards per alias in the rolling one-hour window. |
| `rate_limit_reply_per_alias` | `10` | Maximum replies per alias in the rolling one-hour window. |
| `rate_limit_global` | `1000` | Maximum combined forwards and replies in the rolling one-hour window. |
| `reply_distinct_recipient_cap` | `15` | Maximum distinct external recipients per alias in 24 hours. Existing contacts remain allowed. |
| `spam_verdict_action` | `flag` | Action when the inbound provider marks mail as spam: `forward`, `flag` (adds `X-Spam-Flag: YES`), or `drop`. Your domain DKIM-signs forwarded spam. Forwarding it untouched damages your sender reputation. |
| `virus_verdict_action` | `drop` | Same options for inbound malware verdicts. |
| `unsubscribe_header_mode` | `bulk_only` | When to add the one-click List-Unsubscribe to forwards: `always`, `bulk_only` (when the original carried List-Unsubscribe or `Precedence: bulk`), or `never`. Adding it to personal mail makes forwards look like bulk mail to spam filters. |
| `soft_bounce_threshold` | `3` | Soft bounces within 24h before a destination is paused (0 disables). |

Most settings are editable from the Admin dashboard.
Mail transport settings follow **explicit database override → environment →
default** precedence. The API never returns SMTP credentials. Leaving a masked
credential unchanged preserves it; resetting an override restores the env
credential. Explicitly saving both credential fields empty disables inherited
SMTP authentication; resetting them restores the environment values. SMTP
usernames and passwords stored in D1 are encrypted with
`DESTINATION_ENCRYPTION_KEY`. The API returns only configured state, never an
environment or decrypted credential. Docker SMTP transport and listener
changes are saved as configured state and become active only after a restart.

## Custom SMTP recipes

Set `MAIL_OUTBOUND_PROVIDER=smtp`, then use any standards-compliant SMTP relay:

| Supplier | Host | Port/TLS | Authentication and sender requirements |
|---|---|---|---|
| [Resend](https://resend.com/docs/send-with-smtp) | `smtp.resend.com` | 587/STARTTLS or 465/implicit | Username `resend`, API key as password; [verify each sending domain](https://resend.com/docs/dashboard/domains/introduction). |
| [Mailchimp Transactional (Mandrill)](https://mailchimp.com/developer/transactional/docs/smtp-integration/) | `smtp.mandrillapp.com` | 587/STARTTLS or 465/implicit | Primary contact email as username, Transactional API key as password; verify/sign sending domains. This is not Mailchimp's marketing API. |
| [SendGrid](https://www.twilio.com/docs/sendgrid/for-developers/sending-email/integrating-with-the-smtp-api) | `smtp.sendgrid.net` | 587/STARTTLS or 465/implicit | Literal username `apikey`, scoped API key as password; complete domain authentication or Single Sender verification. |
| [Mailgun](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-smtp) | `smtp.mailgun.org` (US) or `smtp.eu.mailgun.org` (EU) | 587/STARTTLS or 465/implicit | Use per-domain **SMTP credentials**, not an HTTP API key; verify the sending domain. |

These recipes use the same raw-MIME SMTP implementation, not supplier-specific
adapters. Disable click/open tracking in each supplier dashboard for forwarding
privacy. HideMyEmail strips `Resend-Idempotency-Key`, `X-MC-*`, SendGrid
`X-SMTPAPI`, and `X-Mailgun-*` from inbound mail before submission so external
senders cannot inject recipients, tracking, tags, routing, or dedup controls.
Provider acceptable-use rules and dynamic alias From-address policies vary;
the project validates protocol integration but has not live-tested account
acceptance. SMTP suppliers do not provide SES feedback webhook parity.

## Docker SMTP reception

See [Mail providers](MAIL_PROVIDERS.md) for complete built-in receiver,
external-gateway, provider SMTP, direct-delivery, DNS, and cutover instructions.

### Built-in Docker receiving

The simplest Docker setup accepts Internet mail in HideMyEmail itself. Set
`MAIL_INBOUND_PROVIDER=builtin` and a canonical `MAIL_HOSTNAME`, publish the
mail Compose overlay's port 25, and point the alias domains' MX records at that
hostname. The listener rejects unknown recipients before DATA. After DATA, it
atomically stores the full message and SMTP envelope in an AES-256-GCM encrypted
queue before replying `250`. Rspamd, ClamAV, and SPF/DKIM/DMARC checks run from
that queue. Scanner or forwarding outages retry without asking the sender to
resubmit. Standard null-return-path delivery-status messages are accepted. Queue
files and generated direct-delivery DKIM private keys use the
instance destination-encryption key and do not expose addresses in file names.

Inbound and outbound port 25 are different network directions. A provider can
allow incoming mail while blocking direct sending. Use custom outbound SMTP on
587/STARTTLS or 465/TLS in that case. `MAIL_OUTBOUND_PROVIDER=direct` is optional
and requires outbound port 25, matching A/AAAA and PTR records, SPF for the
server IP, and every DKIM TXT record shown in Admin. The direct sender follows
MX priority, rejects private/reserved DNS targets, enforces MTA-STS policies,
uses verified opportunistic TLS, and keeps temporary or uncertain deliveries
in the encrypted queue.

Start the receiver and bundled scanners with:

```bash
cd docker
docker compose -f docker-compose.yml -f docker-compose.mail.yml up -d
```

ClamAV requires about 3–4 GB RAM. Its first signature download can delay virus
scanner readiness. Without the mail overlay, the base Compose file does not
claim host port 25 or start either scanner.

### Advanced external gateway

The Docker listener is a private handoff point for incoming alias mail. A
separate public mail gateway (MTA, or mail transfer agent) receives mail for
your domain, checks and scans it, then sends it to the listener. HideMyEmail
looks up the alias and forwards the message to its destination through your
configured outbound SES or SMTP provider. You do not enter an inbox password
or fetch messages from IMAP/POP. Enabling this listener alone does not set up
the public gateway or its scan-result integration.

In admin settings, **Listener size limit (MB)** accepts fractional values and
uses 1,048,576 bytes per MB (MiB), matching the instance-wide inbound size
field. The API and `SMTP_INBOUND_MAX_BYTES` environment variable still use
bytes; leaving the admin field empty uses 25 MiB. Both inbound size limits
apply. Save listener changes, then restart the Docker service to activate them.

Run a public MTA such as [Stalwart](https://stalw.art/docs/mta/overview/) on MX
port 25. It must queue retries durably, validate SPF and DMARC, scan spam and
malware, strip sender-supplied `X-HideMyEmail-Gateway-Result`, add the exact
contract documented in the [mail provider guide](MAIL_PROVIDERS.md#2-add-the-gateway-verdict-header), and
relay one envelope recipient per transaction to HideMyEmail with dedicated
AUTH and TLS. HideMyEmail waits for processing before `250`; a 4xx leaves the
message in the upstream queue. Do not expose the gateway-mode handoff listener
as a public MX. For public reception, use built-in mode or the supplied
[reference gateway Compose stack](MAIL_PROVIDERS.md#reference-gateway-compose-stack).
Ports 465/587 are secure relay/submission
options, not alternate public MX ports. Configure `INBOUND_MX_HOST` with this
gateway's actual public MX name; the private HideMyEmail listener is not an MX
target. The outbound provider supplies the DKIM records for its sending domain.
The listener still rejects null-envelope-sender DSNs; do not route DSNs to it.

### Stalwart gateway recipe

Follow the [Stalwart setup map](MAIL_PROVIDERS.md#4-stalwart-setup-map) for the
public listener, trusted verdict hook, relay route, and retry checks. Use your
installed Stalwart release's current configuration reference; these objects and
verdict APIs vary by version. The repository does not bundle a Stalwart hook.
Keep gateway ingress disabled until your integration emits the tested contract.
For a supplied Compose example instead, use the
[reference gateway](MAIL_PROVIDERS.md#reference-gateway-compose-stack).

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
