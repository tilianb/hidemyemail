import SwiftUI
import AuthenticationServices

struct LoginView: View {
    @Environment(AppState.self) private var app

    @State private var password = ""
    @State private var error: String?
    @State private var busy = false
    @State private var showServerSheet = false

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
