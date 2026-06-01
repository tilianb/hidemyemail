import SwiftUI

struct MainTabView: View {
    var body: some View {
        TabView {
            AliasListView()
                .tabItem { Label("Aliases", systemImage: "at") }
            DestinationsView()
                .tabItem { Label("Destinations", systemImage: "tray.and.arrow.down") }
            StatsView()
                .tabItem { Label("Stats", systemImage: "chart.bar") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}
