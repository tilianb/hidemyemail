import SwiftUI

/// Account-wide inline-action preferences (GET/PATCH /api/preferences) — the
/// native counterpart of the dashboard Settings page's "Inline actions" card.
/// Inline actions add block/deactivate links to forwarded mail.
struct InlineActionsSection: View {
    @Environment(AppState.self) private var app

    @State private var loaded = false
    @State private var pref = ""        // "" inherit | on | off
    @State private var position = ""    // "" inherit | header | footer
    @State private var defaults: Preferences.Defaults?
    @State private var error: String?

    var body: some View {
        Section {
            Picker("Inline actions", selection: $pref) {
                Text(inheritLabel(for: defaults.map { $0.inlineActionsEnabled ? "On" : "Off" })).tag("")
                Text("On").tag("on")
                Text("Off").tag("off")
            }
            .onChange(of: pref) { _, v in
                guard loaded else { return }
                Task { await save(["inline_actions_pref": v.isEmpty ? NSNull() : v]) }
            }
            Picker("Position", selection: $position) {
                Text(inheritLabel(for: defaults?.inlineActionsPosition.capitalized)).tag("")
                Text("Header").tag("header")
                Text("Footer").tag("footer")
            }
            .onChange(of: position) { _, v in
                guard loaded else { return }
                Task { await save(["inline_actions_position": v.isEmpty ? NSNull() : v]) }
            }
        } header: {
            Text("Inline Actions")
        } footer: {
            if let error {
                Text(error).foregroundStyle(Theme.red)
            } else {
                Text("Adds block and deactivate links to forwarded mail. Subdomains can override this.")
            }
        }
        .task { await load() }
    }

    private func inheritLabel(for serverDefault: String?) -> String {
        serverDefault.map { "Server default (\($0))" } ?? "Server default"
    }

    private func load() async {
        guard !loaded, let client = app.api() else { return }
        do {
            let p = try await client.preferences()
            pref = p.inlineActionsPref ?? ""
            position = p.inlineActionsPosition ?? ""
            defaults = p.defaults
            // Defer change-handling until initial values are in place.
            await MainActor.run { loaded = true }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save(_ fields: [String: Any]) async {
        guard let client = app.api() else { return }
        do {
            try await client.updatePreferences(fields: fields)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Public username (PATCH /api/account/username). Replaces the "User #N" label
/// everywhere and identifies the account during recovery-code recovery. Not a
/// secret and not a login credential — a normal session can change it.
struct UsernameSection: View {
    @Environment(AppState.self) private var app

    @State private var loaded = false
    @State private var draft = ""
    @State private var current: String?
    @State private var saving = false
    @State private var error: String?

    private var trimmed: String { draft.trimmingCharacters(in: .whitespaces) }
    private var dirty: Bool { trimmed != (current ?? "") }

    var body: some View {
        Section {
            TextField("username", text: $draft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .onSubmit { if dirty { Task { await save() } } }
            HStack {
                Button(saving ? "Saving…" : "Save") { Task { await save() } }
                    .disabled(saving || !dirty)
                if current != nil {
                    Spacer()
                    Button("Clear", role: .destructive) {
                        draft = ""
                        Task { await save() }
                    }
                    .disabled(saving)
                }
            }
        } header: {
            Text("Username")
        } footer: {
            if let error {
                Text(error).foregroundStyle(Theme.red)
            } else {
                Text("A public handle shown instead of “User #…”, and used with a recovery code to recover your account. Not a password. Leave blank to stay anonymous.")
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard !loaded, let client = app.api() else { return }
        do {
            let p = try await client.profile()
            current = p.username
            draft = p.username ?? ""
            loaded = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save() async {
        guard let client = app.api() else { return }
        saving = true
        defer { saving = false }
        do {
            let next = trimmed.isEmpty ? nil : trimmed
            let saved = try await client.setUsername(next)
            current = saved
            draft = saved ?? ""
            error = nil
            await app.reloadIdentity()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Self-service recovery codes (GET/POST /api/account/recovery-codes). Generating
/// is fresh-auth gated; the freshly minted codes are shown once for the user to
/// save.
struct RecoveryCodesSection: View {
    @Environment(AppState.self) private var app

    @State private var remaining: Int?
    @State private var generating = false
    @State private var newCodes: [String] = []
    @State private var error: String?
    @State private var confirming = false

    var body: some View {
        Section {
            HStack {
                Label("Recovery codes", systemImage: "key.horizontal")
                Spacer()
                Text(remaining.map { "\($0) remaining" } ?? "—")
                    .foregroundStyle(Theme.textSecondary)
                    .font(.callout)
            }
            if !newCodes.isEmpty {
                ForEach(newCodes, id: \.self) { code in
                    Text(code).font(.system(.body, design: .monospaced))
                }
                Button {
                    UIPasteboard.general.string = newCodes.joined(separator: "\n")
                } label: {
                    Label("Copy All Codes", systemImage: "doc.on.doc")
                }
            }
            Button {
                confirming = true
            } label: {
                if generating {
                    HStack { Text("Generating…"); Spacer(); ProgressView() }
                } else {
                    Label((remaining ?? 0) > 0 ? "Regenerate Codes" : "Generate Codes",
                          systemImage: "arrow.triangle.2.circlepath")
                }
            }
            .disabled(generating)
        } header: {
            Text("Recovery")
        } footer: {
            if let error {
                Text(error).foregroundStyle(Theme.red)
            } else {
                Text("Use your username + a recovery code to regain access if you lose your passphrase and passkeys. Each code works once. Requires a recent sign-in.")
            }
        }
        .task { await loadStatus() }
        .confirmationDialog(
            (remaining ?? 0) > 0 ? "Regenerating invalidates your existing recovery codes." : "Generate recovery codes?",
            isPresented: $confirming,
            titleVisibility: .visible
        ) {
            Button((remaining ?? 0) > 0 ? "Regenerate" : "Generate", role: .destructive) {
                Task { await regenerate() }
            }
        }
    }

    private func loadStatus() async {
        guard let client = app.api() else { return }
        do {
            remaining = try await client.recoveryCodesStatus().remaining
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func regenerate() async {
        guard let client = app.api() else { return }
        generating = true
        defer { generating = false }
        do {
            let codes = try await client.regenerateRecoveryCodes()
            newCodes = codes
            remaining = codes.count
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

/// Read-mostly security overview: TOTP status and registered passkeys, with
/// rename/delete. Enrolment (QR codes, WebAuthn create) stays on the web.
struct SecuritySection: View {
    @Environment(AppState.self) private var app

    @State private var mfa: MfaStatus?
    @State private var passkeys: [Passkey] = []
    @State private var renaming: Passkey?
    @State private var renameDraft = ""
    @State private var error: String?

    var body: some View {
        Section {
            HStack {
                Label("Two-factor auth", systemImage: "lock.shield")
                Spacer()
                if let mfa {
                    Text(mfa.enabled ? "On · \(mfa.backupCodesRemaining) backup codes" : "Off")
                        .foregroundStyle(mfa.enabled ? Theme.green : Theme.textSecondary)
                        .font(.callout)
                } else {
                    Text("—").foregroundStyle(Theme.textSecondary)
                }
            }
            if passkeys.isEmpty {
                LabeledContent("Passkeys", value: "None registered")
            } else {
                ForEach(passkeys) { pk in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(pk.deviceName ?? "Unnamed passkey")
                        Text(pk.createdDate, format: .dateTime.day().month().year())
                            .font(.caption)
                            .foregroundStyle(Theme.textSecondary)
                    }
                    .swipeActions {
                        Button("Delete", role: .destructive) {
                            Task { await delete(pk) }
                        }
                        Button("Rename") {
                            renameDraft = pk.deviceName ?? ""
                            renaming = pk
                        }
                        .tint(Theme.accent)
                    }
                }
            }
        } header: {
            Text("Security")
        } footer: {
            if let error {
                Text(error).foregroundStyle(Theme.red)
            } else {
                Text("Set up two-factor auth and register new passkeys in the web dashboard.")
            }
        }
        .task { await load() }
        .alert("Rename Passkey", isPresented: Binding(
            get: { renaming != nil },
            set: { if !$0 { renaming = nil } }
        )) {
            TextField("Device name", text: $renameDraft)
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Save") {
                if let pk = renaming { Task { await rename(pk, to: renameDraft) } }
                renaming = nil
            }
        }
    }

    private func load() async {
        guard let client = app.api() else { return }
        do {
            async let m = client.mfaStatus()
            async let p = client.passkeys()
            mfa = try await m
            passkeys = try await p
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func rename(_ pk: Passkey, to name: String) async {
        guard let client = app.api(), !name.isEmpty else { return }
        do {
            try await client.renamePasskey(id: pk.id, name: name)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func delete(_ pk: Passkey) async {
        guard let client = app.api() else { return }
        do {
            try await client.deletePasskey(id: pk.id)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Account export (GET /api/export) — fetches the full JSON dump and hands it
/// to the system share sheet as a file.
struct ExportSection: View {
    @Environment(AppState.self) private var app

    @State private var busy = false
    @State private var exportURL: URL?
    @State private var error: String?

    var body: some View {
        Section {
            Button {
                Task { await export() }
            } label: {
                if busy {
                    HStack { Label("Exporting…", systemImage: "square.and.arrow.up"); Spacer(); ProgressView() }
                } else {
                    Label("Export Account Data", systemImage: "square.and.arrow.up")
                }
            }
            .disabled(busy)
        } header: {
            Text("Data")
        } footer: {
            if let error {
                Text(error).foregroundStyle(Theme.red)
            } else {
                Text("Aliases, domains, destinations, and rules as JSON. Requires a recent sign-in.")
            }
        }
        .sheet(item: $exportURL) { url in
            ShareSheet(url: url)
        }
    }

    private func export() async {
        guard let client = app.api() else { return }
        busy = true
        defer { busy = false }
        do {
            let data = try await client.exportData()
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("hidemyemail-export.json")
            try data.write(to: url)
            error = nil
            exportURL = url
        } catch {
            self.error = error.localizedDescription
        }
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

/// UIKit share sheet wrapper (ShareLink can't trigger from an async fetch).
private struct ShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
