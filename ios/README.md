# HideMyEmail — iOS app

A native SwiftUI client for the HideMyEmail alias service. It talks to the same
Cloudflare Worker API as the web dashboard, using **bearer-token auth** (the
`X-Auth-Mode: token` opt-in added in `worker/src/api/`).

Sign in (passphrase + TOTP MFA, or **passkey**), manage aliases and personal
subdomains, manage destination inboxes, view stats, and receive **push
notifications** for blocked mail and paused destinations. The remaining native
integrations (share sheet, App Intents) are tracked as follow-ups — see
[the roadmap](../docs/ROADMAP.md). A companion [Android client](../android/README.md)
ships the same API and bearer-token flow.

## Requirements

- Xcode 15+ (iOS 17 deployment target)
- [XcodeGen](https://github.com/yonyz/XcodeGen) — `brew install xcodegen`

The Xcode project file is **generated**, not committed (it's noisy and
merge-hostile). `project.yml` is the source of truth.

## Build & run

```bash
cd ios
xcodegen generate          # writes HideMyEmail.xcodeproj
open HideMyEmail.xcodeproj  # then ⌘R in Xcode
```

In Xcode, select the **HideMyEmail** target → Signing & Capabilities and set
your development team (or edit `DEVELOPMENT_TEAM` in `project.yml`).

### Pointing at a server

The app defaults to `https://app.hidemyemail.dev`. Self-hosters can change the
server URL from the **Server** button on the login screen (or Settings → Server
once signed in). It must be the full origin of your Worker, including `https://`.

## Architecture

```
HideMyEmail/
  App/            App entry point (@main)
  Models/         Codable types mirroring the Worker JSON contract
  Networking/     APIClient (async/await actor), APIError, Keychain token store
  State/          AppState — session lifecycle, @Observable, @MainActor
  Views/
    Auth/         Login, MFA, server configuration
    Aliases/      List, detail, create
    Destinations/ List, add, verify status, set-default
    Stats/        Totals, last-24h, top aliases
    Settings/     Account, server, sign out
```

### Auth model

- On login the app sends `X-Auth-Mode: token`; the Worker returns the signed
  session token in the JSON body instead of relying on the HttpOnly cookie.
- The token is stored in the **Keychain** (`kSecAttrAccessibleAfterFirstUnlock`)
  and sent as `Authorization: Bearer <token>` on every guarded request.
- A `401` anywhere drops the stored token and returns to the login screen.
- The web app is unaffected: without the `X-Auth-Mode` header it keeps using
  cookies, and the token is never exposed to page JavaScript.

### Passkey login

"Sign in with Passkey" uses `ASAuthorizationPlatformPublicKeyCredentialProvider`
against the Worker's `/api/passkey/{challenge,verify}` endpoints. Because the
native client is cookieless, the Worker echoes the signed challenge in the body
(`passkey_token`) under token mode and returns the bearer token on verify.

Setup required for it to actually work (it cannot run on the unsigned simulator):

1. **Worker** — deploy with the env vars from
   [`docs/CONFIGURATION.md`](../docs/CONFIGURATION.md): `APP_ORIGIN`
   (the relying-party origin, e.g. `https://app.hidemyemail.dev`) and
   `APPLE_APP_ID` (`<TeamID>.dev.hidemyemail.app`). Confirm
   `https://<APP_ORIGIN host>/.well-known/apple-app-site-association` returns the
   `webcredentials` JSON.
2. **App** — `HideMyEmail.entitlements` declares
   `webcredentials:app.hidemyemail.dev`. The relying-party domain, `APP_ORIGIN`,
   and the AASA host must all match. Set a real `DEVELOPMENT_TEAM` and enable the
   **Associated Domains** capability on the App ID.
3. **Register first** — the app only *signs in* with an existing passkey; create
   one in the web dashboard (Settings → Passkeys), then test on a physical device.

## Push notifications

APNs alerts for the events your inbox can't show you — mail that was **blocked**
and destinations **paused** after a bounce or spam complaint (both on by
default), plus opt-in **forward** and **reply-receipt** alerts. Settings ▸
Notifications drives a master toggle (requests OS permission and registers the
device token via `POST /api/push/devices`) and per-category opt-ins; prefs are
stored per device in the Worker's `push_devices` table.

Setup required for delivery (the Worker no-ops without it — registration still
works, nothing is sent):

1. **Capability** — the `aps-environment` entitlement is declared in
   `HideMyEmail.entitlements`. Enable the **Push Notifications** capability on
   the App ID and use a provisioning profile that includes it (device only;
   the simulator can register but won't deliver remote pushes).
2. **Worker** — set the APNs token-auth credentials from
   [`docs/CONFIGURATION.md`](../docs/CONFIGURATION.md): `APNS_KEY_ID`,
   `APNS_AUTH_KEY` (the `.p8` secret), and team/bundle (derived from
   `APPLE_APP_ID` when omitted). Use `APNS_HOST=api.sandbox.push.apple.com` for
   development-signed builds.

## Roadmap

Native-app follow-ups (share extension, AutoFill, App Intents) are tracked in the
shared [roadmap](../docs/ROADMAP.md) with parity across iOS and Android.
