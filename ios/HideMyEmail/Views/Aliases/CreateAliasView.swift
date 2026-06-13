import SwiftUI

struct CreateAliasView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss

    let onCreated: () async -> Void

    @State private var domains: [Domain] = []
    @State private var destinations: [Destination] = []
    @State private var selectedDomainId: Int?
    @State private var localPart = ""
    @State private var label = ""
    @State private var selectedDestination: String = ""   // "" = use default
    @State private var loading = true
    @State private var busy = false
    @State private var error: String?

    private var selectedDomain: Domain? {
        domains.first { $0.id == selectedDomainId }
    }

    // Global domains without custom-alias permission generate a random local part
    // server-side, so we hide/relax the field in that case.
    private var localPartRequired: Bool {
        guard let d = selectedDomain else { return true }
        return !d.isGlobalDomain || d.allowsCustomAliases
    }

    var body: some View {
        NavigationStack {
            Form {
                if loading {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if domains.isEmpty {
                    ContentUnavailableView(
                        "No domains available",
                        systemImage: "globe",
                        description: Text("Add and verify a domain in the web dashboard first.")
                    )
                } else {
                    Section("Domain") {
                        Picker("Domain", selection: $selectedDomainId) {
                            ForEach(domains) { domain in
                                Text(domain.domain).tag(Optional(domain.id))
                            }
                        }
                    }

                    Section("Alias") {
                        if localPartRequired {
                            HStack(spacing: 2) {
                                TextField("local-part", text: $localPart)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                Text("@\(selectedDomain?.domain ?? "")")
                                    .font(Theme.mono(13))
                                    .foregroundStyle(Theme.textSecondary)
                                    .lineLimit(1)
                            }
                        } else {
                            Text("A random alias will be generated.")
                                .foregroundStyle(.secondary)
                        }
                        TextField("Label (optional)", text: $label)
                    }

                    Section("Forward to") {
                        Picker("Destination", selection: $selectedDestination) {
                            Text("Default destination").tag("")
                            ForEach(verifiedDestinations, id: \.id) { dest in
                                Text(dest.email).tag(dest.email)
                            }
                        }
                    }
                }

                if let error {
                    Text(error).foregroundStyle(Theme.red).font(.footnote)
                }
            }
            .themedScrollBackground()
            .navigationTitle("New Alias")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await create() } }
                        .disabled(busy || selectedDomainId == nil || (localPartRequired && localPart.isEmpty))
                }
            }
            .task { await load() }
        }
    }

    private var verifiedDestinations: [Destination] {
        destinations.filter { $0.isVerified }
    }

    private func load() async {
        guard let client = app.api() else { return }
        loading = true
        defer { loading = false }
        do {
            async let d = client.domains()
            async let dest = client.destinations()
            domains = try await d.filter { $0.isUsable }
            destinations = try await dest
            if selectedDomainId == nil { selectedDomainId = domains.first?.id }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func create() async {
        guard let client = app.api(), let domainId = selectedDomainId else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await client.createAlias(
                domainId: domainId,
                localPart: localPartRequired ? localPart.lowercased() : "x",
                destination: selectedDestination.isEmpty ? nil : selectedDestination,
                label: label
            )
            await onCreated()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
