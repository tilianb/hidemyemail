import Foundation
import Observation
import UIKit
import UserNotifications

/// Coordinates APNs push: OS permission, device-token registration, and the
/// per-category preferences synced to the Worker (`/api/push/devices`).
///
/// A single shared instance is the bridge between the `AppDelegate` callbacks
/// (which deliver the device token) and the SwiftUI Settings UI. The user's
/// intent (`enabled`) and `prefs` are persisted so the UI is correct offline
/// and before the token round-trips; the Worker remains the source of truth for
/// what actually gets delivered.
@MainActor
@Observable
final class PushManager {
    static let shared = PushManager()

    /// The user has asked to receive notifications on this device.
    private(set) var enabled: Bool
    /// Per-category opt-ins.
    private(set) var prefs: PushPrefs
    /// OS-level authorization (so the UI can route the user to Settings if they
    /// denied the system prompt).
    private(set) var systemAuthorization: UNAuthorizationStatus = .notDetermined
    /// Last registration error, surfaced in the UI (e.g. simulator without push
    /// entitlement, or no network).
    private(set) var lastError: String?

    /// Latest APNs device token (hex), in memory only — APNs reissues it.
    private var deviceToken: String?
    private weak var app: AppState?

    private static let enabledKey = "push_enabled"
    private static let prefsKey = "push_prefs"

    private init() {
        self.enabled = UserDefaults.standard.bool(forKey: Self.enabledKey)
        if let data = UserDefaults.standard.data(forKey: Self.prefsKey),
           let decoded = try? JSONDecoder().decode(PushPrefs.self, from: data) {
            self.prefs = decoded
        } else {
            self.prefs = .default
        }
    }

    /// Wire up the app state so we can reach the authed API client.
    func attach(_ app: AppState) { self.app = app }

    // MARK: - System state

    /// Refresh the cached system authorization status (call when a view appears).
    func refreshSystemStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        systemAuthorization = settings.authorizationStatus
    }

    // MARK: - User actions

    /// Turn notifications on: ask the OS, then register for remote notifications.
    /// The resulting token arrives via `didRegister(tokenData:)`.
    func enable() async {
        lastError = nil
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            await refreshSystemStatus()
            guard granted else {
                enabled = false
                persist()
                return
            }
            enabled = true
            persist()
            UIApplication.shared.registerForRemoteNotifications()
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Turn notifications off: drop this device from the server and stop APNs.
    func disable() async {
        enabled = false
        persist()
        if let token = deviceToken {
            try? await app?.api()?.unregisterPushDevice(token: token)
        }
        UIApplication.shared.unregisterForRemoteNotifications()
    }

    /// Update per-category preferences and push them to the server.
    func setPrefs(_ newPrefs: PushPrefs) async {
        prefs = newPrefs
        persist()
        guard enabled, let token = deviceToken, let client = app?.api() else { return }
        // The token is already registered, so PATCH is enough; fall back to a
        // full register if the server doesn't know it yet.
        do {
            try await client.updatePushPrefs(token: token, prefs: newPrefs)
        } catch {
            try? await client.registerPushDevice(token: token, prefs: newPrefs)
        }
    }

    // MARK: - Session hooks

    /// After a successful login, (re)register this device for the new account if
    /// the user has push enabled.
    func onLogin() async {
        guard enabled else { return }
        await refreshSystemStatus()
        guard systemAuthorization == .authorized || systemAuthorization == .provisional else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// On sign-out, detach this device from the account. The server `DELETE`
    /// needs a still-valid session, so it can fail (expired token, offline) or be
    /// skipped (token not yet refreshed after launch) — therefore we ALWAYS stop
    /// OS-level delivery and drop the local token regardless. A lingering server
    /// row self-heals: the next dispatch hits an unregistered token, APNs returns
    /// 410, and the Worker prunes it. This guarantees a signed-out/shared device
    /// can't keep showing the previous account's notifications.
    func onLogout() async {
        if let token = deviceToken, let client = app?.api() {
            try? await client.unregisterPushDevice(token: token)
        }
        UIApplication.shared.unregisterForRemoteNotifications()
        deviceToken = nil
    }

    // MARK: - AppDelegate callbacks

    func didRegister(tokenData: Data) {
        deviceToken = tokenData.map { String(format: "%02x", $0) }.joined()
        lastError = nil
        guard enabled, let token = deviceToken, let client = app?.api() else { return }
        let prefs = prefs
        Task { try? await client.registerPushDevice(token: token, prefs: prefs) }
    }

    func didFail(error: Error) {
        lastError = error.localizedDescription
    }

    // MARK: - Persistence

    private func persist() {
        UserDefaults.standard.set(enabled, forKey: Self.enabledKey)
        if let data = try? JSONEncoder().encode(prefs) {
            UserDefaults.standard.set(data, forKey: Self.prefsKey)
        }
    }
}
