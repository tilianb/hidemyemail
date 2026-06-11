import Foundation

/// Talks to the HideMyEmail Cloudflare Worker using the bearer-token auth mode
/// added in `worker/src/api/...`. The web app uses HttpOnly cookies; native
/// clients opt into tokens by sending `X-Auth-Mode: token` on login and
/// `Authorization: Bearer <token>` on every guarded request.
actor APIClient {
    private let baseURL: URL
    private var token: String?
    private let session: URLSession

    init(baseURL: URL, token: String?) {
        self.baseURL = baseURL
        self.token = token
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        // We manage auth ourselves and never want the system cookie store to
        // leak a stale session between accounts.
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        self.session = URLSession(configuration: config)
    }

    func setToken(_ token: String?) {
        self.token = token
    }

    // MARK: - Auth

    /// Returns the raw login response so the caller can branch on MFA.
    func login(password: String) async throws -> LoginResponse {
        try await request(
            "/api/login",
            method: "POST",
            body: ["password": password],
            authMode: true,
            authed: false
        )
    }

    func completeMFA(code: String, mfaToken: String?) async throws -> LoginResponse {
        var body: [String: Any] = ["code": code]
        if let mfaToken { body["mfa_token"] = mfaToken }
        return try await request(
            "/api/mfa/complete",
            method: "POST",
            body: body,
            authMode: true,
            authed: false
        )
    }

    // MARK: - Resources

    func stats() async throws -> Stats {
        try await request("/api/stats")
    }

    func aliases(query: String = "") async throws -> [Alias] {
        let path = query.isEmpty
            ? "/api/aliases"
            : "/api/aliases?q=\(query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")"
        return try await request(path)
    }

    func createAlias(domainId: Int, localPart: String, destination: String?, label: String?) async throws -> Alias {
        var body: [String: Any] = ["domain_id": domainId, "local_part": localPart]
        if let destination, !destination.isEmpty { body["destination"] = destination }
        if let label, !label.isEmpty { body["label"] = label }
        return try await request("/api/aliases", method: "POST", body: body)
    }

    func setAliasActive(id: Int, active: Bool) async throws {
        try await requestVoid("/api/aliases/\(id)", method: "PATCH", body: ["active": active ? 1 : 0])
    }

    func updateAliasLabel(id: Int, label: String?) async throws {
        // Send JSON null (NSNull) to clear the label; a bare Swift nil is not a
        // valid JSONSerialization value and would throw.
        try await requestVoid("/api/aliases/\(id)", method: "PATCH", body: ["label": label ?? NSNull()])
    }

    func deleteAlias(id: Int) async throws {
        try await requestVoid("/api/aliases/\(id)", method: "DELETE")
    }

    func destinations() async throws -> [Destination] {
        try await request("/api/destinations")
    }

    func createDestination(email: String) async throws {
        try await requestVoid("/api/destinations", method: "POST", body: ["email": email])
    }

    func deleteDestination(id: Int) async throws {
        try await requestVoid("/api/destinations/\(id)", method: "DELETE")
    }

    func setDefaultDestination(id: Int) async throws {
        try await requestVoid("/api/destinations/\(id)/default", method: "PATCH")
    }

    func domains() async throws -> [Domain] {
        try await request("/api/domains")
    }

    func config() async throws -> ServerConfig {
        try await request("/api/config", authed: false)
    }

    // MARK: - Core request plumbing

    private func request<T: Decodable>(
        _ path: String,
        method: String = "GET",
        body: [String: Any]? = nil,
        authMode: Bool = false,
        authed: Bool = true
    ) async throws -> T {
        let data = try await perform(path, method: method, body: body, authMode: authMode, authed: authed)
        do {
            return try Self.decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    private func requestVoid(
        _ path: String,
        method: String,
        body: [String: Any]? = nil
    ) async throws {
        _ = try await perform(path, method: method, body: body, authMode: false, authed: true)
    }

    private func perform(
        _ path: String,
        method: String,
        body: [String: Any]?,
        authMode: Bool,
        authed: Bool
    ) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw APIError.notConfigured
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if authMode { req.setValue("token", forHTTPHeaderField: "X-Auth-Mode") }
        if authed {
            guard let token else { throw APIError.unauthorized }
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError.transport(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.server(status: -1, message: "Invalid response")
        }
        // A 401 on an authenticated request means the session token is gone or
        // expired → drop it and bounce to login. On the unauthenticated auth
        // endpoints (login / mfa-complete) a 401 instead carries a meaningful
        // message like "Invalid passphrase" / "Invalid code", so fall through
        // and surface that rather than masking it as a stale session.
        if http.statusCode == 401 && authed { throw APIError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? Self.decoder.decode(APIErrorBody.self, from: data))?.error
                ?? "Request failed (\(http.statusCode))"
            throw APIError.server(status: http.statusCode, message: message)
        }
        return data
    }

    private static let decoder = JSONDecoder()
}
