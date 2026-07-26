import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

/// Web-session login for self-hosted servers.
///
/// The iOS binary can only carry `webcredentials` associations for our own
/// domain, so native passkey sheets cannot work against an arbitrary
/// self-hosted host. Instead we open the server's own dashboard login in an
/// `ASWebAuthenticationSession` — passkeys work there because the ceremony is
/// associated with the server's domain via the web, not the app. The dashboard
/// then hands back a short-lived code over our custom URL scheme, which the
/// app exchanges (PKCE-style, with a verifier that never leaves the device)
/// for a bearer token.
@MainActor
final class WebSessionAuthenticator: NSObject, ASWebAuthenticationPresentationContextProviding {
    nonisolated static let callbackScheme = "hidemyemail"

    struct Handoff {
        let code: String
        let verifier: String
    }

    /// ASWebAuthenticationSession must be kept alive for the whole ceremony —
    /// nothing else holds a strong reference once `start()` returns, and a
    /// deallocated session cancels (or never delivers) the callback. `self` is
    /// retained by the suspended `authenticate(server:)` frame, which keeps
    /// this reference valid until the completion handler clears it.
    private var activeSession: ASWebAuthenticationSession?

    func cancel() {
        activeSession?.cancel()
        activeSession = nil
    }

    nonisolated static func isValidCallback(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return components.scheme == callbackScheme && components.host == "auth" &&
            components.path.isEmpty && components.user == nil &&
            components.password == nil && components.port == nil && components.fragment == nil &&
            components.queryItems?.filter { $0.name == "code" }.count == 1 &&
            components.queryItems?.first(where: { $0.name == "code" })?.value?.isEmpty == false
    }

    func authenticate(server: URL) async throws -> Handoff {
        let verifier = Self.randomVerifier()
        let challenge = Self.challenge(for: verifier)

        var components = URLComponents(url: server, resolvingAgainstBaseURL: false)!
        components.path = "/app-auth"
        components.queryItems = [URLQueryItem(name: "challenge", value: challenge)]
        guard let url = components.url else { throw APIError.notConfigured }

        let callbackURL: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: Self.callbackScheme
            ) { [weak self] callbackURL, error in
                Task { @MainActor in self?.activeSession = nil }
                if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else {
                    continuation.resume(throwing: error ?? APIError.server(status: -1, message: "Sign-in was cancelled"))
                }
            }
            session.presentationContextProvider = self
            // An ephemeral session would forget the server's cookies each time;
            // keeping shared storage lets returning users skip straight through.
            session.prefersEphemeralWebBrowserSession = false
            activeSession = session
            session.start()
        }

        guard Self.isValidCallback(callbackURL),
              let items = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems,
              let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
            throw APIError.server(status: -1, message: "The server returned no sign-in code")
        }
        return Handoff(code: code, verifier: verifier)
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                .first ?? ASPresentationAnchor()
        }
    }

    private static func randomVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64urlEncodedString()
    }

    /// base64url SHA-256 — must match the Worker's `sha256Base64url`.
    private static func challenge(for verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64urlEncodedString()
    }
}
