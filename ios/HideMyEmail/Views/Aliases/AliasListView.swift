import SwiftUI
import UIKit

struct AliasListView: View {
    @Environment(AppState.self) private var app

    @State private var aliases: [Alias] = []
    @State private var search = ""
    @State private var loading = false
    @State private var error: String?
    @State private var showCreate = false

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.canvas.ignoresSafeArea()
                Group {
                    if loading && aliases.isEmpty {
                        ProgressView()
                    } else if aliases.isEmpty {
                        ContentUnavailableView(
                            "No aliases yet",
                            systemImage: "at",
                            description: Text("Tap + to create your first alias.")
                        )
                    } else {
                        List {
                            ForEach(aliases) { alias in
                                NavigationLink(value: alias) {
                                    AliasRowView(alias: alias)
                                }
                                .contextMenu {
                                    Button("Copy", systemImage: "doc.on.doc") {
                                        UIPasteboard.general.string = alias.fullAddress
                                    }
                                    ShareLink(item: alias.fullAddress) {
                                        Label("Share", systemImage: "square.and.arrow.up")
                                    }
                                }
                            }
                            .onDelete(perform: delete)
                        }
                        .listStyle(.plain)
                        .scrollContentBackground(.hidden)
                    }
                }
            }
            .navigationTitle("Aliases")
            .searchable(text: $search, prompt: "Search aliases")
            .onChange(of: search) { _, _ in Task { await reload() } }
            .refreshable { await reload() }
            .navigationDestination(for: Alias.self) { alias in
                AliasDetailView(alias: alias) { await reload() }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New alias", systemImage: "plus") { showCreate = true }
                }
            }
            .sheet(isPresented: $showCreate) {
                CreateAliasView { await reload() }
            }
            .overlay(alignment: .bottom) {
                if let error { ErrorBanner(message: error) }
            }
            .task { if aliases.isEmpty { await reload() } }
        }
    }

    private func reload() async {
        guard let client = app.api() else { return }
        loading = true
        defer { loading = false }
        do {
            aliases = try await client.aliases(query: search)
            error = nil
        } catch let err as APIError {
            if err.isAuthFailure { await app.handleAuthFailure(from: client) } else { error = err.localizedDescription }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func delete(_ offsets: IndexSet) {
        let targets = offsets.map { aliases[$0] }
        aliases.remove(atOffsets: offsets)
        Task {
            guard let client = app.api() else { return }
            for alias in targets {
                try? await client.deleteAlias(id: alias.id)
            }
            await reload()
        }
    }
}

struct AliasRowView: View {
    let alias: Alias

    @State private var copied = false

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(alias.isActive ? Theme.green : Color.secondary.opacity(0.4))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(alias.label ?? alias.fullAddress)
                    .font(alias.label != nil ? Theme.body(16) : Theme.mono(14))
                    .lineLimit(1)
                if alias.label != nil {
                    Text(alias.fullAddress)
                        .font(Theme.mono(12))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            Button(action: copy) {
                HStack(spacing: 5) {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    Text(copied ? "Copied" : "Copy")
                        .font(Theme.body(13, .medium))
                }
                .foregroundStyle(copied ? Theme.green : Theme.accent)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    Capsule().fill((copied ? Theme.green : Theme.accent).opacity(0.15))
                )
                .contentShape(Capsule())
            }
            // Borderless so the tap copies instead of triggering the row's
            // NavigationLink push.
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 2)
    }

    private func copy() {
        UIPasteboard.general.string = alias.fullAddress
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        withAnimation { copied = true }
        Task {
            try? await Task.sleep(for: .seconds(1.2))
            withAnimation { copied = false }
        }
    }
}

struct ErrorBanner: View {
    let message: String
    var body: some View {
        Text(message)
            .font(.footnote)
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Theme.red, in: Capsule())
            .padding(.bottom, 8)
            .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}
