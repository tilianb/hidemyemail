import AuthenticationServices
import UIKit

struct PasskeyCeremonyLifecycle {
    enum Kind: Equatable { case assertion, registration }
    private(set) var active: Kind?

    /// Begins a passkey ceremony of the specified kind if no ceremony is active.
    /// - Parameter kind: The kind of ceremony to begin.
    /// - Returns: `true` if the ceremony began, `false` if another ceremony is already active.
    mutating func begin(_ kind: Kind) -> Bool {
        guard active == nil else { return false }
        active = kind
        return true
    }

    /// Completes the active passkey ceremony and clears its state.
mutating func complete() { active = nil }
}

/// Drives a single platform passkey (WebAuthn) assertion through
/// AuthenticationServices and bridges the delegate callbacks into async/await.
/// The relying-party identifier must match the domain in the app's
/// `associated-domains` entitlement and the Worker's AASA file.
@MainActor
final class PasskeyAuthenticator: NSObject {
    private var continuation: CheckedContinuation<ASAuthorizationPlatformPublicKeyCredentialAssertion, Error>?
    private var registrationContinuation: CheckedContinuation<ASAuthorizationPlatformPublicKeyCredentialRegistration, Error>?
    private var controller: ASAuthorizationController?
    private var lifecycle = PasskeyCeremonyLifecycle()

    /// Performs a passkey assertion for the specified relying party.
    /// - Parameters:
    ///   - relyingParty: The relying party identifier.
    ///   - challenge: The challenge data used for the assertion.
    /// - Returns: The resulting platform public key credential assertion.
    func assert(relyingParty: String, challenge: Data) async throws -> ASAuthorizationPlatformPublicKeyCredentialAssertion {
        guard lifecycle.begin(.assertion) else { throw APIError.server(status: -1, message: "Passkey ceremony already in progress") }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: relyingParty)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        let controller = ASAuthorizationController(authorizationRequests: [request])
        self.controller = controller
        controller.delegate = self
        controller.presentationContextProvider = self
        return try await withCheckedThrowingContinuation { cont in
            self.continuation = cont
            controller.performRequests()
        }
    }

    /// Registers a platform passkey for the specified relying party.
    /// - Parameters:
    ///   - relyingParty: The relying party identifier.
    ///   - challenge: The server-provided registration challenge.
    ///   - userID: The user identifier associated with the credential.
    ///   - userName: The user-visible name associated with the credential.
    /// - Returns: The resulting platform public key credential registration.
    /// - Throws: An error if another passkey ceremony is already in progress or registration fails.
    func register(relyingParty: String, challenge: Data, userID: Data,
                  userName: String) async throws -> ASAuthorizationPlatformPublicKeyCredentialRegistration {
        guard lifecycle.begin(.registration) else { throw APIError.server(status: -1, message: "Passkey ceremony already in progress") }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: relyingParty)
        let request = provider.createCredentialRegistrationRequest(
            challenge: challenge, name: userName, userID: userID
        )
        let controller = ASAuthorizationController(authorizationRequests: [request])
        self.controller = controller
        controller.delegate = self
        controller.presentationContextProvider = self
        return try await withCheckedThrowingContinuation { cont in
            registrationContinuation = cont
            controller.performRequests()
        }
    }
}

extension PasskeyAuthenticator: ASAuthorizationControllerDelegate {
    /// Handles the result of a completed authorization ceremony.
    ///
    /// Resumes the continuation associated with the active assertion or registration. Unexpected credential types complete both pending operations with an error.
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        if lifecycle.active == .registration,
           let registration = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
            registrationContinuation?.resume(returning: registration)
            registrationContinuation = nil
            self.controller = nil
            lifecycle.complete()
            return
        }
        if lifecycle.active == .assertion,
           let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            continuation?.resume(returning: assertion)
        } else {
            let error = APIError.server(status: -1, message: "Unexpected credential type")
            continuation?.resume(throwing: error)
            registrationContinuation?.resume(throwing: error)
        }
        continuation = nil
        registrationContinuation = nil
        self.controller = nil
        lifecycle.complete()
    }

    /// Handles authorization failure by completing any active passkey ceremony with the provided error.
    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        continuation?.resume(throwing: error)
        registrationContinuation?.resume(throwing: error)
        continuation = nil
        registrationContinuation = nil
        self.controller = nil
        lifecycle.complete()
    }
}

enum SecurityRegistrationMode: Equatable {
    case native, handoff

    /// Determines the registration mode for a server origin.
    /// - Parameter origin: The server origin to evaluate.
    /// - Returns: `.native` for the default server origin; `.handoff` for other origins.
    static func forServer(_ origin: ServerOrigin) -> Self {
        origin.string == AppState.defaultServer ? .native : .handoff
    }
}

enum NativePasskeyRegistration {
    /// Validates the origin and relying party identifier for native passkey registration.
    /// - Parameters:
    ///   - origin: The server origin to validate.
    ///   - rpID: The relying party identifier to validate.
    /// - Throws: An error if the origin or relying party identifier is invalid.
    static func validate(origin: ServerOrigin, rpID: String) throws {
        guard origin.string == "https://app.hidemyemail.dev",
              rpID == "app.hidemyemail.dev" else {
            throw APIError.server(status: -1, message: "Invalid passkey relying party")
        }
    }
}

enum PasskeyRegistrationResponse {
    /// Creates a WebAuthn public-key credential registration response.
    /// - Parameters:
    ///   - credentialID: The credential identifier.
    ///   - clientDataJSON: The serialized client data.
    ///   - attestationObject: The serialized attestation object.
    ///   - attachment: An optional authenticator attachment value.
    /// - Returns: A dictionary containing the base64url-encoded credential registration response.
    static func make(credentialID: Data, clientDataJSON: Data, attestationObject: Data,
                     attachment: String? = nil) -> [String: Any] {
        let credentialResponse: [String: Any] = [
            "clientDataJSON": clientDataJSON.base64urlEncodedString(),
            "attestationObject": attestationObject.base64urlEncodedString(),
        ]
        var result: [String: Any] = [
            "id": credentialID.base64urlEncodedString(),
            "rawId": credentialID.base64urlEncodedString(),
            "type": "public-key",
            "response": credentialResponse,
            "clientExtensionResults": [String: Any](),
        ]
        if let attachment { result["authenticatorAttachment"] = attachment }
        return result
    }
}

extension PasskeyAuthenticator: ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        let scene = UIApplication.shared.connectedScenes
            .first { $0.activationState == .foregroundActive } as? UIWindowScene
        return scene?.keyWindow ?? ASPresentationAnchor()
    }
}

extension Data {
    /// Decode base64url (no padding) as used across the WebAuthn JSON contract.
    init?(base64urlEncoded s: String) {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        self.init(base64Encoded: b)
    }

    func base64urlEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
