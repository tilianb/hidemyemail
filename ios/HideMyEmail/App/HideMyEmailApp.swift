import SwiftUI

@main
struct HideMyEmailApp: App {
    @State private var app = AppState()

    init() {
        Theme.configureAppearance()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .brandTint()
                .font(Theme.body(17))
                .preferredColorScheme(.dark)
                .task { await app.bootstrap() }
        }
    }
}
