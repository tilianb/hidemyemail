# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased] — v1.1.0 candidate

### Added

- **addy.io-compatible API** (`/api/v1`) for alias generation. Point
  Bitwarden's username generator (or any addy.io client) at your instance
  with a per-user API key from **Settings → API Keys** — keys are shown
  once, stored hashed (`0027_api_keys`), fresh-auth-gated to create/revoke,
  and revocable per key. Covers token details, domain options, alias
  create/list/get/delete, and activate/deactivate. See
  [docs/API.md](docs/API.md).
- **One-shot setup script** (`cd worker && npm run setup`): generates
  `SESSION_SECRET`, `ACTION_SECRET`, and a correctly-formatted
  `DESTINATION_ENCRYPTION_KEY`, hashes the admin passphrase, prompts for the
  optional AWS credentials, and pushes everything via `wrangler secret put`
  in one interactive pass (`--print` emits `KEY=VALUE` lines for the Docker
  `.env` instead).
- **Push notifications (iOS + Android).** Native alerts for the events your
  inbox can't show you: **blocked** mail and destinations **paused** after
  bounces/complaints (on by default), plus opt-in **forward** and
  **reply-receipt** alerts. The Worker dispatch routes per device platform —
  **APNs** for iOS, **FCM HTTP v1** for Android — over a shared `push_devices`
  table (per-device opt-ins) and guarded `GET/POST/PATCH/DELETE
  /api/push/devices` endpoints, with a Settings ▸ Notifications panel in both
  apps.
  - iOS: configure `APNS_KEY_ID` / `APNS_AUTH_KEY` (+ team/bundle, derived from
    `APPLE_APP_ID`).
  - Android: configure `FCM_SERVICE_ACCOUNT` (a Firebase service-account JSON)
    and drop a `google-services.json` into `android/app/`.
  - Each transport is independent and a **no-op when unconfigured**, so
    registration works before push is set up and one platform can ship without
    the other.

### Changed

- **Account export is now complete:** the JSON export also includes MFA
  status, registered passkeys, the reverse-alias map, notification
  preferences, and per-device push registrations.
- **Durable contacts store for the reply gate.** First-contact correspondents
  are recorded in a dedicated table (`0026_contacts`) and events now have a
  retention policy, so the first-contact gate survives event pruning instead
  of relying on an unbounded events log.
- **Unified global rate limit.** `rate_limit_global` is now enforced
  consistently across both the inbound forwarding and reply paths.

### Security

- Bumped `undici` to 7.28.0 and applied routine npm dependency updates across
  the worker, dashboard, and docker images; Dependabot now also tracks
  `/docker`.

### Fixed

- Secret-generation docs and `docker/gen-secrets.sh` produced a broken
  `DESTINATION_ENCRYPTION_KEY`: the Worker decodes it as base64 and AES-256
  needs exactly 32 bytes, so the documented `openssl rand -hex 32` value
  failed key import at runtime. Now generated as `openssl rand -base64 32`,
  and the Docker host also passes `ACTION_SECRET` through.
- iOS: keep the iPad `PortraitUpsideDown` orientation across `xcodegen`
  regenerations (required for App Store iPad submissions).
- Hardened `POST /api/push/test`: prunes devices on an APNs `410`, adds a
  send cooldown, and reads `APNS_HOST` / `APNS_KEY_ID` per environment.
- Docker image purges stale build state at startup; the release-retag step
  now fails loudly instead of silently falling back to `:main`.

### Docs / CI

- Added a native [Android app README](android/README.md) and moved the iOS
  roadmap into the shared [`docs/ROADMAP.md`](docs/ROADMAP.md), kept at parity
  across iOS and Android.
- TestFlight marketing version and build number are now derived dynamically
  from the release git tag; silenced the Node 20 CI warning.

## [1.0.2] — 2026-06-14

### Added

- **Automated mobile deployment pipeline.** CI builds a signed release Android
  APK (decrypting an encrypted PKCS12 keystore) and attaches it to the GitHub
  Release, and packages the iOS app with `xcodegen` / `xcodebuild`, signs it
  with the Apple Distribution certificate, and uploads the `.ipa` to TestFlight
  via the App Store Connect API.

### Fixed

- Gradle keystore decryption for PKCS12 keystores — the key password was
  previously ignored, failing the signed release build.

## [1.0.1] — 2026-06-14

### Changed

- Unified the visual design and interaction patterns across the Domains and
  Aliases pages; added inline editing for alias labels and destinations;
  standardized full-width page layouts and removed redundant "Type" columns;
  renamed **Blocks → Rules** across the dashboard.

### Security

- Overrode the `esbuild` version to clear a Dependabot alert; enabled CodeQL
  advanced setup and fixed `sync-dev` workflow permissions.

### Fixed

- Set the `APPLE_APP_ID` environment variable so the AASA file serves passkey
  associations correctly to iOS devices.

### Docs

- Documented post-v1 custom-domains (BYOD) support on the roadmap; routine
  dependency bumps.

## [1.0.0] — 2026-06-13

### Added

- **Spam/virus verdict handling.** SES receipt verdicts now gate inbound
  forwards. Admin-configurable: `spam_verdict_action` (forward / flag /
  drop, default flag → `X-Spam-Flag: YES`) and `virus_verdict_action`
  (default drop). Forwarded junk no longer burns your domain's sender
  reputation.
- **Account restore.** `POST /api/restore` cancels a pending account
  deletion during the 7-day grace window (passphrase-authenticated,
  rate-limited); the login page offers it automatically.
- **Destination suppression** on hard bounces and complaints, with a
  soft-bounce threshold, admin suppression dashboard, user self-serve
  unsuppress for soft pauses, and email notifications that fall back to
  another verified destination when the default itself is suppressed.
- **Per-subdomain policies** (catch-all, inline actions, default
  destination) and **scoped block/allow sender rules** (user-wide /
  subdomain / alias, with allowlist mode).
- **Account data export** (JSON, decrypted destinations) and
  **account deletion** with 7-day tombstone + scheduled hard purge.
- **RFC 8058 one-click unsubscribe** over HTTPS (POST-only state change;
  GET shows a confirmation page).
- **Reply abuse controls:** first-contact gate, per-alias reply rate
  limit, distinct-recipient cap with 24h auto-mute.
- Events table indexes for the rate-limit and reply-gate scans.

### Changed

- **`unsubscribe_header_mode` defaults to `bulk_only`:** our
  List-Unsubscribe header (which one-click-disables the alias) is now only
  added to forwards whose original message already carried List-Unsubscribe
  or `Precedence: bulk/list`. Person-to-person forwards no longer carry
  bulk-mail markers. Set to `always` in Admin → Settings for the old
  behavior.
- **Fresh-auth required for account export and deletion** (same gate as
  MFA changes). A long-lived session cookie alone can no longer download
  the plaintext export or delete the account — log out and back in if
  prompted.
- Forwarding metadata headers renamed to `X-HideMyEmail-*`; original
  `Authentication-Results` is re-emitted as
  `X-HideMyEmail-Authentication-Results`.
- Outlook deliverability improvements; deliverability guidance (custom
  MAIL FROM, warm-up) documented in `docs/AWS_SES_SETUP.md`.

### Fixed

- Tombstoned accounts now consistently blocked across login and API while
  restorable via `/api/restore`.
- Hard suppression of the default destination no longer fails silently —
  the notice goes to another verified destination when one exists.
- Duplicate `List-Unsubscribe` headers in the inline-actions forwarding
  path.

## [0.9.2] — 2026-05-28

Pre-v1 baseline: core alias forwarding, reply-from-alias, MFA + passkeys,
admin settings, Docker self-host, Cloudflare Workers deploy.

[Unreleased]: https://github.com/tilianb/hidemyemail/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/tilianb/hidemyemail/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/tilianb/hidemyemail/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/tilianb/hidemyemail/compare/v0.9.2...v1.0.0
[0.9.2]: https://github.com/tilianb/hidemyemail/releases/tag/v0.9.2
