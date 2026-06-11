import SwiftUI

/// Colors lifted from the web dashboard (`dashboard/src/index.css`) so the app
/// feels like part of the same product.
enum Theme {
    static let accent = Color(red: 1.0, green: 0.70, blue: 0.0)      // #ffb300
    static let green = Color(red: 0.24, green: 0.86, blue: 0.52)     // #3ddc84
    static let red = Color(red: 1.0, green: 0.31, blue: 0.31)        // #ff5050
}

extension View {
    /// Applies the brand tint consistently across the app's controls.
    func brandTint() -> some View { self.tint(Theme.accent) }
}
