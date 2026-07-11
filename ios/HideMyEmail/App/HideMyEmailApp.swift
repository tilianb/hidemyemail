import SwiftUI

@main
struct HideMyEmailApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
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
                .task {
                    PushManager.shared.attach(app)
                    await app.bootstrap()
                }
        }
    }
}
