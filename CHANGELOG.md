# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [Unreleased] — v1.0.0 candidate

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

[Unreleased]: https://github.com/tilianb/hidemyemail/compare/v0.9.2...HEAD
[0.9.2]: https://github.com/tilianb/hidemyemail/releases/tag/v0.9.2
