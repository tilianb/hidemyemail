import SwiftUI

struct MainTabView: View {
    var body: some View {
        TabView {
            AliasListView()
                .tabItem { Label("Aliases", systemImage: "at") }
            SubdomainsView()
                .tabItem { Label("Domains", systemImage: "globe") }
            StatsView()
                .tabItem { Label("Stats", systemImage: "chart.bar") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}
