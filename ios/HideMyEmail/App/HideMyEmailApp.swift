import SwiftUI

@main
struct HideMyEmailApp: App {
    @State private var app = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .brandTint()
                .task { await app.bootstrap() }
        }
    }
}
