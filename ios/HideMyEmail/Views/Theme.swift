import SwiftUI
import UIKit

/// Design tokens lifted from the web dashboard (`dashboard/src/index.css`) so the
/// native app reads as the same product: a dark "privacy console" with a phosphor
/// amber accent, layered near-black surfaces, and the same three typefaces
/// (Bricolage Grotesque display / IBM Plex Sans body / JetBrains Mono data).
enum Theme {
    // MARK: Canvas layers (--canvas / --surface-*)
    static let canvas       = Color(hex: 0x0d0d0f)
    static let surface0     = Color(hex: 0x111114)
    static let surface1     = Color(hex: 0x18181d)
    static let surface2     = Color(hex: 0x1f1f26)
    static let surface3     = Color(hex: 0x26262f)
    static let border       = Color.white.opacity(0.07)
    static let borderStrong = Color.white.opacity(0.13)

    // MARK: Accent — phosphor amber
    static let accent      = Color(hex: 0xffb300)
    static let accentDim   = Color(hex: 0xffb300).opacity(0.15)
    static let accentHover = Color(hex: 0xffc933)

    // MARK: Text
    static let textPrimary   = Color(hex: 0xe8e8ec)
    static let textSecondary = Color(hex: 0x9898a8)
    static let textMuted     = Color(hex: 0x55555f)

    // MARK: Semantic
    static let green = Color(hex: 0x3ddc84)
    static let red   = Color(hex: 0xff5050)
    static let blue  = Color(hex: 0x6cb4ff)

    // MARK: - Typography (PostScript names of the bundled static instances)
    enum DisplayWeight: String {
        case regular  = "BricolageGrotesque-Regular"
        case medium   = "BricolageGrotesque-Medium"
        case semibold = "BricolageGrotesque-SemiBold"
        case bold     = "BricolageGrotesque-Bold"
    }
    enum BodyWeight: String {
        case regular  = "IBMPlexSans-Regular"
        case medium   = "IBMPlexSans-Medium"
        case semibold = "IBMPlexSans-SemiBold"
    }

    /// Bricolage Grotesque — page titles, section labels, stats.
    static func display(_ size: CGFloat, _ weight: DisplayWeight = .semibold) -> Font {
        Font.custom(weight.rawValue, size: size)
    }
    /// IBM Plex Sans — running body text and controls.
    static func body(_ size: CGFloat = 16, _ weight: BodyWeight = .regular) -> Font {
        Font.custom(weight.rawValue, size: size)
    }
    /// JetBrains Mono — addresses, tokens, any monospaced data.
    static func mono(_ size: CGFloat = 14, medium: Bool = false) -> Font {
        Font.custom(medium ? "JetBrainsMono-Medium" : "JetBrainsMono-Regular", size: size)
    }

    private static func uiFont(_ ps: String, _ size: CGFloat) -> UIFont {
        UIFont(name: ps, size: size) ?? .systemFont(ofSize: size, weight: .semibold)
    }

    // MARK: - Global UIKit appearance (nav bars + tab bar)
    /// Called once at launch. SwiftUI's `Form`/`List` chrome and bars are
    /// UIKit-backed, so the dark canvas, amber tint, and display font are wired
    /// through the appearance proxies here rather than per-view.
    static func configureAppearance() {
        let canvasUI = UIColor(canvas)
        let primary  = UIColor(textPrimary)
        let amber     = UIColor(accent)

        let titleAttrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: primary,
            .font: uiFont(DisplayWeight.semibold.rawValue, 17),
        ]
        let largeTitleAttrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: primary,
            .font: uiFont(DisplayWeight.bold.rawValue, 32),
        ]

        // Scrolled state: opaque canvas bar.
        let standard = UINavigationBarAppearance()
        standard.configureWithOpaqueBackground()
        standard.backgroundColor = canvasUI
        standard.shadowColor = UIColor(border)
        standard.titleTextAttributes = titleAttrs
        standard.largeTitleTextAttributes = largeTitleAttrs

        // At-top state: must stay transparent, otherwise the large title fails to
        // render (it needs to sit on the scroll content, not an opaque bar).
        let scrollEdge = UINavigationBarAppearance()
        scrollEdge.configureWithTransparentBackground()
        scrollEdge.backgroundColor = .clear
        scrollEdge.shadowColor = .clear
        scrollEdge.titleTextAttributes = titleAttrs
        scrollEdge.largeTitleTextAttributes = largeTitleAttrs

        UINavigationBar.appearance().standardAppearance = standard
        UINavigationBar.appearance().compactAppearance = standard
        UINavigationBar.appearance().scrollEdgeAppearance = scrollEdge
        UINavigationBar.appearance().tintColor = amber

        let tab = UITabBarAppearance()
        tab.configureWithOpaqueBackground()
        tab.backgroundColor = UIColor(surface0)
        tab.shadowColor = UIColor(border)
        for item in [tab.stackedLayoutAppearance, tab.inlineLayoutAppearance, tab.compactInlineLayoutAppearance] {
            item.selected.iconColor = amber
            item.selected.titleTextAttributes = [.foregroundColor: amber, .font: uiFont(BodyWeight.medium.rawValue, 10)]
            item.normal.iconColor = UIColor(textSecondary)
            item.normal.titleTextAttributes = [.foregroundColor: UIColor(textSecondary), .font: uiFont(BodyWeight.regular.rawValue, 10)]
        }
        UITabBar.appearance().standardAppearance = tab
        UITabBar.appearance().scrollEdgeAppearance = tab
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red:   Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue:  Double(hex & 0xff) / 255,
            opacity: 1
        )
    }
}

extension View {
    /// Applies the brand tint consistently across the app's controls.
    func brandTint() -> some View { self.tint(Theme.accent) }

    /// Swaps SwiftUI's default grouped background for the web's exact canvas and
    /// makes section rows sit on the `surface-1` card colour. Apply to a
    /// `Form`/`List` (or the `Group` wrapping one) at each screen root.
    func themedScrollBackground() -> some View {
        self.scrollContentBackground(.hidden)
            .background(Theme.canvas.ignoresSafeArea())
    }
}
