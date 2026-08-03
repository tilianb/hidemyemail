# Project Learnings

## What Has Worked

**2026-08-03 — Authentication-generation fencing**
- Observation: The Worker session guard captures `auth_version` before route execution, so recovery or deletion can rotate credentials while an already-authorized request is still preparing a durable API key, passkey, MFA enrollment, or recovery-code write.
- Action: Bind every final credential-minting SQL statement to the live user's active, non-deleted `auth_version` in that same statement, and never return plaintext credentials when the generation predicate loses.
- Confidence: high

**2026-08-03 — TOTP replay prevention**
- Observation: Verifying a TOTP value cryptographically does not make its 30-second counter one-use; concurrent login and reauthentication paths can otherwise accept the same value independently.
- Action: Persist the last accepted TOTP counter and advance it with a compare-and-swap in the same atomic finalization as the associated authentication artifact or security mutation.
- Confidence: high

**2026-08-03 — Release image tag consistency**
- Observation: Applying `latest` during branch publication lets it diverge from the stable SemVer image published later by the reusable release workflow.
- Action: Apply mutable stable aliases such as `latest` in the same manifest operation as validated release tags, and keep branch aliases separate.
- Confidence: high

**2026-08-03 — Release-validator test performance**
- Observation: Release-validator cases that pass `--previous-tag=` never execute Git history lookups, so initializing and committing a fixture repository only adds subprocess overhead.
- Action: Create Git history only for release-validator cases that exercise automatic previous-tag discovery.
- Confidence: high

**2026-08-01 — Cross-platform security changes**
- Observation: Worker, dashboard, Android, and iOS fresh-auth contracts can drift unless each client is validated against the same response fields and endpoint sequence.
- Action: For authentication changes, test the Worker contract, dashboard, Android, and iOS, using platform CI whenever the available environment cannot run a required native toolchain.
- Confidence: high

**2026-08-01 — Extension autofill-overlay coexistence**
- Observation: The content script recognizes 1Password's `com-1password-button` directly, while Bitwarden-style closed-shadow controls require guarded `[popover='manual']` and geometry/hit-testing; tests require foreign controls to remain untouched.
- Action: Resolve inline-control collisions by moving or hiding HideMyEmail's host only, and keep the fixed-position host hidden until its first valid coordinates are calculated.
- Confidence: high

**2026-08-01 — Recovery-code entropy upgrade**
- Observation: Self-service recovery codes are 160-bit values, and migration `0029_recovery_auth_version.sql` clears pre-existing 40-bit code sets rather than preserving weak credentials.
- Action: Preserve 160-bit generation and invalidate stored credential sets when strengthening their entropy; do not silently grandfather weaker recovery codes.
- Confidence: high

## Patterns and Preferences

**2026-08-03 — Hybrid Namespace runner allocation**
- Observation: At this repository's run volume, paid persistent cache storage costs more than the compute time it saves; two concurrent 4x8 Android/Java jobs use only 8 vCPU and 16 GB, while Docker can retain the cacheless default profile's remote builder independently of lightweight workflow jobs.
- Action: Reserve Namespace 4x8 runners for Android and Java/Kotlin CodeQL, Namespace macOS for iOS and TestFlight, and the Namespace default profile for Docker image builds; run lightweight orchestration on GitHub-hosted runners and use GitHub-backed dependency caches.
- Confidence: high

**2026-08-03 — Local PR-check parity**
- Observation: Local PR-check reproduction requires JDK 21, Android SDK 35, a compatible Xcode selected through `DEVELOPER_DIR`, and a Docker-compatible engine; Java/Kotlin CodeQL extraction requires Gradle `--no-daemon` so compilation runs under the tracer.
- Action: Discover the available toolchain locations, export the standard environment variables, ensure the container engine is running, and disable the Gradle daemon when reproducing Java/Kotlin CodeQL.
- Confidence: high

**2026-08-03 — CI runner evaluation**
- Observation: Standard GitHub-hosted runners are free for this public repository, while selected Namespace profiles are workspace-controlled and ephemeral; signed Android and TestFlight jobs may use Namespace, but signing files and credentials must stay outside persistent cache paths.
- Action: Keep GitHub-hosted runners as the default for lightweight jobs; use Namespace only for approved measured workloads, preserve least-privilege job permissions, and never persist signing or publication credentials in cross-invocation caches.
- Confidence: high

**2026-08-03 — Namespace Linux runner benchmark**
- Observation: The Namespace Linux profile cut Android and Java/Kotlin CodeQL execution by more than half, but burst scheduling added 73–160 seconds to later fan-out jobs and its Docker validation build took nearly three times as long as GitHub-hosted Ubuntu.
- Action: Use Namespace selectively for Android and CodeQL compute-heavy jobs; retain GitHub-hosted Ubuntu for short fan-out and Docker validation jobs unless concurrency and Docker caching are improved.
- Confidence: high

**2026-08-03 — Namespace Docker remote builders**
- Observation: `docker/setup-buildx-action` replaces the builder preconfigured by a Namespace runner with a local `docker-container` driver; skipping that action and using `outputs: type=cacheonly` preserves the `nsc-remote` builder and its persistent NVMe layer cache.
- Action: On Namespace validation runners, use the profile-provided Buildx configuration directly; reserve `setup-buildx-action` for GitHub-hosted production publishing jobs.
- Confidence: high

**2026-08-03 — Namespace runner cache profiles**
- Observation: The built-in `namespace-profile-default` provides a remote Docker builder but no runner Cache Volume; npm, Gradle, Xcode, and Git mirror acceleration require a cache-backed custom profile and `nscloud-cache-action` or `nscloud-checkout-action`.
- Action: Use the default profile for Docker remote-builder orchestration, add persistent Namespace caches only when measured savings exceed storage cost, and avoid overlapping cache mechanisms.
- Confidence: high

**2026-08-01 — Web fresh-auth continuations**
- Observation: Dashboard requests use ambient HttpOnly cookies, so a captured continuation is not account-bound merely because it retains the same API module reference.
- Action: Capture the profile ID before the first sensitive request and compare that bound ID again before queuing and replaying a fresh-auth continuation.
- Confidence: high

**2026-08-01 — Passkey assertion finalization**
- Observation: `lib/auth-security.ts` can import the passkey counter CAS helper from `lib/auth.ts` without a module cycle, allowing login and artifact finalization to share exactly one SQL update.
- Action: Keep passkey sign-count compare-and-swap SQL in `updatePasskeySignCount`; compose artifact consumption around that helper rather than duplicating the statement.
- Confidence: high

**2026-08-01 — Passkeys for authenticated security actions**
- Observation: Discoverable passkey login can select a different principal, whereas MFA and fresh-auth challenges are dedicated artifacts bound to the current user, auth version, action or client channel.
- Action: Never reuse the standalone passwordless-login ceremony for an in-session security action; use the authenticated account-bound ceremony and preserve its anti-transfer and stale-auth-version tests.
- Confidence: high

**2026-08-01 — Native 401 semantics**
- Observation: Native clients send bearer and fresh-auth headers without relying on cookies, but not every authenticated `401` means the bearer token expired: fresh-auth and credential-validation endpoints return semantic `401` responses that must preserve credentials.
- Action: Sign out only for an actual unauthorized authenticated request; surface login, MFA, reauthentication, and fresh-auth failures without clearing bearer or fresh-auth state.
- Confidence: high

**2026-08-01 — Shared passphrase salt**
- Observation: `AUTH_PASSWORD_SALT` derives both the configured admin hash and every stored non-admin `passphrase_hash`.
- Action: Treat salt rotation as a full credential migration that rehashes every account and the admin credential; changing only the configured admin hash would strand users.
- Confidence: high

**2026-08-01 — Release workflow validation**
- Observation: `docker/client-ip.test.mjs` also enforces release-workflow invariants, including TestFlight triggers and build-number inputs.
- Action: When changing `.github/workflows/testflight.yml`, update and run the Docker test suite in the same change.
- Confidence: high

**2026-08-01 — Advisory-only automated review**
- Observation: `.coderabbit.yaml` deliberately disables docstrings, autofixes, generated tests, simplification, CI fixes, and merge-conflict resolution after generated finishing touches damaged native indentation and displaced useful security comments.
- Action: Keep automated review advisory-only, especially for Kotlin and Swift; do not enable CodeRabbit finishing touches that rewrite source.
- Confidence: high

## What Has Failed

**2026-08-01 — iOS nested security sheets**
- Observation: Presenting the shared fresh-auth sheet while an MFA sheet is still dismissing can strand the pending continuation or make SwiftUI reject the second presentation.
- Action: Queue fresh auth without presenting it, dismiss the active MFA sheet, and present from that sheet's `onDismiss`; defer reopening MFA UI until the fresh-auth sheet has dismissed.
- Confidence: high

**2026-08-01 — iOS API stubs**
- Observation: Broad URLProtocol fallback responses in `SecurityFeatureTests.swift` can make later requests decode the response model from an earlier endpoint.
- Action: Stub every endpoint in multi-request iOS tests by exact URL path and return a response matching that endpoint's decoded type.
- Confidence: high
