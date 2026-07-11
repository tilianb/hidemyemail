import SwiftUI

/// API keys for the addy.io-compatible /api/v1 surface
/// (GET/POST/DELETE /api/settings/api-keys) — the native counterpart of the
/// dashboard Settings page's "API Keys" card. Keys plug this instance into
/// Bitwarden's username generator (forwarder "addy.io") and other addy.io
/// clients. Creation and revocation are fresh-auth gated; the token is shown
/// exactly once.
struct ApiKeysSection: View {
    @Environment(AppState.self) private var app

    @State private var keys: [ApiKey] = []
    @State private var newToken: String?
    @State private var creating = false
    @State private var naming = false
    @State private var nameDraft = ""
    @State private var pendingDelete: ApiKey?
    @State private var error: String?

    var body: some View {
        Section {
            if let newToken {
                VStack(alignment: .leading, spacing: 6) {
                    Text(newToken)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                    Text("This key will not be shown again — store it in your password manager now.")
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
                Button {
                    UIPasteboard.general.string = newToken
                } label: {
                    Label("Copy Key", systemImage: "doc.on.doc")
                }
            }
            ForEach(keys) { key in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(key.name)
                        Text("\(key.tokenPrefix)… · \(usageLabel(key))")
                            .font(.caption)
                            .foregroundStyle(Theme.textSecondary)
                    }
                    Spacer()
                    Button(role: .destructive) {
                        pendingDelete = key
                    } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(.borderless)
                }
            }
            Button {
                nameDraft = ""
                naming = true
            } label: {
                if creating {
                    HStack { Text("Creating…"); Spacer(); ProgressView() }
                } else {
                    Label("Create API Key", systemImage: "key")
                }
            }
            .disabled(creating)
        } header: {
            Text("API Keys")
        } footer: {
            if let error {
                Text(error).foregroundStyle(Theme.red)
            } else {
                Text("Generate aliases from other apps via the addy.io-compatible API — in Bitwarden pick “addy.io” as the forwarder, use this server's URL, and paste a key as the API token. Requires a recent sign-in.")
            }
        }
        .task { await load() }
        .alert("Name the key", isPresented: $naming) {
            TextField("e.g. Bitwarden", text: $nameDraft)
            Button("Cancel", role: .cancel) { }
            Button("Create") { Task { await create() } }
        } message: {
            Text("Name it after where you'll use it, so you can revoke it precisely later.")
        }
        .confirmationDialog(
            "Revoke this API key? Anything using it stops working immediately.",
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Revoke \(pendingDelete?.name ?? "key")", role: .destructive) {
                if let key = pendingDelete { Task { await revoke(key) } }
            }
        }
    }

    private func usageLabel(_ key: ApiKey) -> String {
        guard let last = key.lastUsedAt else { return "Never used" }
        let date = Date(timeIntervalSince1970: last / 1000)
        return "Last used \(date.formatted(date: .abbreviated, time: .omitted))"
    }

    private func load() async {
        guard let client = app.api() else { return }
        do {
            keys = try await client.apiKeys()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func create() async {
        let name = nameDraft.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, let client = app.api() else { return }
        creating = true
        defer { creating = false }
        do {
            let created = try await client.createApiKey(name: name)
            newToken = created.token
            error = nil
            await load()
        } catch APIError.server(let status, let message) where status == 401 {
            error = message == "Fresh authentication required"
                ? "Session is not fresh — sign out and back in, then retry."
                : message
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func revoke(_ key: ApiKey) async {
        guard let client = app.api() else { return }
        do {
            try await client.deleteApiKey(id: key.id)
            keys.removeAll { $0.id == key.id }
            error = nil
        } catch APIError.server(let status, let message) where status == 401 {
            error = message == "Fresh authentication required"
                ? "Session is not fresh — sign out and back in, then retry."
                : message
        } catch {
            self.error = error.localizedDescription
        }
    }
}
