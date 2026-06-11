import SwiftUI

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
                        .font(.largeTitle.bold())
                    Text(app.serverURLString)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
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
                }
                .padding(.horizontal)

                Spacer()
            }
            .padding()
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
}
