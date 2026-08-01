import CoreImage.CIFilterBuiltins
import SwiftUI

struct SecuritySection: View {
    @Environment(AppState.self) private var app
    @Environment(FreshAuthenticationCoordinator.self) private var freshAuthentication
    @Environment(\.openURL) private var openURL

    @State private var mfa: MfaStatus?
    @State private var passkeys: [Passkey] = []
    @State private var setup: MFASetupResponse?
    @State private var backupCodes: [String] = []
    @State private var verifyCode = ""
    @State private var actionCode = ""
    @State private var deviceName = UIDevice.current.userInterfaceIdiom == .pad ? "My iPad" : "My iPhone"
    @State private var renaming: Passkey?
    @State private var renameDraft = ""
    @State private var error: String?
    @State private var operationGuard = SecurityOperationGuard()
    @State private var showMFASetup = false
    @State private var showMFAAction = false
    @State private var disabling = false
    @State private var showPasskeyName = false
    @State private var deleting: Passkey?
    @State private var showMFASetupAfterFreshAuth = false
    @State private var showMFAActionAfterFreshAuth = false

    private var busy: Bool { operationGuard.isBusy || freshAuthentication.isBusy }
    private var canUseNativePasskey: Bool {
        guard !passkeys.isEmpty, let origin = try? ServerOrigin(app.serverURLString) else { return false }
        return SecurityRegistrationMode.forServer(origin) == .native
    }

    var body: some View {
        Section {
            mfaRow.disabled(busy)
            passkeyRows.disabled(busy)
            Button { showPasskeyName = true } label: {
                Label("Add Passkey", systemImage: "person.badge.key")
            }
            .disabled(busy)
        } header: {
            Text("Security")
        } footer: {
            if let error { Text(error).foregroundStyle(Theme.red) }
            else { Text("Protect your account with authenticator codes and passkeys.") }
        }
        .task { await load() }
        .sheet(isPresented: $showMFASetup, onDismiss: mfaSetupDidDismiss) { mfaSetupSheet }
        .sheet(isPresented: $showMFAAction, onDismiss: mfaActionDidDismiss) { mfaActionSheet }
        .onChange(of: freshAuthentication.isPresented) { _, presented in
            guard !presented else { return }
            if showMFASetupAfterFreshAuth {
                showMFASetupAfterFreshAuth = false
                showMFASetup = true
            } else if showMFAActionAfterFreshAuth {
                showMFAActionAfterFreshAuth = false
                showMFAAction = true
            }
        }
        .alert("Name This Passkey", isPresented: $showPasskeyName) {
            TextField("Device name", text: $deviceName)
            Button("Cancel", role: .cancel) {}
            Button("Continue") { Task { await addPasskey() } }
        } message: { Text("This helps you recognize it later.") }
        .alert("Delete Passkey?", isPresented: Binding(
            get: { deleting != nil }, set: { if !$0 { deleting = nil } }
        )) {
            Button("Cancel", role: .cancel) { deleting = nil }
            Button("Delete", role: .destructive) {
                if let passkey = deleting {
                    deleting = nil
                    Task { await startSensitive(.deletePasskey(id: passkey.id)) }
                }
            }
        } message: { Text("This passkey will no longer sign in to your account.") }
        .alert("Rename Passkey", isPresented: Binding(
            get: { renaming != nil }, set: { if !$0 { renaming = nil } }
        )) {
            TextField("Device name", text: $renameDraft)
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Save") {
                if let passkey = renaming { Task { await rename(passkey) } }
                renaming = nil
            }
        }
    }

    @ViewBuilder private var mfaRow: some View {
        HStack {
            Label("Two-factor auth", systemImage: "lock.shield")
            Spacer()
            Text(mfa?.enabled == true ? "On · \(mfa?.backupCodesRemaining ?? 0) codes" : "Off")
                .foregroundStyle(mfa?.enabled == true ? Theme.green : Theme.textSecondary)
                .font(.callout)
        }
        if mfa?.enabled == true {
            Button("Regenerate MFA Backup Codes") {
                disabling = false; showMFAAction = true
            }
            Button("Disable Two-Factor Authentication", role: .destructive) {
                disabling = true; showMFAAction = true
            }
        } else {
            Button("Enable Two-Factor Authentication") {
                Task { await startSensitive(.setupMFA) }
            }
        }
    }

    @ViewBuilder private var passkeyRows: some View {
        if passkeys.isEmpty {
            LabeledContent("Passkeys", value: "None registered")
        } else {
            ForEach(passkeys) { passkey in
                VStack(alignment: .leading, spacing: 2) {
                    Text(passkey.deviceName ?? "Unnamed passkey")
                    Text(passkey.createdDate, format: .dateTime.day().month().year())
                        .font(.caption).foregroundStyle(Theme.textSecondary)
                }
                .accessibilityElement(children: .combine)
                .swipeActions {
                    Button("Delete", role: .destructive) {
                        deleting = passkey
                    }
                    Button("Rename") {
                        renameDraft = passkey.deviceName ?? ""
                        renaming = passkey
                    }.tint(Theme.accent)
                }
            }
        }
    }

    private var mfaSetupSheet: some View {
        NavigationStack {
            Form {
                if !backupCodes.isEmpty {
                    Section {
                        ForEach(backupCodes, id: \.self) { Text($0).font(.system(.body, design: .monospaced)) }
                        Button { UIPasteboard.general.string = backupCodes.joined(separator: "\n") } label: {
                            Label("Copy All Codes", systemImage: "doc.on.doc")
                        }.accessibilityLabel("Copy all MFA backup codes")
                    } header: { Text("Save These Backup Codes") }
                      footer: { Text("These codes are shown once.") }
                } else if let setup {
                    Section("Scan QR Code") {
                        if let image = qrImage(setup.uri) {
                            Image(uiImage: image)
                                .interpolation(.none)
                                .resizable()
                                .frame(width: 196, height: 196)
                                .padding(12)
                                .background(Color.white)
                                .frame(maxWidth: .infinity)
                                .accessibilityLabel("MFA setup QR code")
                        }
                        Text(setup.secret).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        Button { UIPasteboard.general.string = setup.secret } label: {
                            Label("Copy Manual Secret", systemImage: "doc.on.doc")
                        }.accessibilityLabel("Copy MFA manual secret")
                    }
                    Section("Verify") {
                        TextField("Six-digit code", text: $verifyCode)
                            .keyboardType(.numberPad).textContentType(.oneTimeCode)
                            .accessibilityLabel("Six-digit authenticator code")
                        if let error { Text(error).foregroundStyle(Theme.red) }
                        Button("Verify and Enable") { Task { await verifyMFA() } }
                            .disabled(verifyCode.count != 6 || busy)
                    }
                } else { ProgressView() }
            }
            .navigationTitle(backupCodes.isEmpty ? "Set Up MFA" : "MFA Enabled")
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button(backupCodes.isEmpty ? "Cancel" : "Done") { showMFASetup = false }
                    .disabled(busy)
            }}
        }
        .interactiveDismissDisabled(busy)
    }

    private var mfaActionSheet: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Authenticator or backup code", text: $actionCode)
                        .textContentType(.oneTimeCode).accessibilityLabel("Authenticator or backup code")
                    if let error { Text(error).foregroundStyle(Theme.red) }
                    Button(disabling ? "Disable MFA" : "Regenerate Codes", role: disabling ? .destructive : nil) {
                        let operation: SecurityOperation = disabling
                            ? .disableMFA(code: actionCode) : .regenerateMFA(code: actionCode)
                        Task { await startSensitive(operation, fromActionSheet: true) }
                    }.disabled(actionCode.isEmpty || busy)
                    if canUseNativePasskey {
                        Button("Use Passkey") { Task { await usePasskeyForMFAAction() } }
                            .disabled(busy)
                    }
                } footer: { Text(disabling ? "A backup code may be used to disable MFA." : "Enter your current authenticator code.") }
            }
            .navigationTitle(disabling ? "Disable MFA" : "Backup Codes")
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { showMFAAction = false }.disabled(busy)
            }}
        }
        .interactiveDismissDisabled(busy)
    }

    private func load() async {
        guard let client = app.api() else { return }
        guard operationGuard.begin() else { return }
        defer { operationGuard.end() }
        do {
            async let status = client.mfaStatus()
            async let credentials = client.passkeys()
            mfa = try await status; passkeys = try await credentials
            freshAuthentication.registeredPasskeysAvailable = !passkeys.isEmpty
            error = nil
        } catch { await handleRequestError(error, client: client) }
    }

    private func startSensitive(_ operation: SecurityOperation, fromActionSheet: Bool = false) async {
        guard let client = app.api() else { return }
        var attempt = 0
        await freshAuthentication.perform(
            app: app, onError: { error = $0 }, deferPresentation: fromActionSheet
        ) {
            attempt += 1
            guard app.api() === client else { throw APIError.unauthorized }
            if attempt > 1 && operation.requiresNewMfaCodeAfterReauthentication {
                actionCode = ""
                if case .disableMFA = operation { disabling = true } else { disabling = false }
                showMFAActionAfterFreshAuth = true
                return
            }
            try await perform(operation, client: client)
        }
        if fromActionSheet && freshAuthentication.isPending { showMFAAction = false }
    }

    private func verifyMFA() async {
        guard let client = app.api() else { return }
        var attempt = 0
        await freshAuthentication.perform(
            app: app, onError: { error = $0 }, deferPresentation: true
        ) {
            attempt += 1
            if attempt > 1 {
                verifyCode = ""
                setup = try await client.setupMFA()
                showMFASetupAfterFreshAuth = true
                return
            }
            let response = try await client.verifyMFA(code: verifyCode)
            backupCodes = response.backupCodes
            mfa = MfaStatus(enabled: true, backupCodesRemaining: backupCodes.count)
            setup = nil; verifyCode = ""; error = nil
        }
        if freshAuthentication.isPending { showMFASetup = false }
    }

    private func usePasskeyForMFAAction() async {
        guard canUseNativePasskey, let client = app.api() else { return }
        guard operationGuard.begin() else { return }
        defer { operationGuard.end() }
        do {
            let action: MFAPasskeyAction = disabling ? .disable : .backupCodes
            let options = try await client.mfaPasskeyChallenge(action: action)
            guard let challenge = Data(base64urlEncoded: options.challenge),
                  let passkeyToken = options.passkeyToken,
                  let origin = try? ServerOrigin(app.serverURLString),
                  let host = origin.url.host else {
                throw APIError.server(status: -1, message: "Malformed passkey challenge")
            }
            let rpID = options.rpId ?? host
            try NativePasskeyRegistration.validate(origin: origin, rpID: rpID)
            let assertion = try await PasskeyAuthenticator().assert(relyingParty: rpID, challenge: challenge)
            let response = PasskeyAssertionResponse.make(
                credentialID: assertion.credentialID,
                clientDataJSON: assertion.rawClientDataJSON,
                authenticatorData: assertion.rawAuthenticatorData,
                signature: assertion.signature,
                userID: assertion.userID,
                passkeyToken: nil
            )
            let result = try await client.completeMFAPasskeyAction(
                action, response: response, passkeyToken: passkeyToken
            )
            if disabling {
                mfa = MfaStatus(enabled: false, backupCodesRemaining: 0)
                showMFAAction = false
            } else {
                guard let codes = result.backupCodes else {
                    throw APIError.server(status: -1, message: "Backup codes were not returned")
                }
                backupCodes = codes
                mfa = MfaStatus(enabled: true, backupCodesRemaining: backupCodes.count)
                showMFAAction = false
                showMFASetup = true
            }
            actionCode = ""; error = nil
        } catch {
            await handleRequestError(error, client: client)
        }
    }

    private func perform(_ operation: SecurityOperation, client: APIClient) async throws {
        guard app.api() === client else { throw APIError.unauthorized }
        switch operation {
            case .setupMFA:
                setup = try await client.setupMFA(); showMFASetup = true
            case .disableMFA(let code):
                try await client.disableMFA(code: code)
                mfa = MfaStatus(enabled: false, backupCodesRemaining: 0)
                showMFAAction = false
            case .regenerateMFA(let code):
                backupCodes = try await client.regenerateMFABackupCodes(code: code)
                mfa = MfaStatus(enabled: true, backupCodesRemaining: backupCodes.count)
                showMFAAction = false; showMFASetup = true
            case .addPasskey(let name):
                try await addPasskey(name: name, client: client)
            case .deletePasskey(let id):
                try await client.deletePasskey(id: id)
                passkeys.removeAll { $0.id == id }
            case .renamePasskey(let id, let name):
                try await client.renamePasskey(id: id, name: name)
                passkeys = try await client.passkeys()
        }
        freshAuthentication.registeredPasskeysAvailable = !passkeys.isEmpty
        actionCode = ""; error = nil
    }

    private func addPasskey() async {
        await startSensitive(.addPasskey(deviceName: deviceName.trimmingCharacters(in: .whitespaces)))
    }

    private func addPasskey(name: String, client: APIClient) async throws {
        guard let origin = try? ServerOrigin(app.serverURLString) else { return }
        if SecurityRegistrationMode.forServer(origin) == .handoff {
            openURL(try await client.securityHandoffURL())
        } else {
                    let options = try await client.passkeyRegistrationChallenge()
                    try NativePasskeyRegistration.validate(origin: origin, rpID: options.rp.id)
                    guard let challenge = Data(base64urlEncoded: options.challenge),
                          let userID = Data(base64urlEncoded: options.user.id) else {
                        throw APIError.server(status: -1, message: "Malformed passkey challenge")
                    }
                    let credential = try await PasskeyAuthenticator().register(
                        relyingParty: options.rp.id, challenge: challenge,
                        userID: userID, userName: options.user.name
                    )
                    guard let attestation = credential.rawAttestationObject else {
                        throw APIError.server(status: -1, message: "Missing passkey attestation")
                    }
                    let response = PasskeyRegistrationResponse.make(
                        credentialID: credential.credentialID,
                        clientDataJSON: credential.rawClientDataJSON,
                        attestationObject: attestation, attachment: "platform"
                    )
                    try await client.registerPasskey(response: response,
                        deviceName: name,
                        challengeToken: options.challengeToken)
            passkeys = try await client.passkeys()
        }
    }

    private func rename(_ passkey: Passkey) async {
        guard !renameDraft.isEmpty else { return }
        await startSensitive(.renamePasskey(id: passkey.id, name: renameDraft))
    }

    private func qrImage(_ value: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        guard let output = filter.outputImage else { return nil }

        let colors = CIFilter.falseColor()
        colors.inputImage = output
        colors.color0 = CIColor.black
        colors.color1 = CIColor.white
        guard let rendered = colors.outputImage,
              let image = CIContext().createCGImage(rendered, from: rendered.extent) else { return nil }
        return UIImage(cgImage: image)
    }

    private func clearMFASecrets() { setup = nil; backupCodes = []; verifyCode = "" }
    private func mfaSetupDidDismiss() {
        clearMFASecrets()
        freshAuthentication.presentPending()
    }
    private func mfaActionDidDismiss() {
        actionCode = ""
        freshAuthentication.presentPending()
    }

    private func handleRequestError(_ caught: Error, client: APIClient) async {
        if SecurityRequestError.shouldHandleAuthFailure(caught) {
            await app.handleAuthFailure(from: client)
        } else {
            error = caught.localizedDescription
        }
    }

}
