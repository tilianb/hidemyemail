import SwiftUI
import AuthenticationServices

struct LoginView: View {
    @Environment(AppState.self) private var app

    @State private var password = ""
    @State private var error: String?
    @State private var busy = false
    @State private var showServerSheet = false
    @State private var showRecoverSheet = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()

                VStack(spacing: 8) {
                    Image(systemName: "envelope.badge.shield.half.filled")
                        .font(.system(size: 44))
                        .foregroundStyle(Theme.accent)
                    Text("HideMyEmail")
                        .font(Theme.display(34, .bold))
                    Text(app.serverURLString)
                        .font(Theme.mono(12))
                        .foregroundStyle(Theme.textSecondary)
                }

                VStack(spacing: 12) {
                    SecureField("Passphrase", text: $password)
                        .textContentType(.password)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding()
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
                        .onSubmit(submit)

                    if let error {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(Theme.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button(action: submit) {
                        if busy {
                            ProgressView().tint(.black)
                                .frame(maxWidth: .infinity)
                        } else {
                            Text("Sign In").bold()
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(busy || password.isEmpty || !app.hasServer)

                    Button(action: passkeyLogin) {
                        Label("Sign in with Passkey", systemImage: "person.badge.key")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .disabled(busy || !app.hasServer)

                    // Native passkey association only covers our own domain;
                    // self-hosters sign in through their server's web login
                    // instead (passkeys work there) and hand a token back.
                    Button(action: webLogin) {
                        Label("Sign in on the Web", systemImage: "safari")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .disabled(busy || !app.hasServer)
                    if app.serverURLString != AppState.defaultServer {
                        Text("Self-hosted server? Use web sign-in for passkeys.")
                            .font(.caption2)
                            .foregroundStyle(Theme.textSecondary)
                    }

                    Button("Forgot passphrase? Recover with a code") {
                        showRecoverSheet = true
                    }
                    .font(.footnote)
                    .disabled(busy || !app.hasServer)
                }
                .padding(.horizontal)

                Spacer()
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.canvas.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Server", systemImage: "server.rack") { showServerSheet = true }
                }
            }
            .sheet(isPresented: $showServerSheet) {
                ServerSettingsView()
            }
            .sheet(isPresented: $showRecoverSheet) {
                RecoverWithCodeView()
            }
        }
    }

    private func submit() {
        guard !password.isEmpty else { return }
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                try await app.login(password: password)
                password = ""
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func passkeyLogin() {
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                try await app.loginWithPasskey()
            } catch let e as ASAuthorizationError where e.code == .canceled {
                // User dismissed the system passkey sheet — not an error.
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func webLogin() {
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                try await app.loginViaWebSession()
            } catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {
                // User dismissed the web sheet — not an error.
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// Self-service recovery: enter username + one-time recovery code, receive a new
/// passphrase to save, then continue into the app.
struct RecoverWithCodeView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var username = ""
    @State private var code = ""
    @State private var error: String?
    @State private var busy = false
    @State private var newPassphrase: String?

    var body: some View {
        NavigationStack {
            Form {
                if let newPassphrase {
                    Section {
                        Text(newPassphrase)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                        Button {
                            UIPasteboard.general.string = newPassphrase
                        } label: {
                            Label("Copy Passphrase", systemImage: "doc.on.doc")
                        }
                    } header: {
                        Text("New Passphrase")
                    } footer: {
                        Text("Save this in your password manager now — it won't be shown again.")
                    }
                    Section {
                        Button("Continue to App") {
                            Task {
                                try? await app.finishRecoveredLogin()
                                dismiss()
                            }
                        }
                        .frame(maxWidth: .infinity)
                    }
                } else {
                    Section {
                        TextField("username", text: $username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("XXXX-XXXX-…", text: $code)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                    } header: {
                        Text("Recover Account")
                    } footer: {
                        if let error {
                            Text(error).foregroundStyle(Theme.red)
                        } else {
                            Text("Enter your username and one of the recovery codes you saved when you created your account.")
                        }
                    }
                    Section {
                        Button(action: recover) {
                            if busy {
                                HStack { Text("Recovering…"); Spacer(); ProgressView() }
                            } else {
                                Text("Recover Account").frame(maxWidth: .infinity)
                            }
                        }
                        .disabled(busy || username.trimmingCharacters(in: .whitespaces).isEmpty || code.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .navigationTitle("Recovery")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func recover() {
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                let passphrase = try await app.recoverWithCode(
                    username: username.trimmingCharacters(in: .whitespaces),
                    code: code.trimmingCharacters(in: .whitespaces)
                )
                newPassphrase = passphrase
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
