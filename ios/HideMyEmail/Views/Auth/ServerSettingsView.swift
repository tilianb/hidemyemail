import SwiftUI

/// Lets self-hosters point the app at their own Worker deployment before signing
/// in. The default is the hosted instance at app.hidemyemail.dev.
struct ServerSettingsView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var draft = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://app.hidemyemail.dev", text: $draft)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Server URL")
                } footer: {
                    Text("The origin of your HideMyEmail Worker, including https://.")
                }

                Section {
                    Button("Reset to default") {
                        draft = AppState.defaultServer
                    }
                }
            }
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task { await app.setServerURL(draft) }
                        dismiss()
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear { draft = app.serverURLString }
        }
    }
}
