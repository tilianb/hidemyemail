import SwiftUI

struct DestinationsView: View {
    @Environment(AppState.self) private var app

    @State private var destinations: [Destination] = []
    @State private var loading = false
    @State private var error: String?
    @State private var showAdd = false
    @State private var newEmail = ""

    var body: some View {
        NavigationStack {
            Group {
                if loading && destinations.isEmpty {
                    ProgressView()
                } else if destinations.isEmpty {
                    ContentUnavailableView(
                        "No destinations",
                        systemImage: "tray",
                        description: Text("Add an inbox to forward your aliases to.")
                    )
                } else {
                    List {
                        ForEach(destinations) { dest in
                            row(dest)
                        }
                        .onDelete(perform: delete)
                    }
                }
            }
            .navigationTitle("Destinations")
            .refreshable { await reload() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Add", systemImage: "plus") { showAdd = true }
                }
            }
            .alert("Add Destination", isPresented: $showAdd) {
                TextField("you@example.com", text: $newEmail)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                Button("Cancel", role: .cancel) { newEmail = "" }
                Button("Add") { Task { await add() } }
            } message: {
                Text("We'll email a verification link before it can receive forwarded mail.")
            }
            .overlay(alignment: .bottom) {
                if let error { ErrorBanner(message: error) }
            }
            .task { if destinations.isEmpty { await reload() } }
        }
    }

    private func row(_ dest: Destination) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(dest.email)
                HStack(spacing: 6) {
                    if dest.isDefaultDestination {
                        Label("Default", systemImage: "star.fill")
                            .font(.caption2)
                            .foregroundStyle(Theme.accent)
                    }
                    if dest.isVerified {
                        Label("Verified", systemImage: "checkmark.seal.fill")
                            .font(.caption2)
                            .foregroundStyle(Theme.green)
                    } else {
                        Label("Pending", systemImage: "clock")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Spacer()
            if !dest.isDefaultDestination && dest.isVerified {
                Button("Make Default") { Task { await makeDefault(dest) } }
                    .font(.caption)
                    .buttonStyle(.borderless)
            }
        }
    }

    private func reload() async {
        guard let client = app.api() else { return }
        loading = true
        defer { loading = false }
        do { destinations = try await client.destinations(); error = nil }
        catch { handle(error) }
    }

    private func add() async {
        let email = newEmail.trimmingCharacters(in: .whitespaces)
        newEmail = ""
        guard let client = app.api(), !email.isEmpty else { return }
        do { try await client.createDestination(email: email); await reload() }
        catch { handle(error) }
    }

    private func makeDefault(_ dest: Destination) async {
        guard let client = app.api() else { return }
        do { try await client.setDefaultDestination(id: dest.id); await reload() }
        catch { handle(error) }
    }

    private func delete(_ offsets: IndexSet) {
        let targets = offsets.map { destinations[$0] }
        Task {
            guard let client = app.api() else { return }
            for d in targets {
                do { try await client.deleteDestination(id: d.id) }
                catch { handle(error); break }
            }
            await reload()
        }
    }

    private func handle(_ error: Error) {
        if let err = error as? APIError, err.isAuthFailure {
            Task { await app.handleAuthFailure() }
        } else {
            self.error = error.localizedDescription
        }
    }
}
