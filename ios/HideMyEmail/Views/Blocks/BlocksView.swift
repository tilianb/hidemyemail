import SwiftUI

/// Manage sender allow/block rules — the native counterpart of the
/// dashboard's Blocks page. Block rules drop matching senders before
/// forwarding; any allow rule flips its scope into allowlist mode (only
/// matching senders get through). A matching block always wins over an allow.
struct BlocksView: View {
    @Environment(AppState.self) private var app

    @State private var blocks: [Block] = []
    @State private var domains: [Domain] = []
    @State private var aliases: [Alias] = []
    @State private var loading = false
    @State private var error: String?
    @State private var showCreate = false

    private var accountRules: [Block] { blocks.filter { $0.aliasId == nil && $0.domainId == nil } }
    private var subdomainRules: [Block] { blocks.filter { $0.domainId != nil } }
    private var aliasRules: [Block] { blocks.filter { $0.aliasId != nil } }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.canvas.ignoresSafeArea()
                Group {
                    if loading && blocks.isEmpty {
                        ProgressView()
                    } else if blocks.isEmpty {
                        ContentUnavailableView(
                            "No rules yet",
                            systemImage: "shield.lefthalf.filled",
                            description: Text("Block senders like *@spam.com, or add allow rules to lock a scope down to known senders.")
                        )
                    } else {
                        List {
                            if !accountRules.isEmpty {
                                Section("Account-wide") {
                                    ForEach(accountRules) { RuleRow(block: $0, scope: scopeText($0)) }
                                        .onDelete { delete($0, from: accountRules) }
                                }
                            }
                            if !subdomainRules.isEmpty {
                                Section("Subdomains") {
                                    ForEach(subdomainRules) { RuleRow(block: $0, scope: scopeText($0)) }
                                        .onDelete { delete($0, from: subdomainRules) }
                                }
                            }
                            if !aliasRules.isEmpty {
                                Section("Single aliases") {
                                    ForEach(aliasRules) { RuleRow(block: $0, scope: scopeText($0)) }
                                        .onDelete { delete($0, from: aliasRules) }
                                }
                            }
                        }
                        .scrollContentBackground(.hidden)
                    }
                }
            }
            .navigationTitle("Rules")
            .refreshable { await reload() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New rule", systemImage: "plus") { showCreate = true }
                }
            }
            .sheet(isPresented: $showCreate) {
                CreateBlockView(domains: domains.filter(\.isPersonal), aliases: aliases) {
                    await reload()
                }
            }
            .overlay(alignment: .bottom) {
                if let error { ErrorBanner(message: error) }
            }
            .task { if blocks.isEmpty { await reload() } }
        }
    }

    private func scopeText(_ b: Block) -> String {
        if let aliasId = b.aliasId {
            return aliases.first { $0.id == aliasId }?.fullAddress ?? "alias #\(aliasId)"
        }
        if let domainId = b.domainId {
            return domains.first { $0.id == domainId }?.domain ?? "subdomain #\(domainId)"
        }
        return "every alias"
    }

    private func reload() async {
        guard let client = app.api() else { return }
        loading = true
        defer { loading = false }
        do {
            async let b = client.blocks()
            async let d = client.domains()
            async let a = client.aliases()
            (blocks, domains, aliases) = try await (b, d, a)
            error = nil
        } catch { handle(error, from: client) }
    }

    private func delete(_ offsets: IndexSet, from group: [Block]) {
        let targets = offsets.map { group[$0] }
        blocks.removeAll { rule in targets.contains(rule) }
        Task {
            guard let client = app.api() else { return }
            for rule in targets {
                do { try await client.deleteBlock(id: rule.id) } catch { handle(error, from: client) }
            }
            await reload()
        }
    }

    private func handle(_ error: Error, from client: APIClient) {
        if let err = error as? APIError, err.isAuthFailure {
            Task { await app.handleAuthFailure(from: client) }
        } else {
            self.error = error.localizedDescription
        }
    }
}

private struct RuleRow: View {
    let block: Block
    let scope: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: block.isAllow ? "checkmark.shield.fill" : "hand.raised.fill")
                .foregroundStyle(block.isAllow ? Theme.green : Theme.red)
            VStack(alignment: .leading, spacing: 2) {
                Text(block.pattern).font(Theme.mono(13)).lineLimit(1)
                Text(scope).font(.caption).foregroundStyle(Theme.textSecondary).lineLimit(1)
            }
            Spacer()
            Text(block.isAllow ? "ALLOW" : "BLOCK")
                .font(Theme.body(10, .semibold))
                .foregroundStyle(block.isAllow ? Theme.green : Theme.red)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(Capsule().fill((block.isAllow ? Theme.green : Theme.red).opacity(0.15)))
        }
    }
}

private struct CreateBlockView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss

    let domains: [Domain]
    let aliases: [Alias]
    let onCreate: () async -> Void

    private enum Scope: Hashable {
        case account
        case domain(Int)
        case alias(Int)
    }

    @State private var pattern = ""
    @State private var kind = "block"
    @State private var scope: Scope = .account
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("*@spam.com or evil@badactor.org", text: $pattern)
                        .font(Theme.mono(14))
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Sender pattern")
                } footer: {
                    Text("Wildcards match anything: *@spam.com blocks a whole domain.")
                }

                Section("Type") {
                    Picker("Type", selection: $kind) {
                        Text("Block").tag("block")
                        Text("Allow").tag("allow")
                    }
                    .pickerStyle(.segmented)
                }

                Section {
                    Picker("Applies to", selection: $scope) {
                        Text("Every alias").tag(Scope.account)
                        ForEach(domains) { d in
                            Text(d.domain).tag(Scope.domain(d.id))
                        }
                        ForEach(aliases) { a in
                            Text(a.fullAddress).tag(Scope.alias(a.id))
                        }
                    }
                } header: {
                    Text("Scope")
                } footer: {
                    if kind == "allow" {
                        Text("An allow rule switches its scope to allowlist mode: only matching senders are forwarded.")
                    }
                }
            }
            .themedScrollBackground()
            .navigationTitle("New Rule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(saving ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(pattern.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
            .overlay(alignment: .bottom) {
                if let error { ErrorBanner(message: error) }
            }
        }
    }

    private func save() async {
        guard let client = app.api() else { return }
        saving = true
        defer { saving = false }
        var aliasId: Int?
        var domainId: Int?
        switch scope {
        case .account: break
        case .domain(let id): domainId = id
        case .alias(let id): aliasId = id
        }
        do {
            _ = try await client.createBlock(
                pattern: pattern.trimmingCharacters(in: .whitespaces),
                kind: kind,
                aliasId: aliasId,
                domainId: domainId
            )
            await onCreate()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
