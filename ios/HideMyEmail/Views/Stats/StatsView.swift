import SwiftUI

struct StatsView: View {
    @Environment(AppState.self) private var app

    @State private var stats: Stats?
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.canvas.ignoresSafeArea()
                Group {
                if let stats {
                    List {
                        Section("Totals") {
                            metricRow("Aliases", stats.totals.aliases)
                            metricRow("Active", stats.totals.active, color: Theme.green)
                        }
                        Section("Last 24 hours") {
                            metricRow("Forwarded", stats.last24h.forward, color: Theme.green)
                            metricRow("Replied", stats.last24h.reply, color: Theme.accent)
                            metricRow("Blocked", stats.last24h.block, color: Theme.red)
                            metricRow("Rejected", stats.last24h.reject, color: Theme.red)
                            metricRow("Errors", stats.last24h.error, color: Theme.red)
                        }
                        if !stats.topAliases.isEmpty {
                            Section("Top aliases") {
                                ForEach(stats.topAliases) { top in
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(top.fullAddress).font(Theme.mono(14)).lineLimit(1)
                                        Text("\(top.fwdCount) forwarded · \(top.replyCount) replied · \(top.blockedCount) blocked")
                                            .font(.caption)
                                            .foregroundStyle(Theme.textSecondary)
                                    }
                                }
                            }
                        }
                    }
                    .scrollContentBackground(.hidden)
                } else if loading {
                    ProgressView()
                } else {
                    ContentUnavailableView("No stats", systemImage: "chart.bar")
                }
                }
            }
            .navigationTitle("Stats")
            .refreshable { await reload() }
            .overlay(alignment: .bottom) {
                if let error { ErrorBanner(message: error) }
            }
            .task { await reload() }
        }
    }

    private func metricRow(_ title: String, _ value: Int, color: Color = .primary) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text("\(value)").font(.body.monospacedDigit()).foregroundStyle(color)
        }
    }

    private func reload() async {
        guard let client = app.api() else { return }
        loading = true
        defer { loading = false }
        do { stats = try await client.stats(); error = nil }
        catch let err as APIError {
            if err.isAuthFailure { await app.handleAuthFailure(from: client) } else { error = err.localizedDescription }
        } catch {
            self.error = error.localizedDescription
        }
    }
}
