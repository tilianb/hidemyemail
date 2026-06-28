# Roadmap

Tracked backlog of recommendations from the pre-v1 review (2026-06-10).
Items are removed when shipped; see CHANGELOG.md for what already landed.


## Push notifications (top priority)

- [x] **iOS APNs** — shipped (blocked / paused-destination on by default,
  forward / reply opt-in).
- [ ] **Android FCM** — pending. Worker dispatch is APNs-only today; needs an
  FCM HTTP v1 sender (the `push_devices.platform` column already exists to
  branch on) plus a Firebase project + service-account secret.
- [ ] **Share-to-mint-alias** so an alias can be generated from any app.
  - iOS: Share extension.
  - Android: share-target activity.
- [ ] **AutoFill integration** so aliases can be generated inside the browser /
  signup forms without opening the app.
  - iOS: AutoFill credential provider (works in Safari).
  - Android: Autofill service + Credential Manager provider.


## Product — make it a daily driver

- [ ] **addy.io-compatible API surface** for alias generation. Bitwarden
  and other password managers already speak the addy.io/SimpleLogin
  APIs — compatibility gives instant integration with Bitwarden's
  username generator. Highest usefulness-per-effort item on this list.
  Then request a listing in Bitwarden's forwarder docs.
- [ ] **Browser extension** (or interim bookmarklet): generate an alias in
  signup forms without opening the dashboard. The daily-driver feature of
  SimpleLogin/addy.
- [ ] **Compose-as-alias** from the dashboard with explicit per-send
  confirmation (the first-contact gate correctly blocks SMTP-level
  originate; a UI path keeps the anti-spam posture).
- [ ] Import from SimpleLogin / addy.io CSV — migration path for switchers.

  - Android: Autofill service + Credential Manager provider.


## Deliverability (beyond what shipped)

- [ ] Consider ARC sealing of forwards instead of header stripping once an
  ARC library is practical inside Workers.
- [ ] Per-domain deliverability checklist in the dashboard (custom MAIL
  FROM present, DMARC policy, Postmaster/SNDS enrolment status).

## Traction

- [ ] Screenshots / GIF of the dashboard in the README.
- [ ] Submit to awesome-selfhosted, selfh.st, AlternativeTo.
- [ ] Technical blog post: "Email aliases without a mail server." Include SES and
  Workers. Post to r/selfhosted and Show HN. Sequence AFTER the rename
  and deliverability fixes. Launch posts get one shot.
- [ ] Hosted demo with a throwaway demo login at the public instance.
## Custom Domains (BYOD)

The database schema supports non-global, user-owned domains (`domains.user_id` and `is_global = 0`). To support users bringing their domains, build the following workflow:

- [ ] **AWS SES Integration for Identities**: When a user adds a domain in the dashboard, the Worker needs to call the AWS SES API (`CreateEmailIdentity`) to register the domain and retrieve the required DNS records for verification and DKIM. This will require adding `ses:CreateEmailIdentity`, `ses:GetEmailIdentity`, and `ses:DeleteEmailIdentity` permissions to the worker's IAM user.
- [ ] **Dashboard Onboarding UI**: Provide a setup wizard for custom domains showing the required DNS records:
  - MX records pointing to the SES inbound receiving endpoint.
  - TXT record for SES domain verification.
  - CNAME records for Easy DKIM.
- [ ] **Verification Job**: A "Verify" button in the UI (or a scheduled cron trigger) that checks SES for the identity verification status and updates `domains.active = 1` in the database.
- [ ] **Catch-all Support**: UI to configure a `default_destination` for the custom domain, enabling users to receive emails sent to any address at their domain without explicitly creating an alias first.
- [ ] **Alias Generation Context**: Update the dashboard "New Alias" UI to let users select their verified custom domain from a dropdown. Do not limit to global system domains.
