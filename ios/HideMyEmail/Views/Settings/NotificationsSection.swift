import SwiftUI

/// Push-notification controls (Settings tab). A master toggle requests OS
/// permission and registers the device; per-category toggles map to the
/// Worker's `push_devices` opt-in columns. The defaults surface the events your
/// inbox can't show you (blocked mail, paused destinations) and leave the noisy,
/// already-in-your-inbox events (forwards, reply receipts) off.
struct NotificationsSection: View {
    private let push = PushManager.shared

    var body: some View {
        Section {
            Toggle("Allow Notifications", isOn: allowBinding)

            if push.enabled {
                Toggle("Blocked mail", isOn: prefBinding(\.blocked))
                Toggle("Destination issues", isOn: prefBinding(\.bounce))
                Toggle("Forwarded mail", isOn: prefBinding(\.forward))
                Toggle("Reply receipts", isOn: prefBinding(\.reply))
            }
        } header: {
            Text("Notifications")
        } footer: {
            footer
        }
        .task { await push.refreshSystemStatus() }
    }

    @ViewBuilder
    private var footer: some View {
        if let error = push.lastError {
            Text(error).foregroundStyle(Theme.red)
        } else if push.systemAuthorization == .denied {
            Text("Notifications are turned off for HideMyEmail in iOS Settings. Enable them in Settings ▸ Notifications to receive alerts.")
                .foregroundStyle(Theme.red)
        } else {
            Text("Get alerted about things your inbox never shows you — mail that was blocked and destinations paused after bounces or complaints. Forwards and reply receipts are off by default.")
        }
    }

    private var allowBinding: Binding<Bool> {
        Binding(
            get: { push.enabled },
            set: { on in Task { on ? await push.enable() : await push.disable() } }
        )
    }

    private func prefBinding(_ key: WritableKeyPath<PushPrefs, Bool>) -> Binding<Bool> {
        Binding(
            get: { push.prefs[keyPath: key] },
            set: { value in
                var updated = push.prefs
                updated[keyPath: key] = value
                Task { await push.setPrefs(updated) }
            }
        )
    }
}
