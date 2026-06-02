import Foundation
import Observation

enum AuthPhase: Equatable {
    case loggedOut
    case awaitingMFA(token: String?)
    case loggedIn
}

@MainActor
@Observable
final class AppState {
    /// The HideMyEmail server origin, e.g. https://app.hidemyemail.dev. Stored
    /// so self-hosters can point the app at their own Worker deployment.
    var serverURLString: String {
        didSet { UserDefaults.standard.set(serverURLString, forKey: Self.serverKey) }
    }

    private(set) var phase: AuthPhase = .loggedOut
    var userName: String = ""
    var isAdmin: Bool = false

    private var client: APIClient?

    private static let serverKey = "server_url"
    static let defaultServer = "https://app.hidemyemail.dev"

    init() {
        let saved = UserDefaults.standard.string(forKey: Self.serverKey)
        self.serverURLString = saved?.isEmpty == false ? saved! : Self.defaultServer
    }

    var hasServer: Bool { baseURL != nil }

    private var baseURL: URL? {
        let trimmed = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme != nil, url.host != nil else { return nil }
        return url
    }

    /// Builds (or rebuilds) the API client for the current server, restoring a
    /// previously stored token if one exists.
    func bootstrap() async {
        guard let baseURL else { phase = .loggedOut; return }
        let token = KeychainStore.loadToken()
        client = APIClient(baseURL: baseURL, token: token)
        guard token != nil else { phase = .loggedOut; return }
        // Validate the restored token by fetching stats.
        do {
            try await refreshIdentity()
            phase = .loggedIn
        } catch {
            await signOut()
        }
    }

    func api() -> APIClient? { client }

    // MARK: - Auth flow

    func login(password: String) async throws {
        guard let baseURL else { throw APIError.notConfigured }
        let client = client ?? APIClient(baseURL: baseURL, token: nil)
        self.client = client

        let res = try await client.login(password: password)
        if res.mfaRequired == true {
            phase = .awaitingMFA(token: res.mfaToken)
            return
        }
        try await finishLogin(token: res.token)
    }

    /// Passwordless login with a platform passkey. Fetches a challenge, runs the
    /// AuthenticationServices assertion, and posts the signed result back. The
    /// relying party is the server host (matching the AASA / entitlement).
    func loginWithPasskey() async throws {
        guard let baseURL else { throw APIError.notConfigured }
        let client = client ?? APIClient(baseURL: baseURL, token: nil)
        self.client = client

        let opts = try await client.passkeyChallenge()
        guard let challengeData = Data(base64urlEncoded: opts.challenge) else {
            throw APIError.server(status: -1, message: "Malformed challenge")
        }
        let rp = opts.rpId ?? baseURL.host ?? "app.hidemyemail.dev"

        let assertion = try await PasskeyAuthenticator().assert(relyingParty: rp, challenge: challengeData)

        var response: [String: Any] = [
            "id": assertion.credentialID.base64urlEncodedString(),
            "rawId": assertion.credentialID.base64urlEncodedString(),
            "type": "public-key",
            "clientExtensionResults": [String: Any](),
            "response": [
                "clientDataJSON": assertion.rawClientDataJSON.base64urlEncodedString(),
                "authenticatorData": assertion.rawAuthenticatorData.base64urlEncodedString(),
                "signature": assertion.signature.base64urlEncodedString(),
                "userHandle": assertion.userID.base64urlEncodedString(),
            ],
        ]
        if let token = opts.passkeyToken { response["passkey_token"] = token }

        let res = try await client.passkeyVerify(assertion: response)
        try await finishLogin(token: res.token)
    }

    func completeMFA(code: String) async throws {
        guard let client else { throw APIError.notConfigured }
        let mfaToken: String?
        if case .awaitingMFA(let t) = phase { mfaToken = t } else { mfaToken = nil }
        let res = try await client.completeMFA(code: code, mfaToken: mfaToken)
        try await finishLogin(token: res.token)
    }

    private func finishLogin(token: String?) async throws {
        guard let token, let client else { throw APIError.server(status: 500, message: "No token returned") }
        await client.setToken(token)
        KeychainStore.saveToken(token)
        try await refreshIdentity()
        phase = .loggedIn
    }

    private func refreshIdentity() async throws {
        guard let client else { throw APIError.notConfigured }
        let stats = try await client.stats()
        userName = stats.userName ?? ""
        isAdmin = stats.isAdmin ?? false
    }

    func signOut() async {
        KeychainStore.deleteToken()
        await client?.setToken(nil)
        userName = ""
        isAdmin = false
        phase = .loggedOut
    }

    /// Called by views when a request fails with 401 mid-session.
    func handleAuthFailure() async {
        await signOut()
    }
}
