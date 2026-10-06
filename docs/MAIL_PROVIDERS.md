# Mail providers

HideMyEmail selects inbound and outbound mail providers independently. AWS SES
remains the default. Docker can receive mail itself, accept it from an external
gateway, send through a standard SMTP relay, or deliver to recipient MX servers.

## Supported combinations

| Runtime | Inbound | Outbound |
|---|---|---|
| Cloudflare Worker | AWS SES → S3 → SNS | AWS SES |
| Docker | AWS SES, built-in SMTP, or external gateway | AWS SES, provider SMTP, or direct-to-MX |

Cloudflare Workers cannot listen for inbound SMTP or connect to outbound port
25. This project implements custom SMTP through Docker's private transport
binding, not a Worker-native socket adapter. A Cloudflare deployment configured
for a Docker-only provider returns an error instead of falling back to SES.

Set providers in `docker/.env` before the first start, or in **Admin → System
Settings → Mail**. Database settings override environment values. **Use
environment** removes an override. Restart the app container after changing a
mail provider, transport, or listener.

After an Admin change, run `docker compose restart app`. After editing `.env`,
run `docker compose up -d --force-recreate app`; a plain restart does not reload
the container environment. Include the same Compose files you used to start the
stack, including the mail overlay for built-in reception.

## Provider SMTP outbound

Use this when a supplier accepts SMTP on port 587 or 465. It works with any
inbound provider, including built-in reception when the host blocks outbound
port 25.

```dotenv
MAIL_OUTBOUND_PROVIDER=smtp
SMTP_OUTBOUND_HOST=smtp.example.com
SMTP_OUTBOUND_PORT=587
SMTP_OUTBOUND_TLS=starttls
SMTP_OUTBOUND_USERNAME=account-name
SMTP_OUTBOUND_PASSWORD=replace-me
OUTBOUND_SPF_INCLUDE=spf.example.com
```

Choose `starttls` for a required STARTTLS upgrade or `implicit` for TLS from
connection start. HideMyEmail verifies the server certificate and does not
downgrade. If `SMTP_OUTBOUND_HOST` is an IP address, set
`SMTP_OUTBOUND_TLS_SERVERNAME` to the certificate's DNS name. Set username and
password together, or leave both empty for a relay that authenticates by
network identity.

`trusted-cleartext` is limited to port 25 and should only connect to a private,
trusted relay. It does not disable certificate checks for either TLS mode.

Verify every alias domain with the supplier. Publish its SPF include and DKIM
records, then disable click/open tracking if the supplier enables it. The
dashboard verifies the exact `OUTBOUND_SPF_INCLUDE`; it cannot infer or verify
supplier DKIM records. Resend, Mailchimp Transactional, SendGrid, and Mailgun
examples are listed in [Configuration](CONFIGURATION.md#custom-smtp-recipes).

## Built-in Docker reception

Built-in reception provides the shortest non-AWS inbound setup. HideMyEmail
accepts public SMTP, rejects unknown recipients before DATA, writes accepted
mail to an encrypted retry queue, and then runs SPF, DKIM, DMARC, Rspamd, and
ClamAV checks.

1. Set the receiver and hostname in `docker/.env`:

   ```dotenv
   MAIL_INBOUND_PROVIDER=builtin
   MAIL_HOSTNAME=mail.example.com
   SMTP_INBOUND_HOST=0.0.0.0
   SMTP_INBOUND_PORT=2525
   ```

2. Point an A and/or AAAA record for `mail.example.com` at the Docker host.
3. Point each alias domain's MX record at `mail.example.com`.
4. Allow inbound TCP port 25 through the provider and host firewalls.
5. Start the mail overlay:

   ```bash
   cd docker
   docker compose -f docker-compose.yml -f docker-compose.mail.yml up -d
   ```

The overlay publishes host port 25 to the app's port 2525 and starts Rspamd and
ClamAV. ClamAV needs about 3–4 GB of available RAM and may need several minutes
to download signatures after its first start. Do not use the mail overlay for
external-gateway mode because that would expose the trusted handoff listener as
a public MX endpoint.

## External SMTP gateway

Gateway mode separates the public receiver from the app. Use the reference
Compose stack below, or integrate an existing public MTA such as Stalwart or
Maddy using the contract in the following sections. The public receiver owns
MX port 25, durable retries, sender authentication, and content scanning. It
relays alias mail to HideMyEmail's private, authenticated SMTP listener.

```text
Internet sender
      │ SMTP :25
      ▼
Public gateway / MTA ── authenticated SMTP + TLS ──▶ HideMyEmail :2525
queue + scan + auth         one recipient/message       private listener
                                                               │
                                                               ▼
                                                  SES / SMTP / direct outbound
```

### Reference gateway Compose stack

[`docker/docker-compose.gateway.yml`](../docker/docker-compose.gateway.yml)
starts four services: the app, a standalone HideMyEmail gateway, Rspamd, and
ClamAV. Both app and gateway use the named image
`docker.io/tilianb/hidemyemail:${IMAGE_TAG:-latest}`. Set
`IMAGE=ghcr.io/tilianb/hidemyemail` to use GHCR. Pin a validated release tag for
production; Rspamd and ClamAV already have version pins in the overlay.

**This gateway entrypoint is unreleased. Build from this branch with the
commands below until a release includes it. An older `latest` image cannot run
`gateway-server.mjs`.**

1. Complete the [Docker app setup](../docker/README.md), including app secrets,
   `APP_ORIGIN`, an outbound provider, and alias domains in the dashboard.
   Add these values to `docker/.env`:

   ```dotenv
   GATEWAY_HOSTNAME=mx.example.com
   GATEWAY_DOMAINS=example.com,aliases.example.net
   GATEWAY_QUEUE_KEY=<output-of-openssl-rand-base64-32>
   SMTP_INBOUND_USERNAME=hidemyemail-gateway
   SMTP_INBOUND_PASSWORD=<output-of-openssl-rand-hex-32>
   SMTP_INBOUND_GATEWAY_ID=reference-1
   IMAGE=hidemyemail-gateway-local
   IMAGE_TAG=review
   PULL_POLICY=never
   ```

   Generate the queue key with `openssl rand -base64 32` and the relay password
   with `openssl rand -hex 32`. Preserve the queue key with your gateway-volume
   backup. Do not reuse `DESTINATION_ENCRYPTION_KEY`. The overlay sets gateway
   mode and listener enablement on the app; existing Admin overrides still win.
   Reset conflicting provider/listener overrides to **Use environment**.

   List each alias domain exactly, including personal subdomains. Wildcards do
   not match. This allowlist prevents open relaying, but the reference gateway
   checks only domains at public RCPT time. The app checks active aliases and
   catch-all rules during private handoff. An unknown alias therefore becomes
   a retained failed queue item after a private `550`, rather than a public
   RCPT rejection. No automatic bounce is sent.

2. Create the private handoff certificate from `docker/`:

   ```bash
   mkdir -p secrets
   chmod 700 secrets
   openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
     -subj '/CN=app' -addext 'subjectAltName=DNS:app' \
     -keyout secrets/handoff-key.pem -out secrets/handoff-cert.pem
   sudo chown 65532:65532 secrets/handoff-key.pem
   sudo chmod 400 secrets/handoff-key.pem
   chmod 644 secrets/handoff-cert.pem
   ```

   For rootless Docker, map UID 65532 to the host UID that your runtime uses.
   Only the app mounts the private key. The gateway trusts the mounted public
   certificate and verifies the `app` DNS name during required STARTTLS. This
   self-signed certificate is a dedicated private trust anchor, not a public
   MX certificate. Renew it before expiration, keep the same SAN, and recreate
   both services after replacing the mounted files. Do not disable TLS checks.
   Never commit `secrets/` or a populated `.env`.

3. Build and start the stack from `docker/`. Do **not** include
   `docker-compose.mail.yml`:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.gateway.yml config --quiet
   docker compose -f docker-compose.yml -f docker-compose.gateway.yml build app gateway
   docker compose -f docker-compose.yml -f docker-compose.gateway.yml up -d
   docker compose -f docker-compose.yml -f docker-compose.gateway.yml logs -f app gateway rspamd clamav
   ```

   Only the gateway publishes SMTP port 25. The app's port 2525 and scanner
   ports stay inside the Compose network; the HTTP dashboard stays on
   loopback. ClamAV needs about 3–4 GB of available RAM and time to download
   signatures. A healthy gateway listener does not prove scanners are ready.

4. Set an A/AAAA record for `GATEWAY_HOSTNAME`, allow public inbound TCP 25, and
   test before changing MX records. The overlay sets `INBOUND_MX_HOST` to this
   hostname. Configure provider SMTP on 587/465 or SES for forwarding when
   outbound TCP 25 is blocked. Gateway reception does not require outbound 25.

The reference gateway fsyncs its encrypted queue before returning SMTP `250`.
It checks the original client IP/HELO/envelope with mailauth, scans with Rspamd
and ClamAV, removes forged control headers, and uses the durable queue ID for
private handoff. Scanner errors or incomplete virus results stay queued; threat
results use `FAIL` so the app applies its configured drop/tag policy. The queue
retries temporary failures and retains permanent or expired items for operator
review. Gateway logs report queue counts without MIME, envelopes, or credentials.
The dashboard reports the app's queue, not this separate gateway queue.

This is a receive-only reference gateway, not a mailbox server or a Stalwart
adapter. It supports one recipient per transaction, rejects null return paths,
does not provide public STARTTLS, and does not issue delivery-status bounces.
Use built-in reception for null-envelope delivery reports, or an operator-managed
MTA when you need these features. Review failed counts and capacity before using
the reference gateway for production traffic.

Back up the `gateway-data` volume and `GATEWAY_QUEUE_KEY` together, separately
from the app volume and its key. Each queue defaults to a 1 GiB capacity; failed
items consume capacity. After editing `.env` or renewing certificates, include
both Compose files and run `up -d --force-recreate app gateway`. Keep gateway
credentials aligned with any app-side Admin overrides.

### 1. Configure HideMyEmail

Generate dedicated credentials. Do not reuse the outbound SMTP credentials.

```dotenv
MAIL_INBOUND_PROVIDER=gateway
SMTP_INBOUND_ENABLED=true
SMTP_INBOUND_HOST=0.0.0.0
SMTP_INBOUND_PORT=2525
SMTP_INBOUND_TLS=starttls
SMTP_INBOUND_USERNAME=hidemyemail-gateway
SMTP_INBOUND_PASSWORD=replace-with-a-long-random-value
SMTP_INBOUND_GATEWAY_ID=stalwart-1
SMTP_INBOUND_MAX_BYTES=26214400
INBOUND_MX_HOST=mx.example.com
SMTP_INBOUND_TLS_CERT=/run/secrets/smtp-cert.pem
SMTP_INBOUND_TLS_KEY=/run/secrets/smtp-key.pem
```

Keep `SMTP_INBOUND_GATEWAY_ID` stable. HideMyEmail combines it with the gateway
queue ID and recipient to deduplicate retries. A changed ID creates a new
deduplication namespace.

The listener requires certificate and key files when it binds outside
loopback. Mount read-only PEM files into the app container with a Compose file:

```yaml
services:
  app:
    volumes:
      - hidemyemail-data:/data
      - ./secrets/smtp-cert.pem:/run/secrets/smtp-cert.pem:ro
      - ./secrets/smtp-key.pem:/run/secrets/smtp-key.pem:ro
```

For an operator-managed MTA, save this mounts-only snippet as
`docker/docker-compose.gateway-tls.yml` and run:

```bash
cd docker
docker compose -f docker-compose.yml -f docker-compose.gateway-tls.yml up -d
```

Allow the app's non-root UID 65532 to read the files. Protect the private key
from other users. Deploy your own certificate, including its chain; the
listener's built-in test certificate is not safe for production. Restart the
app after renewing the mounted certificate or key.

Run the gateway in the same private Compose network and connect it to
`app:2525`. Do not publish 2525 on the host. If the gateway runs on another
machine, publish 2525 only on a private interface and restrict it with a
firewall to the gateway address. Use a certificate valid for the DNS name the
gateway connects to.

`SMTP_INBOUND_TRUSTED_PEERS` adds an exact socket-IP allowlist. Authentication
remains mandatory. Container addresses often change, so assign stable private
addresses before enabling this check. The setting accepts individual IP
addresses, not CIDR ranges.

### 2. Add the gateway verdict header

Before relaying, the gateway must:

1. Remove every sender-supplied `X-HideMyEmail-Gateway-Result` header.
2. Check SPF against the SMTP envelope sender and DMARC against the message
   `From` header.
3. Run spam and virus scanning.
4. Add exactly one header with these six fields:

   ```text
   X-HideMyEmail-Gateway-Result: v=1; id=<queue-id>; spf=PASS; dmarc=PASS; spam=PASS; virus=PASS
   ```

The `id` must be the durable queue item's stable, unique ID. It may contain 1
to 200 letters, digits, dots, underscores, colons, or hyphens. Do not use the
message's `Message-ID`, which a sender controls.

Each verdict must be one of `PASS`, `FAIL`, `GRAY`, `PROCESSING_FAILED`, or
`DISABLED`. Missing fields, extra fields, duplicate control headers, or unknown
values cause SMTP rejection. HideMyEmail strips the control header before
forwarding the message. SMTP authentication alone never creates a `PASS`
verdict.

For spam and virus fields, use `PASS` for a completed clean scan and `FAIL` for
a detected threat. Only `FAIL` triggers HideMyEmail's `spam_verdict_action` or
`virus_verdict_action`; `GRAY`, `PROCESSING_FAILED`, and `DISABLED` do not stop
ordinary forwarding. Your gateway must retain or reject mail when scanners fail
instead of relaying a placeholder verdict. For replies, HideMyEmail requires
SPF or DMARC `PASS` bound to a verified owner destination plus prior inbound
contact with the external recipient.

### 3. Configure gateway relay behavior

Configure the gateway to:

- accept public mail only for HideMyEmail alias domains;
- preserve the original SMTP envelope sender and recipient;
- send one envelope recipient per SMTP transaction;
- require STARTTLS or implicit TLS and verify the listener certificate;
- authenticate with the dedicated listener username and password;
- keep mail queued when HideMyEmail returns a 4xx response; and
- stop retrying a recipient when HideMyEmail returns a permanent 5xx response.

The listener checks each recipient against active HideMyEmail domains,
aliases, and catch-all rules before DATA. It returns `250` only after the Worker
finishes processing. A response lost after acceptance can produce one delayed
duplicate after the delivery fence expires.

Processing may intentionally drop mail because of sender rules, malware policy,
disabled forwarding, or quotas. A `250` confirms processing or outbound queue/
provider acceptance, not final inbox delivery.

The gateway listener rejects null-envelope-sender delivery status notifications
(`MAIL FROM:<>`). Do not route DSNs to it. Built-in reception accepts null
return paths.

### 4. Stalwart setup map

Stalwart configuration keys change between releases. Use its current WebUI and
documentation rather than pasting an old flat configuration:

1. Create a public SMTP listener on port 25 for the alias domains. Enable SPF,
   DMARC, spam, and malware checks during inbound processing.
2. Add a trusted DATA-stage Sieve system script that removes
   `X-HideMyEmail-Gateway-Result` before any trusted hook adds it.
3. Add the contract header from a DATA-stage MTA hook or filter. Generate the
   durable queue ID before Stalwart queues the modified message. A Sieve-only
   setup cannot meet the contract unless the installed Stalwart release exposes
   a stable queue ID and all four scan verdicts to Sieve.
4. Create an SMTP relay route to the private HideMyEmail listener. Enable TLS
   certificate validation, SMTP authentication, and one-recipient transactions.
   Select the route only for HideMyEmail domains.
5. Keep Stalwart's virtual queue and retry schedule enabled. Before changing
   MX records, verify a simulated HideMyEmail `451` stays queued and a `250`
   removes the item.

The repository does not ship a Stalwart verdict-hook adapter. Do not enable the
gateway listener until your hook emits the exact tested contract.

### 5. Cut over and verify

Before changing MX records:

1. Restart HideMyEmail and confirm its log reports `SMTP ingress listening`.
2. Send a message through the gateway to a known alias. Confirm it forwards and
   the control header does not appear at the destination.
3. Test an unknown recipient and confirm the gateway records a permanent
   rejection.
4. Stop HideMyEmail, submit another test, and confirm the gateway queues it for
   retry. Start HideMyEmail and confirm one delivery.
5. Submit a message with a forged control header and confirm the gateway removes
   it before adding its own result.
6. Set the alias domain MX to the public gateway hostname and set
   `INBOUND_MX_HOST` to that same canonical hostname for dashboard DNS checks.

## Direct-to-MX outbound

Direct delivery removes the outbound relay but requires more mail-server
operations and a reputable static IP:

```dotenv
MAIL_OUTBOUND_PROVIDER=direct
MAIL_HOSTNAME=mail.example.com
```

Allow outbound TCP port 25. Configure matching A/AAAA and PTR records, publish
SPF with `a:mail.example.com`, and publish every `hme._domainkey` DKIM TXT record
shown in Admin after restart. HideMyEmail queues and DKIM-signs messages,
follows recipient MX priority, blocks private/reserved targets, verifies TLS
when the remote MX offers it, and enforces MTA-STS. Temporary and uncertain
deliveries remain encrypted in the queue for retry.

Provider SMTP is safer for most installations. New or residential IP addresses
often have poor reputation, and many hosts block outbound port 25.

## Operational limits

- HideMyEmail forwards mail; it does not provide an inbox, IMAP, or POP.
- SMTP provider feedback webhooks do not have SES bounce/complaint parity.
- `SMTP_INBOUND_MAX_BYTES` limits the listener DATA size. The independent
  `max_inbound_bytes` setting also limits Worker processing. Keep the listener
  limit at or below the Worker limit.
- `MAIL_QUEUE_MAX_BYTES` defaults to 1 GiB for the shared built-in inbound/direct
  outbound queue and, separately, for the reference gateway queue.
- Temporary queue failures retry with exponential backoff, up to one hour.
  Uncertain acceptance waits at least five minutes. After five days, the queue
  marks an item failed; permanent rejections also become failed items. The app
  retains these encrypted files for operator inspection, and they count toward
  capacity. The dashboard reports failed counts but offers no replay/delete
  operation. Do not delete files or change delivery IDs as a retry shortcut.
- Queue files and generated direct-delivery DKIM private keys use
  `DESTINATION_ENCRYPTION_KEY` in the app. The reference gateway uses its own
  `GATEWAY_QUEUE_KEY`. Back up each `/data` volume and preserve its key.

See [Troubleshooting](TROUBLESHOOTING.md#docker-smtp-or-mail-queue-fails) for
startup, TLS, scanner, and queue checks.
