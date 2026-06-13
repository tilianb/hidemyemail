import Foundation

enum APIError: LocalizedError {
    case notConfigured
    case unauthorized
    case server(status: Int, message: String)
    case decoding(Error)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "No server is configured. Set your HideMyEmail server URL first."
        case .unauthorized:
            return "Your session has expired. Please sign in again."
        case .server(_, let message):
            return message
        case .decoding:
            return "The server returned an unexpected response."
        case .transport(let error):
            return error.localizedDescription
        }
    }

    /// True when the caller should drop the stored session and return to login.
    var isAuthFailure: Bool {
        if case .unauthorized = self { return true }
        return false
    }
}

// The Worker returns `{ "error": "..." }` on failures.
struct APIErrorBody: Decodable { let error: String }
