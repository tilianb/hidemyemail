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
    @State private var blocks: [Block] = []
    @State private var loadingBlocks = false
    @State private var events: [EmailEvent] = []
    @State private var loadingEvents = false

    // Rules that apply to this alias, in the Worker's resolution order:
    // alias-specific, then its subdomain, then account-wide.
    private var scopedBlocks: [Block] {
        blocks.filter { b in
            b.aliasId == alias.id
                || (b.domainId != nil && b.domainId == alias.domainId)
                || (b.aliasId == nil && b.domainId == nil)
        }
    }

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
                        .font(Theme.mono(15))
                        .textSelection(.enabled)
                    Spacer()
                    Button {
                        UIPasteboard.general.string = alias.fullAddress
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .buttonStyle(.borderless)
                    ShareLink(item: alias.fullAddress) {
                        Image(systemName: "square.and.arrow.up")
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
                if loadingEvents && events.isEmpty {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if events.isEmpty {
                    Text("No mail yet.")
                        .foregroundStyle(Theme.textSecondary)
                } else {
                    ForEach(events.prefix(20)) { eventRow($0) }
                }
            } header: {
                Text("Recent Mail")
            }

            Section {
                if loadingBlocks && blocks.isEmpty {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if scopedBlocks.isEmpty {
                    Text("No allow or block rules apply.")
                        .foregroundStyle(Theme.textSecondary)
                } else {
                    ForEach(scopedBlocks) { ruleRow($0) }
                }
            } header: {
                Text("Allow & Block Rules")
            } footer: {
                Text("Rules from this alias, its subdomain, and account-wide settings. Manage them in the web dashboard.")
            }

            Section {
                Button("Delete Alias", role: .destructive) { showDeleteConfirm = true }
            }
        }
        .themedScrollBackground()
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
        .task { await loadBlocks() }
        .task { await loadEvents() }
        .onDisappear {
            // Persist a pending label edit when the user navigates back without
            // hitting return. Detached from the view's lifecycle so teardown
            // doesn't cancel the request; guarded so we only PATCH on a change.
            if label != (alias.label ?? "") {
                Task { await saveLabel() }
            }
        }
    }

    private func statRow(_ title: String, _ value: Int, color: Color) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text("\(value)").foregroundStyle(color).monospacedDigit()
        }
    }

    private func ruleRow(_ b: Block) -> some View {
        HStack(spacing: 10) {
            Image(systemName: b.isAllow ? "checkmark.shield.fill" : "hand.raised.fill")
                .foregroundStyle(b.isAllow ? Theme.green : Theme.red)
            VStack(alignment: .leading, spacing: 2) {
                Text(b.pattern).font(Theme.mono(13)).lineLimit(1)
                Text(scopeLabel(b)).font(.caption).foregroundStyle(Theme.textSecondary)
            }
            Spacer()
            Text(b.isAllow ? "ALLOW" : "BLOCK")
                .font(Theme.body(10, .semibold))
                .foregroundStyle(b.isAllow ? Theme.green : Theme.red)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(Capsule().fill((b.isAllow ? Theme.green : Theme.red).opacity(0.15)))
        }
    }

    private func scopeLabel(_ b: Block) -> String {
        if b.aliasId == alias.id { return "This alias" }
        if b.domainId != nil { return "Subdomain rule" }
        return "Account-wide"
    }

    private func loadBlocks() async {
        guard let client = app.api() else { return }
        loadingBlocks = true
        defer { loadingBlocks = false }
        do { blocks = try await client.blocks() }
        catch { handle(error) }
    }

    private func loadEvents() async {
        guard let client = app.api() else { return }
        loadingEvents = true
        defer { loadingEvents = false }
        do { events = try await client.events(aliasId: alias.id) }
        catch { handle(error) }
    }

    private func eventRow(_ e: EmailEvent) -> some View {
        HStack(spacing: 10) {
            Image(systemName: eventIcon(e.type))
                .foregroundStyle(eventColor(e.type))
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(e.subject ?? e.externalSender ?? e.detail ?? e.type)
                    .font(Theme.body(14))
                    .lineLimit(1)
                HStack(spacing: 6) {
                    if e.subject != nil, let sender = e.externalSender {
                        Text(sender).font(Theme.mono(11)).lineLimit(1)
                    }
                    Text(e.date, format: .relative(presentation: .named))
                }
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
            }
            Spacer()
            Text(e.type.uppercased())
                .font(Theme.body(9, .semibold))
                .foregroundStyle(eventColor(e.type))
        }
    }

    private func eventIcon(_ type: String) -> String {
        switch type {
        case "forward": return "arrow.right.circle.fill"
        case "reply":   return "arrowshape.turn.up.left.circle.fill"
        case "block":   return "hand.raised.fill"
        case "reject":  return "xmark.circle.fill"
        case "bounce", "soft_bounce": return "exclamationmark.triangle.fill"
        default:         return "questionmark.circle"
        }
    }

    private func eventColor(_ type: String) -> Color {
        switch type {
        case "forward": return Theme.green
        case "reply":   return Theme.accent
        case "block", "reject": return Theme.red
        case "bounce", "soft_bounce", "error": return Theme.red
        default:         return Theme.textSecondary
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
