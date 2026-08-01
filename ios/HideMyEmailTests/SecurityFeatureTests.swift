import XCTest
@testable import HideMyEmail

final class SecurityFeatureTests: XCTestCase {
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

    private func client(baseURL: String = "https://app.hidemyemail.dev") -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [URLStub.self]
        return APIClient(baseURL: URL(string: baseURL)!, token: "bearer", session: URLSession(configuration: config))
    }

    func testSecurityModelsDecodeWorkerContract() throws {
        let decoder = JSONDecoder()
        let setup = try decoder.decode(MFASetupResponse.self, from: Data(#"{"secret":"ABC","uri":"otpauth://totp/test"}"#.utf8))
        XCTAssertEqual(setup.secret, "ABC")
        let verified = try decoder.decode(MFAVerifyResponse.self, from: Data(#"{"ok":true,"backupCodes":["one","two"]}"#.utf8))
        XCTAssertEqual(verified.backupCodes, ["one", "two"])
        let challenge = try decoder.decode(PasskeyRegistrationOptions.self, from: Data(#"{"challenge":"AQI","rp":{"id":"app.hidemyemail.dev","name":"HideMyEmail"},"user":{"id":"AwQ","name":"tilian","displayName":"Tilian"},"pubKeyCredParams":[{"type":"public-key","alg":-7}],"challengeToken":"signed"}"#.utf8))
        XCTAssertEqual(challenge.rp.id, "app.hidemyemail.dev")
        XCTAssertEqual(challenge.user.id, "AwQ")
        XCTAssertEqual(challenge.challengeToken, "signed")
    }

    func testReauthStoresFreshTokenWithoutReplacingBearer() async throws {
        var requests: [URLRequest] = []
        URLStub.handler = { request in
            requests.append(request)
            let body = request.url!.path == "/api/settings/reauth"
                ? #"{"fresh_auth":"fresh"}"# : #"{"enabled":false,"backupCodesRemaining":0}"#
            return Self.response(request, body)
        }
        let api = client()
        try await api.reauthenticate(passphrase: "secret", code: "123456")
        _ = try await api.mfaStatus()

        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer bearer")
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "X-Auth-Mode"), "token")
        XCTAssertNil(requests[0].value(forHTTPHeaderField: "X-Fresh-Auth"))
        XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Authorization"), "Bearer bearer")
        XCTAssertEqual(requests[1].value(forHTTPHeaderField: "X-Fresh-Auth"), "fresh")
        let json = try body(requests[0])
        XCTAssertEqual(json["passphrase"] as? String, "secret")
        XCTAssertEqual(json["code"] as? String, "123456")
    }

    func testReauthSurfacesInvalidCredentialsWithoutExpiringBearer() async throws {
        URLStub.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!, Data(#"{"error":"Invalid credentials"}"#.utf8))
        }
        do {
            try await client().reauthenticate(passphrase: "wrong", code: nil)
            XCTFail("Expected invalid credentials")
        } catch APIError.server(let status, let message) {
            XCTAssertEqual(status, 401)
            XCTAssertEqual(message, "Invalid credentials")
        } catch {
            XCTFail("Reauthentication must not invalidate the bearer session: \(error)")
        }
    }

    func testReauthUnauthorizedRemainsSessionFailure() async throws {
        URLStub.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!, Data(#"{"error":"Unauthorized"}"#.utf8))
        }
        do {
            try await client().reauthenticate(passphrase: "secret", code: nil)
            XCTFail("Expected unauthorized")
        } catch APIError.unauthorized {
        } catch {
            XCTFail("Expected unauthorized, got \(error)")
        }
    }

    func testMFALifecycleAndPasskeyRequestsCarryFreshHeaderAndPayloads() async throws {
        var requests: [URLRequest] = []
        URLStub.handler = { request in
            requests.append(request)
            let body: String
            switch request.url!.path {
            case "/api/settings/reauth": body = #"{"fresh_auth":"fresh"}"#
            case "/api/settings/mfa/setup": body = #"{"secret":"ABC","uri":"otpauth://x"}"#
            case "/api/settings/mfa/verify": body = #"{"ok":true,"backupCodes":["b1"]}"#
            case "/api/settings/mfa/backup-codes": body = #"{"backupCodes":["b2"]}"#
            case "/api/settings/passkeys/challenge": body = #"{"challenge":"AQI","rp":{"id":"app.hidemyemail.dev","name":"HME"},"user":{"id":"AwQ","name":"u","displayName":"U"},"pubKeyCredParams":[],"challengeToken":"ct"}"#
            case "/api/settings/security-handoff": body = #"{"url":"https://app.hidemyemail.dev/security-handoff?code=handoff"}"#
            default: body = #"{"ok":true}"#
            }
            return Self.response(request, body)
        }
        let api = client()
        try await api.reauthenticate(passphrase: "secret", code: nil)
        _ = try await api.setupMFA()
        _ = try await api.verifyMFA(code: "123456")
        _ = try await api.regenerateMFABackupCodes(code: "654321")
        try await api.disableMFA(code: "backup")
        _ = try await api.passkeyRegistrationChallenge()
        try await api.registerPasskey(response: ["id": "credential"], deviceName: "My iPhone", challengeToken: "ct")
        _ = try await api.securityHandoffURL()

        XCTAssertNil(requests[0].value(forHTTPHeaderField: "X-Fresh-Auth"))
        for index in [0, 5, 6, 7] {
            XCTAssertEqual(requests[index].value(forHTTPHeaderField: "X-Auth-Mode"), "token",
                           "request \(index) must use native token mode")
        }
        XCTAssertTrue(requests.dropFirst().allSatisfy { $0.value(forHTTPHeaderField: "X-Fresh-Auth") == "fresh" })
        XCTAssertEqual(try body(requests[2])["code"] as? String, "123456")
        XCTAssertEqual(try body(requests[4])["code"] as? String, "backup")
        let register = try body(requests[6])
        XCTAssertEqual(register["deviceName"] as? String, "My iPhone")
        XCTAssertEqual(register["challengeToken"] as? String, "ct")
        XCTAssertEqual((register["response"] as? [String: String])?["id"], "credential")
    }

    func testNativeRegistrationSelectionRequiresExactOfficialCanonicalHost() throws {
        XCTAssertTrue(SecurityRegistrationMode.forServer(try ServerOrigin("https://app.hidemyemail.dev")) == .native)
        XCTAssertTrue(SecurityRegistrationMode.forServer(try ServerOrigin("https://APP.HIDEMYEMAIL.DEV:443")) == .native)
        XCTAssertTrue(SecurityRegistrationMode.forServer(try ServerOrigin("https://self.example")) == .handoff)
        XCTAssertTrue(SecurityRegistrationMode.forServer(try ServerOrigin("https://app.hidemyemail.dev:8443")) == .handoff)
    }

    func testNativePasskeyRegistrationRequiresOfficialOriginAndExactRPID() throws {
        let official = try ServerOrigin("https://app.hidemyemail.dev")
        let selfHosted = try ServerOrigin("https://self.example")
        XCTAssertNoThrow(try NativePasskeyRegistration.validate(origin: official, rpID: "app.hidemyemail.dev"))

        for rpID in ["APP.HIDEMYEMAIL.DEV", "App.hidemyemail.dev", "app.hidemyemail.dev.evil.example"] {
            XCTAssertThrowsError(try NativePasskeyRegistration.validate(origin: official, rpID: rpID), rpID)
        }
        XCTAssertThrowsError(try NativePasskeyRegistration.validate(
            origin: selfHosted, rpID: "app.hidemyemail.dev"
        ))
    }

    func testPasskeyAssertionResponseIncludesChallengeTokenAndWebAuthnPayload() throws {
        let result = PasskeyAssertionResponse.make(
            credentialID: Data([0xfb, 0xff]), clientDataJSON: Data([1]),
            authenticatorData: Data([2]), signature: Data([3]), userID: Data([4]),
            passkeyToken: "signed"
        )
        XCTAssertEqual(result["id"] as? String, "-_8")
        XCTAssertEqual(result["passkey_token"] as? String, "signed")
        let response = try XCTUnwrap(result["response"] as? [String: Any])
        XCTAssertEqual(response["clientDataJSON"] as? String, "AQ")
        XCTAssertEqual(response["authenticatorData"] as? String, "Ag")
        XCTAssertEqual(response["signature"] as? String, "Aw")
        XCTAssertEqual(response["userHandle"] as? String, "BA")
    }

    func testMFAPasskeyActionsUseBoundSettingsEndpointsWithoutReplacingCredentials() async throws {
        var requests: [URLRequest] = []
        URLStub.handler = { request in
            requests.append(request)
            let response = request.url!.path.hasSuffix("challenge")
                ? #"{"challenge":"AQI","rpId":"app.hidemyemail.dev","passkey_token":"signed"}"#
                : #"{"ok":true,"backupCodes":["new-code"]}"#
            return Self.response(request, response)
        }
        let api = client()
        await api.setFreshAuth("existing-fresh")
        _ = try await api.mfaPasskeyChallenge(action: .backupCodes)
        let result = try await api.completeMFAPasskeyAction(
            .backupCodes, response: ["id": "credential"], passkeyToken: "signed"
        )
        _ = try await api.mfaStatus()

        XCTAssertEqual(requests[0].url?.path, "/api/settings/mfa/passkey/challenge")
        XCTAssertEqual(requests[1].url?.path, "/api/settings/mfa/passkey/complete")
        XCTAssertEqual(try body(requests[0])["action"] as? String, "backup-codes")
        let complete = try body(requests[1])
        XCTAssertEqual(complete["action"] as? String, "backup-codes")
        XCTAssertEqual(complete["passkey_token"] as? String, "signed")
        XCTAssertEqual((complete["response"] as? [String: String])?["id"], "credential")
        XCTAssertEqual(result.backupCodes, ["new-code"])
        XCTAssertTrue(requests.allSatisfy {
            $0.value(forHTTPHeaderField: "Authorization") == "Bearer bearer" &&
            $0.value(forHTTPHeaderField: "X-Fresh-Auth") == "existing-fresh"
        })
    }

    func testInvalidMFACodePreservesWorkerErrorAndBearer() async throws {
        for endpoint in ["/api/settings/mfa/disable", "/api/settings/mfa/backup-codes"] {
            var requests: [URLRequest] = []
            URLStub.handler = { request in
                requests.append(request)
                if request.url!.path == endpoint {
                    return (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil,
                        headerFields: ["Content-Type": "application/json"])!,
                        Data(#"{"error":"Invalid MFA code"}"#.utf8))
                }
                return Self.response(request, #"{"enabled":true,"backupCodesRemaining":4}"#)
            }
            let api = client()
            do {
                if endpoint.hasSuffix("disable") {
                    try await api.disableMFA(code: "invalid")
                } else {
                    _ = try await api.regenerateMFABackupCodes(code: "invalid")
                }
                XCTFail("Expected invalid MFA code")
            } catch APIError.server(let status, let message) {
                XCTAssertEqual(status, 401)
                XCTAssertEqual(message, "Invalid MFA code")
            } catch {
                XCTFail("Expected semantic Worker error, got \(error)")
            }

            _ = try await api.mfaStatus()
            XCTAssertEqual(requests.count, 2)
            XCTAssertTrue(requests.allSatisfy {
                $0.value(forHTTPHeaderField: "Authorization") == "Bearer bearer"
            })
        }
    }

    func testMFAEndpointUnauthorizedResponseStillExpiresSession() async throws {
        URLStub.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!,
                Data(#"{"error":"Unauthorized"}"#.utf8))
        }
        do {
            try await client().disableMFA(code: "123456")
            XCTFail("Expected unauthorized session")
        } catch APIError.unauthorized {
            // Expected: this is a session failure, not an invalid MFA code.
        } catch {
            XCTFail("Expected unauthorized, got \(error)")
        }
    }

    func testExpiredPasskeyChallengePreservesBearerSession() async throws {
        var requests: [URLRequest] = []
        URLStub.handler = { request in
            requests.append(request)
            if request.url!.path == "/api/settings/passkeys/register" {
                return (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"])!,
                    Data(#"{"error":"Invalid or expired passkey challenge"}"#.utf8))
            }
            return Self.response(request, #"{"enabled":false,"backupCodesRemaining":0}"#)
        }
        let api = client()
        do {
            try await api.registerPasskey(
                response: ["id": "credential"], deviceName: "My iPhone", challengeToken: "expired")
            XCTFail("Expected expired challenge")
        } catch APIError.server(let status, let message) {
            XCTAssertEqual(status, 401)
            XCTAssertEqual(message, "Invalid or expired passkey challenge")
        } catch {
            XCTFail("Expected semantic Worker error, got \(error)")
        }

        _ = try await api.mfaStatus()
        XCTAssertEqual(requests.count, 2)
        XCTAssertTrue(requests.allSatisfy {
            $0.value(forHTTPHeaderField: "Authorization") == "Bearer bearer"
        })
    }

    func testPasskeyChallengeSemanticUnauthorizedPreservesBearerSession() async throws {
        URLStub.handler = { request in
            if request.url!.path == "/api/settings/passkeys/challenge" {
                return (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"])!,
                    Data(#"{"error":"Passkeys are not configured"}"#.utf8))
            }
            return Self.response(request, #"{"enabled":false,"backupCodesRemaining":0}"#)
        }
        let api = client()

        do {
            _ = try await api.passkeyRegistrationChallenge()
            XCTFail("Expected passkey configuration error")
        } catch APIError.server(let status, let message) {
            XCTAssertEqual(status, 401)
            XCTAssertEqual(message, "Passkeys are not configured")
        } catch {
            XCTFail("Expected semantic Worker error, got \(error)")
        }

        _ = try await api.mfaStatus()
    }

    func testHandoffRejectsCrossOriginURL() async throws {
        URLStub.handler = { request in Self.response(request, #"{"url":"https://evil.example/security-handoff?code=x"}"#) }
        do {
            _ = try await client(baseURL: "https://self.example").securityHandoffURL()
            XCTFail("Expected cross-origin URL rejection")
        } catch APIError.server(_, let message) {
            XCTAssertEqual(message, "Invalid security handoff URL")
        }
    }

    func testHandoffAcceptsCanonicalIPv6LoopbackOrigin() async throws {
        URLStub.handler = { request in
            Self.response(request, #"{"url":"http://[::1]:8787/security-handoff?code=x"}"#)
        }

        let url = try await client(baseURL: "http://[::1]:8787").securityHandoffURL()

        XCTAssertEqual(url.host, "::1")
        XCTAssertEqual(ServerOrigin.canonicalOrigin(of: url), "http://[::1]:8787")
    }

    func testHandoffRejectsUncanonicalizableCrossOriginIPv6URL() async throws {
        URLStub.handler = { request in
            Self.response(request, #"{"url":"http://[::2]:8788/security-handoff?code=x"}"#)
        }

        do {
            _ = try await client(baseURL: "http://[::1]:8787").securityHandoffURL()
            XCTFail("Expected cross-origin URL rejection")
        } catch APIError.server(_, let message) {
            XCTAssertEqual(message, "Invalid security handoff URL")
        }
    }

    func testHandoffRejectsInvalidSameOriginURLs() async throws {
        let invalidURLs = [
            "https://self.example/security?code=x",
            "https://self.example/%73ecurity-handoff?code=x",
            "https://self.example/security%2Dhandoff?code=x",
            "https://self.example/security-handoff?code=x#fragment",
            "https://self.example/security-handoff",
            "https://self.example/security-handoff?code=",
            "https://self.example/security-handoff?code=one&code=two",
            "https://self.example/security-handoff?code=one&extra=two",
            "https://user:password@self.example/security-handoff?code=x",
        ]
        for invalidURL in invalidURLs {
            URLStub.handler = { request in
                Self.response(request, #"{"url":"\#(invalidURL)"}"#)
            }
            do {
                _ = try await client(baseURL: "https://self.example").securityHandoffURL()
                XCTFail("Expected rejection for \(invalidURL)")
            } catch APIError.server(_, let message) {
                XCTAssertEqual(message, "Invalid security handoff URL")
            }
        }
    }

    func testHandoffAcceptsCanonicalLoopbackOrigin() async throws {
        URLStub.handler = { request in
            Self.response(request, #"{"url":"http://localhost:8787/security-handoff?code=x"}"#)
        }
        let url = try await client(baseURL: "http://LOCALHOST:8787").securityHandoffURL()
        XCTAssertEqual(url.path, "/security-handoff")
    }

    func testSecurityFlowCapturesMFAOperationAndWaitsForActionSheetDismissal() {
        var flow = SecurityFlowState()
        flow.capture(.disableMFA(code: "backup"), actionSheetPresented: true)
        flow.requireReauthentication()

        XCTAssertEqual(flow.pendingOperation, .disableMFA(code: "backup"))
        XCTAssertFalse(flow.showReauthentication)
        flow.actionSheetDidDismiss()
        XCTAssertTrue(flow.showReauthentication)
    }

    func testSecurityFlowRetriesCapturedOperationOnlyOnce() {
        var flow = SecurityFlowState()
        flow.capture(.regenerateMFA(code: "123456"), actionSheetPresented: false)
        flow.requireReauthentication()

        XCTAssertEqual(flow.consumePendingOperation(), .regenerateMFA(code: "123456"))
        XCTAssertNil(flow.consumePendingOperation())
    }

    func testMFAActionsRequireANewCodeAfterReauthentication() {
        XCTAssertTrue(SecurityOperation.disableMFA(code: "backup").requiresNewMfaCodeAfterReauthentication)
        XCTAssertTrue(SecurityOperation.regenerateMFA(code: "123456").requiresNewMfaCodeAfterReauthentication)
        XCTAssertFalse(SecurityOperation.setupMFA.requiresNewMfaCodeAfterReauthentication)
    }

    func testSecurityFlowCancellationClearsPendingAndSensitiveState() {
        var flow = SecurityFlowState()
        flow.capture(.disableMFA(code: "secret"), actionSheetPresented: false)
        flow.passphrase = "passphrase"
        flow.reauthenticationCode = "654321"
        flow.cancel()

        XCTAssertNil(flow.pendingOperation)
        XCTAssertEqual(flow.passphrase, "")
        XCTAssertEqual(flow.reauthenticationCode, "")
        XCTAssertFalse(flow.showReauthentication)
    }

    func testSecurityOperationGuardRejectsOverlapUntilEnd() {
        var guardState = SecurityOperationGuard()
        XCTAssertTrue(guardState.begin())
        XCTAssertFalse(guardState.begin())
        guardState.end()
        XCTAssertTrue(guardState.begin())
    }

    func testSecurityOperationGuardAllowsDismissalOnlyWhileIdle() {
        var guardState = SecurityOperationGuard()
        XCTAssertTrue(guardState.allowsDismissal)
        XCTAssertTrue(guardState.begin())
        XCTAssertFalse(guardState.allowsDismissal)
        guardState.end()
        XCTAssertTrue(guardState.allowsDismissal)
    }

    func testPasskeyCeremonyLifecycleRejectsOverlapAndClearsOnCompletion() {
        var lifecycle = PasskeyCeremonyLifecycle()
        XCTAssertTrue(lifecycle.begin(.assertion))
        XCTAssertFalse(lifecycle.begin(.registration))
        XCTAssertEqual(lifecycle.active, .assertion)
        lifecycle.complete()
        XCTAssertNil(lifecycle.active)
        XCTAssertTrue(lifecycle.begin(.registration))
    }

    func testUnauthorizedDecisionOnlyMatchesSessionFailure() {
        XCTAssertTrue(SecurityRequestError.shouldHandleAuthFailure(APIError.unauthorized))
        XCTAssertFalse(SecurityRequestError.shouldHandleAuthFailure(
            APIError.server(status: 401, message: "Fresh authentication required")
        ))
    }

    func testRegistrationResponseMappingUsesBase64URLAndOptionalFields() {
        let response = PasskeyRegistrationResponse.make(
            credentialID: Data([0xfb, 0xff]), clientDataJSON: Data([1, 2]),
            attestationObject: Data([3, 4]), attachment: "platform"
        )
        XCTAssertEqual(response["id"] as? String, "-_8")
        XCTAssertEqual(response["rawId"] as? String, "-_8")
        XCTAssertEqual(response["type"] as? String, "public-key")
        let payload = response["response"] as? [String: Any]
        XCTAssertEqual(payload?["clientDataJSON"] as? String, "AQI")
        XCTAssertEqual(payload?["attestationObject"] as? String, "AwQ")
        XCTAssertEqual(response["authenticatorAttachment"] as? String, "platform")
        XCTAssertNil(payload?["transports"])
    }

    private func body(_ request: URLRequest) throws -> [String: Any] {
        let data: Data
        if let direct = request.httpBody {
            data = direct
        } else if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var result = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                result.append(buffer, count: count)
            }
            data = result
        } else {
            throw XCTSkip("URLSession did not expose the request body")
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private static func response(_ request: URLRequest, _ body: String) -> (HTTPURLResponse, Data) {
        (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!, Data(body.utf8))
    }
}
