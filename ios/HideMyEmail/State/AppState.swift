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
    private(set) var serverURLString: String {
        didSet { UserDefaults.standard.set(serverURLString, forKey: Self.serverKey) }
    }

    private(set) var phase: AuthPhase = .loggedOut
    var userName: String = ""
    var isAdmin: Bool = false

    private var client: APIClient?
    private var binding: CredentialBinding
    private var webAuthenticator: WebSessionAuthenticator?
    private let loadToken: (String) -> String?
    private let saveToken: (String, String) -> Void
    private let deleteToken: () -> Void
    private let makeClient: (URL, String?) -> APIClient
    private let logoutPush: (APIClient?) async -> Void

    private static let serverKey = "server_url"
    static let defaultServer = "https://app.hidemyemail.dev"

    init(
        loadToken: @escaping (String) -> String? = { KeychainStore.loadToken(origin: $0) },
        saveToken: @escaping (String, String) -> Void = { KeychainStore.saveToken($0, origin: $1) },
        deleteToken: @escaping () -> Void = KeychainStore.deleteToken,
        makeClient: @escaping (URL, String?) -> APIClient = { APIClient(baseURL: $0, token: $1) },
        logoutPush: @escaping (APIClient?) async -> Void = { await PushManager.shared.onLogout(client: $0) }
    ) {
        let saved = UserDefaults.standard.string(forKey: Self.serverKey)
        let origin = (try? ServerOrigin(saved ?? Self.defaultServer).string) ?? Self.defaultServer
        self.serverURLString = origin
        self.binding = CredentialBinding(origin: origin)
        self.loadToken = loadToken
        self.saveToken = saveToken
        self.deleteToken = deleteToken
        self.makeClient = makeClient
        self.logoutPush = logoutPush
    }

    var hasServer: Bool { baseURL != nil }

    private var baseURL: URL? {
        try? ServerOrigin(serverURLString).url
    }

    func setServerURL(_ value: String) async {
        guard let origin = try? ServerOrigin(value) else { return }
        if origin.string != serverURLString {
            binding.switchOrigin(to: origin.string)
            webAuthenticator?.cancel()
            webAuthenticator = nil
            pendingRecovery = nil
            deleteToken()
            await client?.invalidate()
            client = nil
            userName = ""
            isAdmin = false
            phase = .loggedOut
        }
        serverURLString = origin.string
        await bootstrap()
    }

    /// Builds (or rebuilds) the API client for the current server, restoring a
    /// previously stored token if one exists.
    func bootstrap() async {
        guard let baseURL else { phase = .loggedOut; return }
        let snapshot = binding.snapshot()
        let token = loadToken(snapshot.origin)
        let operationClient = makeClient(baseURL, token)
        client = operationClient
        guard token != nil else { phase = .loggedOut; return }
        // Validate the restored token by fetching stats.
        do {
            let stats = try await operationClient.stats()
            try requireCurrent(snapshot, client: operationClient)
            userName = stats.userName ?? ""
            isAdmin = stats.isAdmin ?? false
            phase = .loggedIn
            // Restored sessions skip finishLogin(), so re-register for push here:
            // it refreshes the in-memory APNs token (kept only in memory) so a
            // later sign-out can detach this device from the account.
            await PushManager.shared.onLogin()
        } catch {
            if isCurrent(snapshot, client: operationClient) {
                await signOut(snapshot: snapshot, client: operationClient)
            }
        }
    }

    func api() -> APIClient? { client }

    // MARK: - Auth flow

    func login(password: String) async throws {
        guard let baseURL else { throw APIError.notConfigured }
        let snapshot = binding.snapshot()
        let client = client ?? makeClient(baseURL, nil)
        self.client = client

        let res = try await client.login(password: password)
        try requireCurrent(snapshot, client: client)
        if res.mfaRequired == true {
            phase = .awaitingMFA(token: res.mfaToken)
            return
        }
        try await finishLogin(token: res.token, freshAuth: res.freshAuth, snapshot: snapshot, client: client)
    }

    /// Web-session login: opens the server's own dashboard login (passkeys
    /// included — the ceremony associates with the server's domain via the
    /// web, so it works for ANY self-hosted host) and exchanges the returned
    /// handoff code for a bearer token.
    func loginViaWebSession() async throws {
        guard let baseURL else { throw APIError.notConfigured }
        let snapshot = binding.snapshot()
        let client = client ?? makeClient(baseURL, nil)
        self.client = client

        let authenticator = WebSessionAuthenticator()
        webAuthenticator = authenticator
        defer { webAuthenticator = nil }
        let handoff = try await authenticator.authenticate(server: baseURL)
        try requireCurrent(snapshot, client: client)
        let res = try await client.appAuthExchange(code: handoff.code, verifier: handoff.verifier)
        try await finishLogin(token: res.token, freshAuth: res.freshAuth, snapshot: snapshot, client: client)
    }

    /// Passwordless login with a platform passkey. Fetches a challenge, runs the
    /// AuthenticationServices assertion, and posts the signed result back. The
    /// relying party is the server host (matching the AASA / entitlement).
    func loginWithPasskey() async throws {
        guard let baseURL else { throw APIError.notConfigured }
        let snapshot = binding.snapshot()
        let client = client ?? makeClient(baseURL, nil)
        self.client = client

        let opts = try await client.passkeyChallenge()
        try requireCurrent(snapshot)
        guard let challengeData = Data(base64urlEncoded: opts.challenge) else {
            throw APIError.server(status: -1, message: "Malformed challenge")
        }
        let rp = opts.rpId ?? baseURL.host ?? "app.hidemyemail.dev"

        let assertion = try await PasskeyAuthenticator().assert(relyingParty: rp, challenge: challengeData)
        try requireCurrent(snapshot)

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
        try await finishLogin(token: res.token, freshAuth: res.freshAuth, snapshot: snapshot, client: client)
    }

    func completeMFA(code: String) async throws {
        let snapshot = binding.snapshot()
        guard let client else { throw APIError.notConfigured }
        let mfaToken: String?
        if case .awaitingMFA(let t) = phase { mfaToken = t } else { mfaToken = nil }
        let res = try await client.completeMFA(code: code, mfaToken: mfaToken)
        try await finishLogin(token: res.token, freshAuth: res.freshAuth, snapshot: snapshot, client: client)
    }

    private func finishLogin(token: String?, freshAuth: String?, snapshot: CredentialBinding.Snapshot, client: APIClient) async throws {
        try requireCurrent(snapshot, client: client)
        guard let token else { throw APIError.server(status: 500, message: "No token returned") }
        await client.setToken(token)
        await client.setFreshAuth(freshAuth)
        saveToken(token, snapshot.origin)
        try await refreshIdentity(client: client, snapshot: snapshot)
        try requireCurrent(snapshot, client: client)
        phase = .loggedIn
        // Re-register this device for push under the (possibly new) account.
        await PushManager.shared.onLogin()
    }

    private func refreshIdentity(
        client operationClient: APIClient? = nil,
        snapshot: CredentialBinding.Snapshot? = nil
    ) async throws {
        guard let operationClient = operationClient ?? client else { throw APIError.notConfigured }
        let stats = try await operationClient.stats()
        if let snapshot { try requireCurrent(snapshot, client: operationClient) }
        userName = stats.userName ?? ""
        isAdmin = stats.isAdmin ?? false
    }

    /// Refresh the displayed identity (e.g. after the user changes their
    /// username). Best-effort: failures leave the current name in place.
    func reloadIdentity() async {
        try? await refreshIdentity()
    }

    // MARK: - Self-service recovery (username + recovery code)

    /// Token + freshAuth from a successful recovery, held until the user has
    /// saved the new passphrase and taps continue.
    private var pendingRecovery: (
        token: String?,
        freshAuth: String?,
        snapshot: CredentialBinding.Snapshot,
        client: APIClient
    )?

    /// Recover with a username and one-time recovery code. Returns the freshly
    /// generated passphrase to show the user; call `finishRecoveredLogin()` once
    /// they've saved it to complete sign-in.
    func recoverWithCode(username: String, code: String) async throws -> String {
        let snapshot = binding.snapshot()
        guard let client else { throw APIError.notConfigured }
        let res = try await client.recoverWithCode(username: username, code: code)
        try requireCurrent(snapshot, client: client)
        pendingRecovery = (res.token, res.freshAuth, snapshot, client)
        return res.passphrase
    }

    func finishRecoveredLogin() async throws {
        guard let pending = pendingRecovery else { return }
        pendingRecovery = nil
        try await finishLogin(token: pending.token, freshAuth: pending.freshAuth,
            snapshot: pending.snapshot, client: pending.client)
    }

    func signOut() async {
        let operationClient = client
        // Clear local auth before any suspension. Push cleanup uses the captured
        // old client and cannot later erase a replacement session.
        binding.invalidate()
        deleteToken()
        client = nil
        pendingRecovery = nil
        webAuthenticator?.cancel()
        webAuthenticator = nil
        userName = ""
        isAdmin = false
        phase = .loggedOut
        await logoutPush(operationClient)
        await operationClient?.setToken(nil)
        await operationClient?.setFreshAuth(nil)
    }

    private func signOut(snapshot: CredentialBinding.Snapshot, client operationClient: APIClient) async {
        guard isCurrent(snapshot, client: operationClient) else { return }
        deleteToken()
        client = nil
        userName = ""
        isAdmin = false
        phase = .loggedOut
        await logoutPush(operationClient)
        await operationClient.setToken(nil)
        await operationClient.setFreshAuth(nil)
    }

    private func requireCurrent(_ snapshot: CredentialBinding.Snapshot, client expectedClient: APIClient? = nil) throws {
        guard isCurrent(snapshot, client: expectedClient) else { throw APIError.unauthorized }
    }

    private func isCurrent(_ snapshot: CredentialBinding.Snapshot, client expectedClient: APIClient? = nil) -> Bool {
        binding.accepts(snapshot) && (expectedClient == nil || client === expectedClient)
    }

    /// Called by views when a request fails with 401 mid-session. A response
    /// from a replaced client must not sign out the replacement session.
    func handleAuthFailure(from expectedClient: APIClient) async {
        guard client === expectedClient else { return }
        await signOut()
    }
}
