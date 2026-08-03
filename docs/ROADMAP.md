# Roadmap

Tracked backlog of recommendations from the pre-v1 review (2026-06-10).
Organised by **recommended priority** — highest-leverage work first. Items are
removed when shipped; see CHANGELOG.md for what already landed.

## Recently shipped

- [x] **v1.3.0 secure foundations and aliases on demand.** Added native MFA
  and passkey setup, fail-closed destination encryption, migration-safe
  deploys, Docker AASA parity, release gates and artifacts, a minimal Chromium
  alias extension, and operator-defined blocked subdomains.
- [x] **v1.2.1 security and reliability hardening.** Added durable SNS/SES
  delivery claims, account-wide recovery revocation, canonical HTTPS-bound
  native credentials, Android Keystore token protection, trusted Docker proxy
  routing, and transactional pre-listen Docker migrations.

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

- [ ] **In-dashboard "setup doctor"** _(self-hosting)_. An admin-panel health
  check that reports which secrets, DNS records, and AWS resources are missing
  or misconfigured, so onboarding is guided rather than doc-driven.
- [ ] **Passkey reauthentication for sensitive actions** _(authentication)_ —
  complete the existing passwordless experience before adding external identity
  providers. After the ten-minute fresh-auth window expires, let an already
  authenticated user satisfy the fresh-auth gate with a passkey assertion
  instead of requiring their passphrase for MFA/passkey changes, API keys,
  export, and account deletion. The assertion must be bound to the current
  `user_id` and `auth_version`, issue only a short-lived fresh-auth credential,
  and never switch the active session to the passkey's owner. Support the web,
  iOS, and Android flows in parity, including replay and cross-account tests.
- [ ] **Guided passkey setup after registration** _(authentication / onboarding)_
  — after showing the one-time recovery codes, offer to create and name a
  passkey while the new session is still fresh. Recommend it prominently but
  allow skipping; retain the passphrase and existing recovery model. Do not add
  passkey-only accounts until account identification, device loss, and recovery
  have a complete design.
- [ ] **Invite-only user onboarding** _(multi-user / self-hosting)_ — let an
  admin create, revoke, and copy an expiring, one-use registration link or code
  while public registration remains disabled. Invitations create ordinary users
  only, reveal no account-existence information, and use atomic consumption so
  concurrent requests cannot redeem one invitation twice. Add optional expiry
  and usage count only if there is a demonstrated need beyond the one-use flow.
- [ ] **Account security and recovery health** _(authentication / onboarding)_
  — a Security checklist showing whether the user has a passkey (ideally more
  than one), a recovery username, remaining recovery codes, MFA status, and a
  verified default destination. Recommend two independent ways back into the
  account and warn when codes are exhausted, but do not block normal use or
  imply that a destination inbox alone can recover every account.
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

- [ ] **Optional federated login, when the deployment model warrants it**
  _(authentication / advanced self-hosting or hosted growth)_. **Assessment:
  useful integration, but not a core product goal.** HideMyEmail is
  differentiated by serverless email aliases without a mail stack; federation
  does not improve that path, overlaps with the existing passkey login, adds
  another configuration and availability dependency, and creates substantial
  account-linking and recovery risk. Prioritise mail-provider flexibility,
  easier deployment, custom domains, and in-context alias creation first.
  - Reconsider when organization-scale installations need SSO with an existing
    Authentik, Authelia, Keycloak, Zitadel, or Pocket ID deployment. Implement
    standards-based **OIDC** (not generic OAuth) and keep it opt-in, with local
    passphrase/passkey recovery so provider failure cannot lock out the admin.
  - Treat **social login as a separate hosted-service growth feature**, not a
    self-hosting default. It is valuable only if the official hosted service
    needs lower signup friction; each self-hoster otherwise has to register and
    maintain provider credentials, while users reveal to that provider that
    they use HideMyEmail. If demand justifies it, evaluate in this order:
    1. **Sign in with Apple** — best privacy and native-iOS fit, but requires an
       Apple developer setup and specialised client-secret/key handling.
    2. **Google** — broadest consumer reach and straightforward OIDC, but the
       weakest privacy fit; offer it as a choice, never the only login route.
    3. **Microsoft** — useful if hosted or organization users request it; OIDC
       is standard, but tenant policy needs careful configuration.
    4. **GitHub** — relevant mainly to the developer audience and uses a
       provider-specific OAuth identity flow rather than standard OIDC; defer
       unless usage data shows it would materially improve adoption.
    Do not add all providers speculatively. Ship one only after measuring signup
    abandonment or receiving sustained operator demand, and preserve a provider-
    independent passkey/passphrase path.
  - Start with fresh-authenticated linking to existing accounts. Identify a
    binding only by immutable `(issuer, subject)`; never merge by email, infer
    admin rights from claims, or auto-link the permanent `id = 1` administrator.
    Just-in-time account creation should be a separate, default-off follow-up.
  - Preserve local MFA, `auth_version` revocation, account recovery, and the
    existing native `/app-auth` PKCE handoff. Use Authorization Code + PKCE with
    exact issuer/redirect validation and one-use state/nonce; treat bindings as
    credentials during recovery and deletion. Require focused takeover, replay,
    account-link CSRF, registration-policy, and provider-outage tests.
  - Only after organization-scale adoption, assess required-SSO policies,
    group-based admission, automatic deactivation, or SCIM. External claims
    must never grant admin access or control the permanent administrator.
- [ ] **Session and device controls** _(authentication)_. Start with a simple
  **Sign out everywhere** action backed by the existing `auth_version`
  revocation behavior. Before adding individual-session revocation, assess the
  cost of replacing stateless sessions with durable records; if justified, show
  creation/last-use time and a user-supplied device label without fingerprinting,
  and let users revoke one web/native session. Reconcile this view with existing
  registered push devices so the two lists do not imply false equivalence.
- [ ] **Approve login from an existing device, only if passkeys leave a proven
  usability gap** _(authentication / native apps)_. A QR or short-code flow could
  let an authenticated phone approve a browser, but it duplicates passkey
  cross-device authentication and introduces one-use-code, account-binding, and
  approval-confusion risks. Keep conditional at P3 rather than building it for
  feature parity with other services.
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

## Authentication ideas assessed but not recommended

These are intentionally not backlog items unless the threat model or product
direction changes:

- **Email magic-link login:** makes the destination inbox both the protected
  resource and an authentication authority; inbox compromise would directly
  compromise the alias account.
- **SMS login or recovery:** adds cost, personal-data exposure, delivery
  dependency, and SIM-swap risk for less benefit than passkeys and recovery
  codes.
- **Security questions:** low-entropy, guessable recovery credentials.
- **Automatic account linking by email:** an unsafe trust bridge between
  providers, even when an email claim is marked verified. Use explicit,
  fresh-authenticated linking by immutable provider subject instead.
- **Trusted reverse-proxy identity headers:** easy to misconfigure and a poor fit
  for the primary Cloudflare Worker deployment. Prefer a verified OIDC flow if
  federation eventually becomes justified.
