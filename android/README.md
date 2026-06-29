# HideMyEmail — Android app

A native Jetpack Compose client for the HideMyEmail alias service. It talks to
the same Cloudflare Worker API as the web dashboard and the
[iOS app](../ios/README.md), using **bearer-token auth** (the `X-Auth-Mode: token`
opt-in in `worker/src/api/`).

Sign in (passphrase + TOTP MFA, or **passkey** via the web handoff), manage
aliases and personal subdomains, manage destination inboxes, configure
block/allow rules, view stats, and receive **push notifications** (FCM) for
blocked mail and paused destinations. The remaining native integrations (share
target, Autofill) are tracked as follow-ups — see
[the roadmap](../docs/ROADMAP.md), kept at parity with iOS.

## Requirements

- JDK 17
- Android SDK with API 35 (`compileSdk`/`targetSdk`); `minSdk` is 26 (Android 8.0)
- Android Studio (Ladybug or newer) or the command-line Gradle wrapper

## Build & run

```bash
cd android
./gradlew assembleDebug          # APK in app/build/outputs/apk/debug/
./gradlew installDebug           # build + install on a connected device
```

Or open the `android/` directory in Android Studio and run the **app**
configuration on a device or emulator.

Release builds are minified (R8) and signed from `release.keystore` when present;
the store password, key alias, and key password are read from the
`ANDROID_KEYSTORE_PASS` and `ANDROID_KEY_ALIAS` environment variables.

### Pointing at a server

The app defaults to `https://app.hidemyemail.dev`. Self-hosters can change the
server URL from the **Server** button on the login screen (or Settings → Server
once signed in). It must be the full origin of your Worker, including `https://`.

## Architecture

```
app/src/main/java/dev/hidemyemail/app/
  MainActivity.kt   Activity entry point + deep-link handling
  AppViewModel.kt   Session lifecycle and screen state (Compose state holder)
  net/              ApiClient (OkHttp + coroutines), ApiException, Codable Models
  auth/             TokenStore, WebSessionAuth (PKCE web-session handoff)
  ui/               Compose screens:
    LoginScreen, MfaScreen, ServerSettingsSheet   auth + server config
    AliasesScreen, AliasDetailScreen, CreateAliasSheet
    DestinationsScreen, DomainsScreen, RulesScreen
    StatsScreen, SettingsScreen, SettingsSections
    MainScaffold, Common, Theme
```

### Auth model

- On login the app sends `X-Auth-Mode: token`; the Worker returns the signed
  session token in the JSON body instead of relying on the HttpOnly cookie.
- The token is stored in app-private **SharedPreferences**. The manifest sets
  `android:allowBackup="false"` so the token is excluded from Auto Backup and
  device-to-device transfers — mirroring the iOS `ThisDeviceOnly` keychain stance.
- A `401` anywhere drops the stored token and returns to the login screen.
- The web app is unaffected: without the `X-Auth-Mode` header it keeps using
  cookies, and the token is never exposed to page JavaScript.

### Passkey / web-session login

Passkeys are bound to the server's web origin via WebAuthn, not to the app, so
the Android client signs in through a **web-session handoff** rather than a
native credential API:

1. `WebSessionAuth` opens the server's dashboard login (`/app-auth`) in a
   **Custom Tab** with a PKCE challenge. Passkeys, passphrase + TOTP, and any
   other web auth method all work there because the ceremony runs against the
   server's domain.
2. The dashboard hands back a short-lived code over the `hidemyemail://auth`
   deep link (declared in `AndroidManifest.xml`).
3. The app exchanges that code — with the PKCE verifier that never left the
   device — for a bearer token.

This mirrors the iOS `WebSessionAuthenticator`, and works against any server,
self-hosted included, with no per-app association setup.

### Push notifications (FCM)

Push uses Firebase Cloud Messaging. The app **builds and runs without Firebase** —
push is simply reported as unavailable in Settings until it's configured:

1. **Firebase project** — create one for the `dev.hidemyemail.app` package and
   download its `google-services.json` into `android/app/`. Its presence is what
   switches on the Google Services Gradle plugin (the build skips it otherwise),
   so the dependency-injected `FirebaseApp` initialises and the
   Settings ▸ Notifications toggle becomes enabled.
2. **Worker** — set the `FCM_SERVICE_ACCOUNT` secret (the Firebase
   service-account JSON) so the Worker can send via the FCM HTTP v1 API. See
   [`docs/CONFIGURATION.md`](../docs/CONFIGURATION.md).

`google-services.json` is git-ignored (it's per-project). For **release builds**,
CI writes it from a `GOOGLE_SERVICES_JSON` repository secret (the file's full
contents) before `assembleRelease`; without the secret the release APK still
builds, just with push disabled. The Worker routes each device to its platform's
transport (APNs for iOS, FCM for Android) off the `push_devices.platform` column.

## Roadmap

Remaining native-app follow-ups (share target, Autofill) are tracked in the
shared [roadmap](../docs/ROADMAP.md) with parity across iOS and Android.
