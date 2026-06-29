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

- [ ] **addy.io-compatible API surface** for alias generation _(product)_.
  Bitwarden and other password managers already speak the addy.io/SimpleLogin
  APIs — compatibility gives instant integration with Bitwarden's username
  generator. Highest usefulness-per-effort item on this list. Then request a
  listing in Bitwarden's forwarder docs.
- [ ] **One-shot setup script** (`npm run setup`) _(self-hosting)_. Generates
  the random secrets (`SESSION_SECRET`, `ACTION_SECRET`,
  `DESTINATION_ENCRYPTION_KEY`), runs the first-user `hash-password` bootstrap,
  and `wrangler secret put`s everything in a single interactive pass. Collapses
  ~6 manual secret steps into one — biggest setup-friction reduction for the
  least effort.
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

## P2 — Next

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
