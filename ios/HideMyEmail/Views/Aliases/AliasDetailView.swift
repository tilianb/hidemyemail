import SwiftUI
import UIKit

struct AliasDetailView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss

    let alias: Alias
    let onChange: () async -> Void

    @State private var isActive: Bool
    @State private var label: String
    @State private var error: String?
    @State private var showDeleteConfirm = false

    init(alias: Alias, onChange: @escaping () async -> Void) {
        self.alias = alias
        self.onChange = onChange
        _isActive = State(initialValue: alias.isActive)
        _label = State(initialValue: alias.label ?? "")
    }

    var body: some View {
        Form {
            Section {
                HStack {
                    Text(alias.fullAddress)
                        .font(.body.monospaced())
                        .textSelection(.enabled)
                    Spacer()
                    Button {
                        UIPasteboard.general.string = alias.fullAddress
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .buttonStyle(.borderless)
                }
            } header: {
                Text("Address")
            } footer: {
                if let dest = alias.destination {
                    Text("Forwards to \(dest)")
                }
            }

            Section("Settings") {
                Toggle("Active", isOn: $isActive)
                    .onChange(of: isActive) { _, newValue in
                        Task { await setActive(newValue) }
                    }
                TextField("Label", text: $label)
                    .onSubmit { Task { await saveLabel() } }
            }

            Section("Activity") {
                statRow("Forwarded", alias.fwdCount, color: Theme.green)
                statRow("Replied", alias.replyCount, color: Theme.accent)
                statRow("Blocked", alias.blockedCount, color: Theme.red)
            }

            Section {
                Button("Delete Alias", role: .destructive) { showDeleteConfirm = true }
            }
        }
        .navigationTitle(alias.label ?? alias.localPart)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Delete this alias?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await deleteAlias() } }
        } message: {
            Text("Mail sent to \(alias.fullAddress) will be rejected. This cannot be undone.")
        }
        .overlay(alignment: .bottom) {
            if let error { ErrorBanner(message: error) }
        }
    }

    private func statRow(_ title: String, _ value: Int, color: Color) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text("\(value)").foregroundStyle(color).monospacedDigit()
        }
    }

    private func setActive(_ value: Bool) async {
        guard let client = app.api() else { return }
        do { try await client.setAliasActive(id: alias.id, active: value); await onChange() }
        catch { isActive = !value; handle(error) }
    }

    private func saveLabel() async {
        guard let client = app.api() else { return }
        do {
            try await client.updateAliasLabel(id: alias.id, label: label.isEmpty ? nil : label)
            await onChange()
        } catch { handle(error) }
    }

    private func deleteAlias() async {
        guard let client = app.api() else { return }
        do { try await client.deleteAlias(id: alias.id); await onChange(); dismiss() }
        catch { handle(error) }
    }

    private func handle(_ error: Error) {
        if let err = error as? APIError, err.isAuthFailure {
            Task { await app.handleAuthFailure() }
        } else {
            self.error = error.localizedDescription
        }
    }
}
