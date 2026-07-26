import XCTest
@testable import HideMyEmail

final class CredentialSecurityTests: XCTestCase {
    private final class URLStub: URLProtocol, @unchecked Sendable {
        static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            do {
                let (response, data) = try Self.handler!(request)
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            } catch { client?.urlProtocol(self, didFailWithError: error) }
        }
        override func stopLoading() {}
    }

    @MainActor
    private func state(
        token: @escaping (String) -> String?,
        delete: @escaping () -> Void,
        logoutPush: @escaping (APIClient?) async -> Void = { _ in }
    ) -> AppState {
        AppState(loadToken: token, saveToken: { _, _ in }, deleteToken: delete, makeClient: { url, token in
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [URLStub.self]
            return APIClient(baseURL: url, token: token, session: URLSession(configuration: config))
        }, logoutPush: logoutPush)
    }

    @MainActor
    func testStaleBootstrapFailureDoesNotSignOutNewOrigin() async {
        var credential = (token: "", origin: "")
        var requestStarted: CheckedContinuation<Void, Never>?
        var release: CheckedContinuation<Void, Never>?
        URLStub.handler = { _ in
            requestStarted?.resume(); requestStarted = nil
            let semaphore = DispatchSemaphore(value: 0)
            Task { await withCheckedContinuation { release = $0 }; semaphore.signal() }
            semaphore.wait()
            throw URLError(.cannotConnectToHost)
        }
        let app = state(token: { credential.origin == $0 ? credential.token : nil }, delete: { credential.token = "" })
        await app.setServerURL("https://one.example")
        credential = ("old", "https://one.example")
        let started = Task { await withCheckedContinuation { requestStarted = $0 } }
        let bootstrap = Task { await app.bootstrap() }
        await started.value
        await app.setServerURL("https://two.example")
        credential = ("new", "https://two.example")
        release?.resume()
        await bootstrap.value
        XCTAssertEqual(credential.token, "new")
        XCTAssertEqual(app.serverURLString, "https://two.example")
    }

    @MainActor
    func testStalePasswordLoginCannotAuthenticateSwitchedOrigin() async {
        var hosts: [String] = []
        var requestStarted: CheckedContinuation<Void, Never>?
        var release: CheckedContinuation<Void, Never>?
        URLStub.handler = { request in
            hosts.append(request.url!.host!)
            requestStarted?.resume(); requestStarted = nil
            let semaphore = DispatchSemaphore(value: 0)
            Task { await withCheckedContinuation { release = $0 }; semaphore.signal() }
            semaphore.wait()
            let body = Data(#"{"token":"old-token"}"#.utf8)
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, body)
        }
        let app = state(token: { _ in nil }, delete: {})
        await app.setServerURL("https://one.example")
        let started = Task { await withCheckedContinuation { requestStarted = $0 } }
        let login = Task { try await app.login(password: "secret") }
        await started.value
        await app.setServerURL("https://two.example")
        release?.resume()
        _ = try? await login.value
        XCTAssertEqual(hosts, ["one.example"])
        XCTAssertEqual(app.phase, .loggedOut)
    }

    @MainActor
    func testSignOutClearsSessionBeforeSuspendedPushCleanupAndDoesNotClearReplacement() async {
        var storedToken: String?
        var releaseCleanup: CheckedContinuation<Void, Never>?
        let cleanupStarted = expectation(description: "push cleanup suspended")
        let app = state(token: { _ in storedToken }, delete: { storedToken = nil }) { client in
            XCTAssertNotNil(client)
            await withCheckedContinuation {
                releaseCleanup = $0
                cleanupStarted.fulfill()
            }
        }
        await app.bootstrap()
        storedToken = "old"

        let logout = Task { await app.signOut() }
        await fulfillment(of: [cleanupStarted], timeout: 2)
        XCTAssertNil(storedToken)
        XCTAssertEqual(app.phase, .loggedOut)

        storedToken = "replacement"
        releaseCleanup?.resume()
        await logout.value
        XCTAssertEqual(storedToken, "replacement")
    }

    @MainActor
    func testStaleRequestAuthFailureDoesNotDeleteReplacementSession() async {
        var storedToken: String? = "old"
        URLStub.handler = { request in Self.response(request, Self.stats(userName: "user")) }
        let app = state(token: { _ in storedToken }, delete: { storedToken = nil })
        await app.bootstrap()
        let staleClient = try! XCTUnwrap(app.api())

        await app.signOut()
        storedToken = "replacement"
        await app.bootstrap()
        let replacementClient = try! XCTUnwrap(app.api())

        await app.handleAuthFailure(from: staleClient)

        XCTAssertEqual(storedToken, "replacement")
        XCTAssertTrue(app.api() === replacementClient)
    }

    @MainActor
    func testMFACompletionCannotAuthenticateReplacementClientAfterSignOut() async {
        var storedToken: String?
        var mfaStarted: CheckedContinuation<Void, Never>?
        var releaseMFA: CheckedContinuation<Void, Never>?
        URLStub.handler = { request in
            switch request.url!.path {
            case "/api/login":
                return Self.response(request, #"{"mfa_required":true,"mfa_token":"challenge"}"#)
            case "/api/mfa/complete":
                mfaStarted?.resume(); mfaStarted = nil
                let semaphore = DispatchSemaphore(value: 0)
                Task { await withCheckedContinuation { releaseMFA = $0 }; semaphore.signal() }
                semaphore.wait()
                return Self.response(request, #"{"token":"stale-token"}"#)
            default:
                return Self.response(request, #"{"user_name":"stale"}"#)
            }
        }
        let app = state(token: { _ in storedToken }, delete: { storedToken = nil })
        await app.bootstrap()
        try? await app.login(password: "secret")
        let started = Task { await withCheckedContinuation { mfaStarted = $0 } }
        let completion = Task { try await app.completeMFA(code: "123456") }
        await started.value

        await app.signOut()
        await app.bootstrap()
        releaseMFA?.resume()
        _ = try? await completion.value

        XCTAssertEqual(app.phase, .loggedOut)
        XCTAssertNil(storedToken)
    }

    @MainActor
    func testPendingRecoveryCannotAuthenticateReplacementAfterSameOriginSignOutAndRelogin() async throws {
        var storedToken: String?
        var savedTokens: [String] = []
        URLStub.handler = { request in
            switch request.url!.path {
            case "/api/recover/code":
                return Self.response(request, #"{"token":"recovery-token","passphrase":"new words"}"#)
            case "/api/login":
                return Self.response(request, #"{"token":"replacement-token"}"#)
            default:
                return Self.response(request, Self.stats(userName: "replacement"))
            }
        }
        let app = AppState(loadToken: { _ in storedToken }, saveToken: { token, _ in
            storedToken = token
            savedTokens.append(token)
        }, deleteToken: { storedToken = nil }, makeClient: { url, token in
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [URLStub.self]
            return APIClient(baseURL: url, token: token, session: URLSession(configuration: config))
        }, logoutPush: { _ in })
        await app.bootstrap()

        _ = try await app.recoverWithCode(username: "user", code: "code")
        await app.signOut()
        try await app.login(password: "secret")
        try await app.finishRecoveredLogin()

        XCTAssertEqual(app.phase, .loggedIn)
        XCTAssertEqual(storedToken, "replacement-token")
        XCTAssertEqual(savedTokens, ["replacement-token"])
    }

    @MainActor
    func testPasskeyLoginBuildsClientThroughInjectedFactory() async {
        var factoryCalls = 0
        let app = AppState(loadToken: { _ in nil }, saveToken: { _, _ in }, deleteToken: {}) { url, token in
            factoryCalls += 1
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [URLStub.self]
            return APIClient(baseURL: url, token: token, session: URLSession(configuration: config))
        }
        URLStub.handler = { request in
            throw URLError(.cannotConnectToHost)
        }

        _ = try? await app.loginWithPasskey()

        XCTAssertEqual(factoryCalls, 1)
    }

    func testServerOriginNormalizesCanonicalHTTPSOrigin() throws {
        XCTAssertEqual(try ServerOrigin(" HTTPS://Example.COM:443/ ").string, "https://example.com")
        XCTAssertEqual(try ServerOrigin("https://example.com:8443").string, "https://example.com:8443")
    }

    func testServerOriginRejectsInsecureRemoteAndNonOriginURLs() {
        XCTAssertThrowsError(try ServerOrigin("http://example.com"))
        XCTAssertThrowsError(try ServerOrigin("https://example.com/path"))
        XCTAssertNoThrow(try ServerOrigin("http://localhost:8787"))
        XCTAssertNoThrow(try ServerOrigin("http://127.0.0.1:8787"))
    }

    func testCallbackRequiresExactSchemeHostAndPath() {
        XCTAssertTrue(WebSessionAuthenticator.isValidCallback(URL(string: "hidemyemail://auth?code=ok")!))
        XCTAssertFalse(WebSessionAuthenticator.isValidCallback(URL(string: "hidemyemail://auth.evil?code=ok")!))
        XCTAssertFalse(WebSessionAuthenticator.isValidCallback(URL(string: "hidemyemail://auth/path?code=ok")!))
        XCTAssertFalse(WebSessionAuthenticator.isValidCallback(URL(string: "https://auth?code=ok")!))
    }

    private static func response(_ request: URLRequest, _ body: String) -> (HTTPURLResponse, Data) {
        (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!, Data(body.utf8))
    }

    private static func stats(userName: String) -> String {
        #"{"totals":{"aliases":0,"active":0},"last24h":{"forward":0,"reply":0,"block":0,"reject":0,"error":0},"topAliases":[],"userName":"\#(userName)"}"#
    }
}
