import SwiftUI

struct MainTabView: View {
    var body: some View {
        TabView {
            AliasListView()
                .tabItem { Label("Aliases", systemImage: "at") }
            SubdomainsView()
                .tabItem { Label("Domains", systemImage: "globe") }
            BlocksView()
                .tabItem { Label("Rules", systemImage: "shield.lefthalf.filled") }
            StatsView()
                .tabItem { Label("Stats", systemImage: "chart.bar") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}
