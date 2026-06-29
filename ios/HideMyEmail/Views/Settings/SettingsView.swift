import SwiftUI

struct SettingsView: View {
    @Environment(AppState.self) private var app
    @State private var showSignOut = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    LabeledContent("Signed in as", value: app.userName.isEmpty ? "—" : app.userName)
                    if app.isAdmin {
                        Label("Administrator", systemImage: "crown.fill")
                            .foregroundStyle(Theme.accent)
                    }
                }
                Section("Server") {
                    LabeledContent("URL", value: app.serverURLString)
                }
                Section("Routing") {
                    NavigationLink {
                        DestinationsView()
                    } label: {
                        Label("Destinations", systemImage: "tray.and.arrow.down")
                    }
                }
                UsernameSection()
                NotificationsSection()
                InlineActionsSection()
                SecuritySection()
                RecoveryCodesSection()
                ExportSection()
                Section {
                    Button("Sign Out", role: .destructive) { showSignOut = true }
                }
                Section {
                    LabeledContent("Version", value: appVersion)
                }
            }
            .themedScrollBackground()
            .navigationTitle("Settings")
            .alert("Sign out?", isPresented: $showSignOut) {
                Button("Cancel", role: .cancel) { }
                Button("Sign Out", role: .destructive) { Task { await app.signOut() } }
            } message: {
                Text("You'll need to sign in again to manage your aliases.")
            }
        }
    }

    private var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(v) (\(b))"
    }
}
