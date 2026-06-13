import SwiftUI

struct MFAView: View {
    @Environment(AppState.self) private var app

    @State private var code = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()
                Image(systemName: "lock.shield")
                    .font(.system(size: 44))
                    .foregroundStyle(Theme.accent)
                Text("Two-Factor Authentication")
                    .font(Theme.display(24, .bold))
                Text("Enter the 6-digit code from your authenticator app, or an 8-character backup code.")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)

                TextField("Code", text: $code)
                    // ASCII (not numberPad): backup codes are 8 alphanumeric
                    // characters, not just digits. The Worker normalises case
                    // and strips separators, so disable autocorrect/caps to
                    // avoid mangling what the user types.
                    .keyboardType(.asciiCapable)
                    .textContentType(.oneTimeCode)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .multilineTextAlignment(.center)
                    .font(Theme.mono(20))
                    .padding()
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
                    .padding(.horizontal)

                if let error {
                    Text(error).font(.footnote).foregroundStyle(Theme.red)
                }

                Button(action: submit) {
                    if busy {
                        ProgressView().tint(.black).frame(maxWidth: .infinity)
                    } else {
                        Text("Verify").bold().frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding(.horizontal)
                .disabled(busy || code.isEmpty)

                Spacer()
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.canvas.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { Task { await app.signOut() } }
                }
            }
        }
    }

    private func submit() {
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                try await app.completeMFA(code: code)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
