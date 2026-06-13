import SwiftUI

struct RootView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        switch app.phase {
        case .loggedOut:
            LoginView()
        case .awaitingMFA:
            MFAView()
        case .loggedIn:
            MainTabView()
        }
    }
}
