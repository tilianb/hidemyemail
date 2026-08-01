# Project Learnings

## What Has Worked

**2026-08-01 — Cross-platform security changes**
- Observation: Worker, dashboard, Android, and iOS fresh-auth contracts can drift unless each client is validated against the same response fields and endpoint sequence.
- Action: For authentication changes, test the Worker contract, dashboard, Android, and iOS, then rely on the iOS simulator CI for Swift validation when working from Linux.
- Confidence: high

## Patterns and Preferences

**2026-08-01 — Web fresh-auth continuations**
- Observation: Dashboard requests use ambient HttpOnly cookies, so a captured continuation is not account-bound merely because it retains the same API module reference.
- Action: Capture the profile ID before the first sensitive request and compare that bound ID again before queuing and replaying a fresh-auth continuation.
- Confidence: high

**2026-08-01 — Passkey assertion finalization**
- Observation: `lib/auth-security.ts` can import the passkey counter CAS helper from `lib/auth.ts` without a module cycle, allowing login and artifact finalization to share exactly one SQL update.
- Action: Keep passkey sign-count compare-and-swap SQL in `updatePasskeySignCount`; compose artifact consumption around that helper rather than duplicating the statement.
- Confidence: high

**2026-08-01 — Release workflow validation**
- Observation: `docker/client-ip.test.mjs` also enforces release-workflow invariants, including TestFlight triggers and build-number inputs.
- Action: When changing `.github/workflows/testflight.yml`, update and run the Docker test suite in the same change.
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
