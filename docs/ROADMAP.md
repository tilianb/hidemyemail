# Roadmap

Tracked backlog of recommendations from the pre-v1 review (2026-06-10).
Organised by **recommended priority** — highest-leverage work first. Items are
removed when shipped; see CHANGELOG.md for what already landed.

## Recently shipped

- [x] **Push notifications — iOS APNs + Android FCM.** Worker dispatch routes
  per `push_devices.platform` (APNs for iOS, FCM HTTP v1 for Android); enable
  with the platform credentials (`APNS_*`, or `FCM_SERVICE_ACCOUNT` +
  `google-services.json`). Blocked / paused-destination on by default; forward /
  reply opt-in.

---

## P1 — Now (highest leverage)

- [ ] Request a listing in Bitwarden's forwarder docs now that the
  addy.io-compatible API surface has shipped (see docs/API.md).
- [ ] **Hosted push relay for self-hosters** _(push / self-hosting)_. Let
  self-hosted servers deliver notifications to the **official** App Store / Play
  Store apps without each operator obtaining their own APNs key and Firebase/FCM
  project. The official apps are signed with our bundle id, so only credentials
  tied to that bundle can push to them; a self-hoster's own APNs/FCM project
  can't. Plan: a small first-party relay endpoint (hosted by us) that the
  official apps register against and that self-hosted Workers forward push
  payloads to. Must be:
  - **Opt-in**, off by default, with a clear disclaimer — surfaced both in the
    **admin portal** (operator enables relaying for the deployment) and in
    **user Settings** (each user consents) — that notification metadata
    (e.g. alias address, sender, subject snippet) transits our relay.
  - Authenticated per deployment and rate-limited, carrying the minimum
    metadata needed to render the alert.
  - A drop-in alternative to self-managed `APNS_*` / `FCM_*`: when the relay is
    enabled, the Worker dispatches through it instead of direct APNs/FCM.

## Mail backends & provider flexibility

Today inbound is hard-wired to **AWS SES → S3 → SNS → Worker**
(`worker/src/lib/{ses,s3,sns}.ts`, `worker/src/email/inbound.ts`) and outbound
to SES **`SendRawEmail`**. Introduce a small provider abstraction so operators
can pick a backend that fits their stack and budget, then ship alternatives.
SES stays the default throughout — nothing existing breaks. Listed in priority
order (the abstraction is the enabler; later items get cheaper once it lands):

- [ ] **(P1) Provider abstraction layer.** Define `MailInbound` / `MailOutbound`
  interfaces and move the SES/S3/SNS specifics behind them, selected by a
  `MAIL_PROVIDER` setting. Foundational — unblocks every option below and is the
  single biggest lever for cutting the AWS-only setup barrier.
- [ ] **(P1–P2) Inbound via Cloudflare Email Routing (Email Workers)** — the
  **recommended first alternative to document**. Receive mail directly in the
  Worker — no SES receipt rules, no S3, no SNS. The biggest setup reduction for
  Cloudflare-hosted domains and squarely on the "no mail stack" thesis. Note the
  constraints (message-size cap; the domain must be on Cloudflare; reply-from
  path still needs an outbound sender).
- [ ] **(P2) Outbound via Resend** — recommended HTTP send provider: simple API,
  generous free tier, strong DX. A drop-in `MailOutbound` implementation behind
  the abstraction. Support other HTTP providers the same way — **Postmark**
  (deliverability-focused transactional), **Mailgun** / **SendGrid**
  (established) — with SES remaining the default.
- [ ] **(P2–P3) Inbound-only hosting + outbound via user-defined SMTP.** Keep the
  serverless inbound path (SES or Cloudflare Email Routing) but relay outbound
  through the operator's own SMTP server/mailbox. Feasible from the Worker via
  the `cloudflare:sockets` `connect()` API (STARTTLS), and from the Docker
  deployment via a Node SMTP client (e.g. nodemailer). Config: SMTP
  host/port/credentials + from-address.
- [ ] **(P3) Inbound via other providers' webhooks** (Resend inbound, Mailgun
  routes, Postmark inbound) for operators already standardised on them.
- [ ] **(P3, advanced) Full self-hosted mail server.** A "no third party at all"
  path using a modern single-binary stack — **Stalwart** or **Maddy** (preferred
  over Postfix + Dovecot) — driven through the same provider abstraction.
  Heaviest to operate and counter to the serverless thesis, so it stays an
  advanced opt-in rather than a recommended default.

> Open questions (happy to adjust): keep **SES as the shipped default**? Make
> **Resend** the first documented alternative? And is the **full mail-server**
> path worth tracking at all, or explicitly out of scope for this project?

## P2 — Next

- [ ] **Operator-defined blocked subdomains** _(security / self-hosting)_. Add
  an environment variable containing a comma-separated denylist of subdomain
  names or patterns that users may not claim (for example reserved service,
  brand, and infrastructure names). Normalize entries and requested names
  before matching, validate malformed patterns at startup, and apply the check
  before creating an ownership reservation.
- [ ] **Browser extension** (or interim bookmarklet) _(product)_. Generate an
  alias in signup forms without opening the dashboard. The daily-driver feature
  of SimpleLogin/addy.
- [ ] **In-dashboard "setup doctor"** _(self-hosting)_. An admin-panel health
  check that reports which secrets, DNS records, and AWS resources are missing
  or misconfigured, so onboarding is guided rather than doc-driven.
- [ ] **AWS infrastructure-as-code** _(self-hosting)_. A CloudFormation/Terraform
  template (or scripted `aws` flow) for the SES receipt rule set, S3 inbound
  bucket + policy, SNS topic + subscription, and the scoped IAM user — the
  largest manual surface today. Pair with the existing `ses-check.mjs` verifier.
- [ ] **Custom Domains (BYOD)** _(product / self-hosting)_. The schema already
  supports non-global, user-owned domains (`domains.user_id`, `is_global = 0`).
  Also moves SES identity creation into the dashboard, cutting manual AWS setup.
  - **AWS SES identities**: when a user adds a domain, the Worker calls SES
    (`CreateEmailIdentity`) to register it and retrieve the verification/DKIM
    DNS records. Needs `ses:CreateEmailIdentity`, `ses:GetEmailIdentity`,
    `ses:DeleteEmailIdentity` on the Worker's IAM user.
  - **Onboarding UI**: a setup wizard showing the required DNS records — MX to
    the SES inbound endpoint, TXT for domain verification, CNAMEs for Easy DKIM.
  - **Verification job**: a "Verify" button (or scheduled cron) that checks SES
    identity status and sets `domains.active = 1`.
  - **Catch-all support**: UI to set a `default_destination` for the custom
    domain, so any address there is received without pre-creating an alias.
  - **Alias generation context**: let the "New Alias" UI pick a verified custom
    domain from a dropdown, not just global system domains.
- [ ] **Share-to-mint-alias** so an alias can be generated from any app
  _(native apps)_.
  - iOS: Share extension.
  - Android: share-target activity.

## P3 — Later / opportunistic

- [ ] **AutoFill integration** so aliases can be generated inside the browser /
  signup forms without opening the app _(native apps)_.
  - iOS: AutoFill credential provider (works in Safari).
  - Android: Autofill service + Credential Manager provider.
- [ ] **Compose-as-alias** from the dashboard with explicit per-send
  confirmation _(product)_. The first-contact gate correctly blocks SMTP-level
  originate; a UI path keeps the anti-spam posture.
- [ ] **Import from SimpleLogin / addy.io CSV** — migration path for switchers
  _(product)_.
- [ ] **Fewer required variables / Docker easy-mode** _(self-hosting)_. Derive
  more values from fewer (extend the pattern where `APNS_TEAM_ID` /
  `APNS_BUNDLE_ID` fall back to `APPLE_APP_ID`), give every non-essential var a
  sane default, and document the Docker path as the canonical "easy mode" (it
  already reduces Cloudflare/D1 to a single container, leaving AWS as the only
  external dependency).
- [ ] **ARC sealing of forwards** instead of header stripping, once an ARC
  library is practical inside Workers _(deliverability)_.
- [ ] **Per-domain deliverability checklist** in the dashboard _(deliverability)_:
  custom MAIL FROM present, DMARC policy, Postmaster/SNDS enrolment status.
- [ ] **Traction** _(growth)_: dashboard screenshots / GIF in the README;
  submit to awesome-selfhosted, selfh.st, AlternativeTo; a "Email aliases
  without a mail server" blog post (SES + Workers) to r/selfhosted and Show HN,
  sequenced after the deliverability fixes; a hosted demo with a throwaway login.
