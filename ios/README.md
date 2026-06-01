# HideMyEmail — iOS app

A native SwiftUI client for the HideMyEmail alias service. It talks to the same
Cloudflare Worker API as the web dashboard, using **bearer-token auth** (the
`X-Auth-Mode: token` opt-in added in `worker/src/api/`).

This is the **Phase 1 / Core** release: sign in (passphrase + TOTP MFA), manage
aliases, manage destination inboxes, and view stats. Android and the heavier
native integrations (passkeys, push, share sheet) are tracked as follow-ups —
see the roadmap below.

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

## Roadmap (post-Core)

- **Native passkeys** via `ASAuthorization` + Associated Domains (needs an
  `apple-app-site-association` file served by the Worker).
- **Push notifications** for forwarded / blocked mail alerts.
- **Share sheet extension** to mint an alias from any app.
- **Android** (Kotlin/Compose) — same API, same bearer-token flow.
```
