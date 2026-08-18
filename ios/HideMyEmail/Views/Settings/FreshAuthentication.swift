import SwiftUI
import Observation

@MainActor
@Observable
final class FreshAuthenticationCoordinator {
    private struct Pending {
        let client: APIClient
        let origin: String
        let operation: () async throws -> Void
        let onError: (String) -> Void
    }

    private var pending: Pending?
    private(set) var isPresented = false
    private(set) var isBusy = false
    var isPending: Bool { pending != nil }
    var passphrase = ""
    var code = ""
    var error: String?
    var registeredPasskeysAvailable = false

    func perform(
        app: AppState,
        onError: @escaping (String) -> Void,
        deferPresentation: Bool = false,
        operation: @escaping () async throws -> Void
    ) async {
        guard pending == nil, !isBusy else {
            onError("Another security action is awaiting confirmation.")
            return
        }
        guard let client = app.api() else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            try await operation()
        } catch APIError.freshAuthRequired {
            guard app.api() === client else { cancel(); return }
            pending = Pending(client: client, origin: app.serverURLString, operation: operation, onError: onError)
            error = nil
            isPresented = !deferPresentation
        } catch APIError.unauthorized {
            cancel()
            await app.handleAuthFailure(from: client)
        } catch {
            onError(error.localizedDescription)
        }
    }

    func presentPending() {
        if pending != nil { isPresented = true }
    }

    func confirmWithPassphrase(app: AppState) async {
        guard let pending, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            try requireCurrent(pending, app: app)
            try await pending.client.reauthenticate(passphrase: passphrase, code: code.isEmpty ? nil : code)
            try requireCurrent(pending, app: app)
            await retry(pending, app: app)
        } catch { await authenticationFailed(error, pending: pending, app: app) }
    }

    func confirmWithPasskey(app: AppState) async {
        guard let pending, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            try requireCurrent(pending, app: app)
            let options = try await pending.client.reauthenticationPasskeyChallenge()
            try requireCurrent(pending, app: app)
            guard let token = options.passkeyToken, !token.isEmpty,
                  let challenge = Data(base64urlEncoded: options.challenge),
                  let origin = try? ServerOrigin(pending.origin), let host = origin.url.host else {
                throw APIError.server(status: -1, message: "Malformed passkey challenge")
            }
            let rpID = options.rpId ?? host
            try NativePasskey.validate(origin: origin, rpID: rpID)
            let allowed = try options.allowCredentials?.map {
                guard let id = Data(base64urlEncoded: $0.id) else {
                    throw APIError.server(status: -1, message: "Malformed passkey credential")
                }
                return id
            }
            let assertion = try await PasskeyAuthenticator().assert(
                relyingParty: rpID, challenge: challenge, allowedCredentialIDs: allowed
            )
            try requireCurrent(pending, app: app)
            let response = PasskeyAssertionResponse.make(
                credentialID: assertion.credentialID, clientDataJSON: assertion.rawClientDataJSON,
                authenticatorData: assertion.rawAuthenticatorData, signature: assertion.signature,
                userID: assertion.userID, passkeyToken: nil
            )
            try await pending.client.completeReauthenticationPasskey(response: response, passkeyToken: token)
            try requireCurrent(pending, app: app)
            await retry(pending, app: app)
        } catch { await authenticationFailed(error, pending: pending, app: app) }
    }

    func cancel() {
        pending = nil
        isPresented = false
        passphrase = ""
        code = ""
        error = nil
    }

    private func retry(_ captured: Pending, app: AppState) async {
        // Consume before invoking: a second freshness failure is surfaced and
        // can never install another pending replay.
        pending = nil
        passphrase = ""
        code = ""
        do {
            try await captured.operation()
            error = nil
        } catch APIError.unauthorized {
            cancel()
            await app.handleAuthFailure(from: captured.client)
        } catch {
            captured.onError(error.localizedDescription)
        }
        isPresented = false
    }

    private func authenticationFailed(_ caught: Error, pending: Pending, app: AppState) async {
        if case APIError.unauthorized = caught {
            cancel()
            await app.handleAuthFailure(from: pending.client)
        } else {
            // Keep the account-bound operation only while this sheet remains
            // visible so a mistyped passphrase/code can be corrected in place.
            passphrase = ""
            code = ""
            error = caught.localizedDescription
        }
    }

    private func requireCurrent(_ pending: Pending, app: AppState) throws {
        guard app.api() === pending.client, app.serverURLString == pending.origin else {
            throw APIError.unauthorized
        }
    }
}

struct FreshAuthenticationSheet: View {
    @Environment(AppState.self) private var app
    @Bindable var coordinator: FreshAuthenticationCoordinator

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Passphrase", text: $coordinator.passphrase)
                        .textContentType(.password)
                    TextField("MFA code (if enabled)", text: $coordinator.code)
                        .textContentType(.oneTimeCode).textInputAutocapitalization(.never)
                    Button("Continue") { Task { await coordinator.confirmWithPassphrase(app: app) } }
                        .disabled(coordinator.passphrase.isEmpty || coordinator.isBusy)
                }
                if coordinator.registeredPasskeysAvailable,
                   let origin = try? ServerOrigin(app.serverURLString),
                   SecurityRegistrationMode.forServer(origin) == .native {
                    Section {
                        Button { Task { await coordinator.confirmWithPasskey(app: app) } } label: {
                            Label("Use Passkey", systemImage: "person.badge.key")
                        }.disabled(coordinator.isBusy)
                    }
                }
                if let error = coordinator.error { Text(error).foregroundStyle(Theme.red) }
            }
            .navigationTitle("Confirm It’s You")
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { coordinator.cancel() }.disabled(coordinator.isBusy)
            }}
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(coordinator.isBusy)
    }
}
