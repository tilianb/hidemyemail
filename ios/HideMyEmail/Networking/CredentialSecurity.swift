import Foundation

struct ServerOrigin: Equatable {
    let url: URL
    var string: String { url.absoluteString }

    /// Creates a canonical origin string from a URL.
    ///
    /// - Parameter url: The URL whose scheme and host define the origin.
    /// - Returns: The canonical origin string, or `nil` if the URL cannot be normalized or contains user credentials.
    static func canonicalOrigin(of url: URL) -> String? {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.user == nil, parts.password == nil else { return nil }
        parts.path = ""
        parts.query = nil
        parts.fragment = nil
        guard let origin = parts.url else { return nil }
        return try? ServerOrigin(origin.absoluteString).string
    }

    init(_ input: String) throws {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var parts = URLComponents(string: trimmed),
              let scheme = parts.scheme?.lowercased(),
              let componentHost = parts.host?.lowercased(),
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else {
            throw APIError.notConfigured
        }
        let host = componentHost.hasPrefix("[") && componentHost.hasSuffix("]")
            ? String(componentHost.dropFirst().dropLast()) : componentHost
        let local = host == "localhost" || host == "127.0.0.1" || host == "::1"
        guard scheme == "https" || (scheme == "http" && local) else {
            throw APIError.notConfigured
        }
        parts.scheme = scheme
        parts.host = componentHost
        parts.path = ""
        if (scheme == "https" && parts.port == 443) || (scheme == "http" && parts.port == 80) {
            parts.port = nil
        }
        guard let canonical = parts.url else { throw APIError.notConfigured }
        self.url = canonical
    }
}

enum SecurityOperation: Equatable {
    case setupMFA
    case regenerateMFA(code: String)
    case disableMFA(code: String)
    case addPasskey(deviceName: String)
    case deletePasskey(id: String)

    var requiresNewMfaCodeAfterReauthentication: Bool {
        if case .disableMFA = self { return true }
        return false
    }
}

struct SecurityFlowState {
    var pendingOperation: SecurityOperation?
    var passphrase = ""
    var reauthenticationCode = ""
    var showReauthentication = false
    private var waitingForActionSheetDismissal = false

    /// Captures a pending security operation and records whether an action sheet is currently presented.
    /// - Parameters:
    ///   - operation: The security operation to store.
    ///   - actionSheetPresented: A Boolean value indicating whether an action sheet is presented.
    mutating func capture(_ operation: SecurityOperation, actionSheetPresented: Bool) {
        pendingOperation = operation
        waitingForActionSheetDismissal = actionSheetPresented
    }

    /// Requests that reauthentication be shown unless an action sheet is awaiting dismissal.
    mutating func requireReauthentication() {
        if waitingForActionSheetDismissal { return }
        showReauthentication = true
    }

    /// Handles dismissal of the action sheet and presents reauthentication when an operation is pending.
    /// - Postcondition: Clears the waiting state and enables reauthentication when dismissal was pending.
    mutating func actionSheetDidDismiss() {
        guard waitingForActionSheetDismissal, pendingOperation != nil else { return }
        waitingForActionSheetDismissal = false
        showReauthentication = true
    }

    /// Retrieves the pending security operation and clears it.
    /// - Returns: The pending security operation, or `nil` if none is pending.
    mutating func consumePendingOperation() -> SecurityOperation? {
        defer { pendingOperation = nil }
        return pendingOperation
    }

    /// Cancels the pending security operation and resets all reauthentication state.
    mutating func cancel() {
        pendingOperation = nil
        passphrase = ""
        reauthenticationCode = ""
        showReauthentication = false
        waitingForActionSheetDismissal = false
    }
}

struct SecurityOperationGuard {
    private(set) var isBusy = false
    var allowsDismissal: Bool { !isBusy }

    /// Attempts to mark the guard as busy.
    /// - Returns: `true` if the guard was not busy and is now marked busy, `false` if it was already busy.
    mutating func begin() -> Bool {
        guard !isBusy else { return false }
        isBusy = true
        return true
    }
    /// Ends the current guarded operation.
mutating func end() { isBusy = false }
}

enum SecurityRequestError {
    /// Determines whether an error represents an unauthorized API response.
    /// - Parameter error: The error to evaluate.
    /// - Returns: `true` if the error is unauthorized, `false` otherwise.
    static func shouldHandleAuthFailure(_ error: Error) -> Bool {
        if case APIError.unauthorized = error { return true }
        return false
    }
}

struct CredentialBinding {
    struct Snapshot: Equatable { let origin: String; let generation: UInt }
    private(set) var origin: String
    private(set) var generation: UInt = 0

    mutating func switchOrigin(to origin: String) {
        guard origin != self.origin else { return }
        self.origin = origin
        generation &+= 1
    }

    mutating func invalidate() {
        generation &+= 1
    }

    func snapshot() -> Snapshot { Snapshot(origin: origin, generation: generation) }
    func accepts(_ snapshot: Snapshot) -> Bool {
        snapshot.origin == origin && snapshot.generation == generation
    }
}
