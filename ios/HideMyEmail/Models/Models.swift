import Foundation

// These types mirror the JSON contract served by the Cloudflare Worker
// (`worker/src/api/...` and `dashboard/src/api.ts`). The API encodes booleans
// as 0/1 integers and timestamps as epoch milliseconds, so we decode the raw
// shape and expose friendlier computed accessors.

struct Alias: Identifiable, Decodable, Hashable {
    let id: Int
    let domainId: Int
    let localPart: String
    let fullAddress: String
    let destination: String?
    let label: String?
    let active: Int
    let source: String
    let fwdCount: Int
    let blockedCount: Int
    let replyCount: Int
    let createdAt: Double
    let lastSeenAt: Double?
    let mutedUntil: Double?
    // Joined from the domains table by GET /api/aliases.
    let domain: String?

    var isActive: Bool { active == 1 }
    var createdDate: Date { Date(timeIntervalSince1970: createdAt / 1000) }

    enum CodingKeys: String, CodingKey {
        case id
        case domainId = "domain_id"
        case localPart = "local_part"
        case fullAddress = "full_address"
        case destination, label, active, source
        case fwdCount = "fwd_count"
        case blockedCount = "blocked_count"
        case replyCount = "reply_count"
        case createdAt = "created_at"
        case lastSeenAt = "last_seen_at"
        case mutedUntil = "muted_until"
        case domain
    }
}

struct Destination: Identifiable, Decodable, Hashable {
    let id: Int
    let email: String
    let isDefault: Int
    let verifiedAt: Double?
    let createdAt: Double

    var isDefaultDestination: Bool { isDefault == 1 }
    var isVerified: Bool { verifiedAt != nil }

    enum CodingKeys: String, CodingKey {
        case id, email
        case isDefault = "is_default"
        case verifiedAt = "verified_at"
        case createdAt = "created_at"
    }
}

struct Domain: Identifiable, Decodable, Hashable {
    let id: Int
    let userId: Int
    let isGlobal: Int
    let domain: String
    let active: Int
    let allowCustomAliases: Int
    let verifiedAt: Double?

    var isGlobalDomain: Bool { isGlobal == 1 }
    var allowsCustomAliases: Bool { allowCustomAliases == 1 }
    var isUsable: Bool { active == 1 && (isGlobal == 0 || verifiedAt != nil) }

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case isGlobal = "is_global"
        case domain, active
        case allowCustomAliases = "allow_custom_aliases"
        case verifiedAt = "verified_at"
    }
}

struct Stats: Decodable {
    struct Totals: Decodable { let aliases: Int; let active: Int }
    struct Window: Decodable {
        let forward: Int
        let reply: Int
        let block: Int
        let reject: Int
        let error: Int
    }
    struct TopAlias: Decodable, Identifiable {
        var id: String { fullAddress }
        let fullAddress: String
        let fwdCount: Int
        let replyCount: Int
        let blockedCount: Int

        enum CodingKeys: String, CodingKey {
            case fullAddress = "full_address"
            case fwdCount = "fwd_count"
            case replyCount = "reply_count"
            case blockedCount = "blocked_count"
        }
    }

    let totals: Totals
    let last24h: Window
    let topAliases: [TopAlias]
    let isAdmin: Bool?
    let userName: String?
}

struct ServerConfig: Decodable {
    let mainGlobalDomain: String
    let maxSubdomains: Int
    let maxTotalAliases: Int
    let aliasQuotaBufferEnabled: Bool

    enum CodingKeys: String, CodingKey {
        case mainGlobalDomain = "main_global_domain"
        case maxSubdomains = "max_subdomains"
        case maxTotalAliases = "max_total_aliases"
        case aliasQuotaBufferEnabled = "alias_quota_buffer_enabled"
    }
}

// POST /api/login and /api/mfa/complete return one of these shapes.
struct LoginResponse: Decodable {
    let ok: Bool?
    let userId: Int?
    let token: String?
    let mfaRequired: Bool?
    let mfaToken: String?

    enum CodingKeys: String, CodingKey {
        case ok
        case userId = "userId"
        case token
        case mfaRequired = "mfa_required"
        case mfaToken = "mfa_token"
    }
}
