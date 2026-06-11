import SwiftUI

/// Manage personal subdomains (`name.<base global domain>`). Mirrors the create /
/// list / delete subset of the web dashboard's `dashboard/src/pages/Domains.tsx`.
/// Pushed inside Settings' NavigationStack, so this view owns no stack of its own.
struct SubdomainsView: View {
    @Environment(AppState.self) private var app

    @State private var domains: [Domain] = []
    @State private var destinations: [Destination] = []
    @State private var maxSubdomains = -1
    @State private var loading = false
    @State private var error: String?

    // Create form
    @State private var prefix = ""
    @State private var baseDomainId: Int?
    @State private var selectedDestination = "global"   // "global" or a verified email
    @State private var creating = false

    // Delete confirmation
    @State private var pendingDelete: Domain?

    // Destination edit sheet
    @State private var editing: Domain?

    private var baseDomains: [Domain] { domains.filter { $0.canHostSubdomains } }
    private var personalSubdomains: [Domain] { domains.filter { $0.isPersonal } }
    private var verifiedDestinations: [Destination] { destinations.filter { $0.isVerified } }

    private var selectedBaseDomain: Domain? {
        domains.first { $0.id == baseDomainId } ?? baseDomains.first
    }

    private var canCreate: Bool {
        !creating && !prefix.isEmpty && selectedBaseDomain != nil && !verifiedDestinations.isEmpty
    }

    private var quotaLabel: String {
        maxSubdomains >= 0
            ? "\(personalSubdomains.count) / \(maxSubdomains) used"
            : "\(personalSubdomains.count) used"
    }

    var body: some View {
        NavigationStack {
            Form {
                addSection
                listSection
            }
            .themedScrollBackground()
            .navigationTitle("Domains")
            .overlay(alignment: .bottom) {
                if let error { ErrorBanner(message: error) }
            }
            .confirmationDialog(
                pendingDelete.map { "Delete \($0.domain) and all its aliases?" } ?? "",
                isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) {
                    if let d = pendingDelete { Task { await remove(d) } }
                }
                Button("Cancel", role: .cancel) { pendingDelete = nil }
            }
            .task { if domains.isEmpty { await reload() } }
            .sheet(item: $editing) { d in
                EditSubdomainView(domain: d, destinations: verifiedDestinations) {
                    await reload()
                }
            }
        }
    }

    // MARK: - Create

    @ViewBuilder
    private var addSection: some View {
        Section("Add Subdomain (\(quotaLabel))") {
            if loading && domains.isEmpty {
                HStack { Spacer(); ProgressView(); Spacer() }
            } else if baseDomains.isEmpty {
                Text("No global domains currently allow subdomain aliases.")
                    .foregroundStyle(.secondary).font(.footnote)
            } else if verifiedDestinations.isEmpty {
                Text("Verify a destination email first.")
                    .foregroundStyle(.secondary).font(.footnote)
            } else {
                HStack(spacing: 2) {
                    TextField("name", text: $prefix)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: prefix) { _, newValue in
                            prefix = newValue.lowercased().filter { $0.isLowercase || $0.isNumber || $0 == "-" }
                        }
                    Text(".\(selectedBaseDomain?.domain ?? "")")
                        .font(Theme.mono(13))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                }

                if baseDomains.count > 1 {
                    Picker("Base domain", selection: $baseDomainId) {
                        ForEach(baseDomains) { d in
                            Text(d.domain).tag(Optional(d.id))
                        }
                    }
                }

                Picker("Default destination", selection: $selectedDestination) {
                    Text("Global default").tag("global")
                    ForEach(verifiedDestinations, id: \.id) { dest in
                        Text(dest.email).tag(dest.email)
                    }
                }

                Button {
                    Task { await create() }
                } label: {
                    if creating { ProgressView() } else { Text("Add Subdomain") }
                }
                .disabled(!canCreate)
            }
        }
    }

    // MARK: - List

    @ViewBuilder
    private var listSection: some View {
        Section("Your Subdomains") {
            if personalSubdomains.isEmpty {
                Text(loading ? "Loading…" : "No subdomains yet.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(personalSubdomains) { d in
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(d.domain).font(Theme.mono(14))
                            Text(destinationLabel(for: d))
                                .font(.caption)
                                .foregroundStyle(Theme.textSecondary)
                        }
                        Spacer()
                        // Visible affordance: the whole row also opens the editor.
                        HStack(spacing: 5) {
                            Image(systemName: "pencil")
                            Text("Edit")
                                .font(Theme.body(13, .medium))
                        }
                        .foregroundStyle(Theme.accent)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(Capsule().fill(Theme.accentDim))
                    }
                    .swipeActions {
                        Button("Delete", role: .destructive) { pendingDelete = d }
                        Button("Edit") { editing = d }.tint(Theme.accent)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { editing = d }
                }
            }
        }
    }

    private func destinationLabel(for d: Domain) -> String {
        switch d.defaultDestination {
        case nil: return "Drops mail (no destination)"
        case "global": return "Global default"
        case let email?: return "→ \(email)"
        }
    }

    // MARK: - Actions

    private func reload() async {
        guard let client = app.api() else { return }
        loading = true
        defer { loading = false }
        do {
            async let d = client.domains()
            async let dest = client.destinations()
            async let conf = client.config()
            domains = try await d
            destinations = try await dest
            maxSubdomains = try await conf.maxSubdomains
            if baseDomainId == nil || !baseDomains.contains(where: { $0.id == baseDomainId }) {
                baseDomainId = baseDomains.first?.id
            }
            error = nil
        } catch { handle(error) }
    }

    private func create() async {
        guard let client = app.api(), let base = selectedBaseDomain else { return }
        creating = true
        defer { creating = false }
        do {
            try await client.createDomain(
                prefix: prefix,
                defaultDestination: selectedDestination,
                baseDomainId: base.id
            )
            prefix = ""
            selectedDestination = "global"
            await reload()
        } catch { handle(error) }
    }

    private func remove(_ d: Domain) async {
        pendingDelete = nil
        guard let client = app.api() else { return }
        do { try await client.deleteDomain(id: d.id); await reload() }
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

/// Edit a personal subdomain's default destination — the native counterpart of
/// the dashboard's inline destination editor on the Domains page.
private struct EditSubdomainView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss

    let domain: Domain
    let destinations: [Destination]
    let onSave: () async -> Void

    @State private var selection: String
    @State private var saving = false
    @State private var error: String?

    init(domain: Domain, destinations: [Destination], onSave: @escaping () async -> Void) {
        self.domain = domain
        self.destinations = destinations
        self.onSave = onSave
        _selection = State(initialValue: domain.defaultDestination ?? "global")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Default destination", selection: $selection) {
                        Text("Global default").tag("global")
                        ForEach(destinations, id: \.id) { dest in
                            Text(dest.email).tag(dest.email)
                        }
                    }
                } header: {
                    Text(domain.domain)
                } footer: {
                    Text("Where mail to this subdomain's aliases is forwarded unless an alias overrides it.")
                }

                if let error {
                    Text(error).foregroundStyle(Theme.red).font(.footnote)
                }
            }
            .themedScrollBackground()
            .navigationTitle("Edit Subdomain")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(saving || selection == (domain.defaultDestination ?? "global"))
                }
            }
        }
    }

    private func save() async {
        guard let client = app.api() else { return }
        saving = true
        defer { saving = false }
        do {
            try await client.updateDomainDestination(id: domain.id, destination: selection)
            await onSave()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
