import CoreImage.CIFilterBuiltins
import SwiftUI

struct SecuritySection: View {
    @Environment(AppState.self) private var app
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
    @State private var flow = SecurityFlowState()
    @State private var showMFASetup = false
    @State private var showMFAAction = false
    @State private var disabling = false
    @State private var showPasskeyName = false
    @State private var deleting: Passkey?

    private var busy: Bool { operationGuard.isBusy }

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
        .sheet(isPresented: $showMFASetup, onDismiss: clearMFASecrets) { mfaSetupSheet }
        .sheet(isPresented: $showMFAAction, onDismiss: mfaActionDidDismiss) { mfaActionSheet }
        .sheet(isPresented: Binding(get: { flow.showReauthentication }, set: {
            if !$0 { flow.cancel() }
        })) { reauthSheet }
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
                            Image(uiImage: image).interpolation(.none).resizable()
                                .scaledToFit().frame(maxWidth: 220).accessibilityLabel("MFA setup QR code")
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
                    .disabled(!operationGuard.allowsDismissal)
            }}
        }
        .interactiveDismissDisabled(!operationGuard.allowsDismissal)
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
                } footer: { Text(disabling ? "A backup code may be used to disable MFA." : "Enter your current authenticator code.") }
            }
            .navigationTitle(disabling ? "Disable MFA" : "Backup Codes")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showMFAAction = false } } }
        }
    }

    private var reauthSheet: some View {
        NavigationStack {
            Form {
                SecureField("Passphrase", text: $flow.passphrase).textContentType(.password)
                    .accessibilityLabel("Account passphrase")
                if mfa?.enabled == true {
                    TextField("MFA code", text: $flow.reauthenticationCode)
                        .keyboardType(.asciiCapable)
                        .textContentType(.oneTimeCode)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityLabel("MFA code")
                }
                if let error { Text(error).foregroundStyle(Theme.red) }
                Button("Continue") { Task { await reauthenticate() } }
                    .disabled(flow.passphrase.isEmpty || (mfa?.enabled == true && flow.reauthenticationCode.isEmpty) || busy)
            }
            .navigationTitle("Confirm It’s You")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { flow.cancel() } } }
        }.presentationDetents([.medium])
    }

    private func load() async {
        guard let client = app.api() else { return }
        guard operationGuard.begin() else { return }
        defer { operationGuard.end() }
        do {
            async let status = client.mfaStatus()
            async let credentials = client.passkeys()
            mfa = try await status; passkeys = try await credentials; error = nil
        } catch { await handleRequestError(error, client: client) }
    }

    private func startSensitive(_ operation: SecurityOperation, fromActionSheet: Bool = false) async {
        guard operationGuard.begin() else { return }
        defer { operationGuard.end() }
        flow.capture(operation, actionSheetPresented: fromActionSheet)
        await perform(operation)
    }

    private func handle(_ caught: Error, client: APIClient) async {
        if case APIError.server(let status, let message) = caught,
           status == 401, message == "Fresh authentication required", flow.pendingOperation != nil {
            error = nil
            if showMFAAction { showMFAAction = false }
            flow.requireReauthentication()
        } else {
            flow.cancel()
            await handleRequestError(caught, client: client)
        }
    }

    private func reauthenticate() async {
        guard let client = app.api() else { return }
        guard operationGuard.begin() else { return }
        do {
            try await client.reauthenticate(passphrase: flow.passphrase,
                code: mfa?.enabled == true ? flow.reauthenticationCode : nil)
            let retry = flow.consumePendingOperation()
            let requestNewCode = retry?.requiresNewMfaCodeAfterReauthentication == true
            flow.cancel()
            operationGuard.end()
            if requestNewCode {
                actionCode = ""
                if case .disableMFA = retry {
                    disabling = true
                } else if case .regenerateMFA = retry {
                    disabling = false
                }
                showMFAAction = true
            } else if let retry {
                await execute(retry)
            }
        } catch {
            operationGuard.end()
            await handleRequestError(error, client: client)
        }
    }

    private func verifyMFA() async {
        guard let client = app.api() else { return }
        guard operationGuard.begin() else { return }
        defer { operationGuard.end() }
        do {
            let response = try await client.verifyMFA(code: verifyCode)
            backupCodes = response.backupCodes
            mfa = MfaStatus(enabled: true, backupCodesRemaining: backupCodes.count)
            setup = nil; verifyCode = ""; error = nil
        } catch { await handleRequestError(error, client: client) }
    }

    private func execute(_ operation: SecurityOperation) async {
        guard operationGuard.begin() else { return }
        defer { operationGuard.end() }
        await perform(operation)
    }

    private func perform(_ operation: SecurityOperation) async {
        guard let client = app.api() else { return }
        do {
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
            }
            actionCode = ""; error = nil; _ = flow.consumePendingOperation()
        } catch { await handle(error, client: client) }
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
        guard let client = app.api(), !renameDraft.isEmpty else { return }
        guard operationGuard.begin() else { return }
        defer { operationGuard.end() }
        do {
            try await client.renamePasskey(id: passkey.id, name: renameDraft)
            passkeys = try await client.passkeys()
        } catch { await handleRequestError(error, client: client) }
    }

    private func qrImage(_ value: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        guard let output = filter.outputImage else { return nil }
        return UIImage(ciImage: output.transformed(by: CGAffineTransform(scaleX: 8, y: 8)))
    }

    private func clearMFASecrets() { setup = nil; backupCodes = []; verifyCode = "" }
    private func mfaActionDidDismiss() {
        actionCode = ""
        flow.actionSheetDidDismiss()
    }

    private func handleRequestError(_ caught: Error, client: APIClient) async {
        if SecurityRequestError.shouldHandleAuthFailure(caught) {
            await app.handleAuthFailure(from: client)
        } else {
            error = caught.localizedDescription
        }
    }
}
