import Foundation

struct ServerOrigin: Equatable {
    let url: URL
    var string: String { url.absoluteString }

    init(_ input: String) throws {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var parts = URLComponents(string: trimmed),
              let scheme = parts.scheme?.lowercased(),
              let host = parts.host?.lowercased(),
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else {
            throw APIError.notConfigured
        }
        let local = host == "localhost" || host == "127.0.0.1" || host == "::1"
        guard scheme == "https" || (scheme == "http" && local) else {
            throw APIError.notConfigured
        }
        parts.scheme = scheme
        parts.host = host
        parts.path = ""
        if (scheme == "https" && parts.port == 443) || (scheme == "http" && parts.port == 80) {
            parts.port = nil
        }
        guard let canonical = parts.url else { throw APIError.notConfigured }
        self.url = canonical
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
