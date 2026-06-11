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
    // Bounce/complaint suppression (migration 0020). Optional so the app
    // still decodes responses from servers that predate the migration.
    let suppressedAt: Double?
    let suppressionReason: String?
    let suppressionClass: String?

    var isDefaultDestination: Bool { isDefault == 1 }
    var isVerified: Bool { verifiedAt != nil }
    var isSuppressed: Bool { suppressedAt != nil }
    // Soft suppressions (repeated temporary failures) are user-clearable;
    // hard ones (permanent bounce / spam complaint) need an admin.
    var canSelfUnsuppress: Bool { isSuppressed && suppressionClass == "soft" }

    enum CodingKeys: String, CodingKey {
        case id, email
        case isDefault = "is_default"
        case verifiedAt = "verified_at"
        case createdAt = "created_at"
        case suppressedAt = "suppressed_at"
        case suppressionReason = "suppression_reason"
        case suppressionClass = "suppression_class"
    }
}

// One row of an alias's activity feed (GET /api/aliases/:id/events).
struct EmailEvent: Identifiable, Decodable, Hashable {
    let id: Int
    let type: String        // forward | reply | block | reject | error | bounce | …
    let externalSender: String?
    let subject: String?
    let detail: String?
    let ts: Double

    var date: Date { Date(timeIntervalSince1970: ts / 1000) }

    enum CodingKeys: String, CodingKey {
        case id, type, subject, detail, ts
        case externalSender = "external_sender"
    }
}

struct Domain: Identifiable, Decodable, Hashable {
    let id: Int
    let userId: Int
    let isGlobal: Int
    let domain: String
    let active: Int
    let allowCustomAliases: Int
    let allowSubdomainAliases: Int?
    let verifiedAt: Double?
    let defaultDestination: String?
    let createdAt: Double?
    // Per-subdomain overrides (null = inherit the account/server default).
    let catchAll: Int?
    let inlineActionsPref: String?   // "on" | "off" | nil

    var isGlobalDomain: Bool { isGlobal == 1 }
    var isPersonal: Bool { isGlobal == 0 }
    var allowsCustomAliases: Bool { allowCustomAliases == 1 }
    var allowsSubdomainAliases: Bool { (allowSubdomainAliases ?? 0) == 1 }
    var isUsable: Bool { active == 1 && (isGlobal == 0 || verifiedAt != nil) }
    // A verified, active global domain that permits subdomain aliases can serve
    // as the base for a user's personal subdomain (mirrors dashboard/Domains.tsx).
    var canHostSubdomains: Bool {
        isGlobalDomain && active == 1 && verifiedAt != nil && allowsSubdomainAliases
    }
    var createdDate: Date? { createdAt.map { Date(timeIntervalSince1970: $0 / 1000) } }

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case isGlobal = "is_global"
        case domain, active
        case allowCustomAliases = "allow_custom_aliases"
        case allowSubdomainAliases = "allow_subdomain_aliases"
        case verifiedAt = "verified_at"
        case defaultDestination = "default_destination"
        case createdAt = "created_at"
        case catchAll = "catch_all"
        case inlineActionsPref = "inline_actions_pref"
    }
}

// GET /api/mfa — TOTP status for the signed-in user.
struct MfaStatus: Decodable {
    let enabled: Bool
    let backupCodesRemaining: Int
}

// GET /api/passkeys — registered WebAuthn credentials.
struct Passkey: Identifiable, Decodable, Hashable {
    let id: String
    let deviceName: String?
    let createdAt: Double

    var createdDate: Date { Date(timeIntervalSince1970: createdAt / 1000) }

    enum CodingKeys: String, CodingKey {
        case id
        case deviceName = "device_name"
        case createdAt = "created_at"
    }
}

// GET /api/preferences — account-wide inline-action settings. Null means
// "inherit the server default" (carried in `defaults`).
struct Preferences: Decodable {
    struct Defaults: Decodable {
        let inlineActionsEnabled: Bool
        let inlineActionsPosition: String

        enum CodingKeys: String, CodingKey {
            case inlineActionsEnabled = "inline_actions_enabled"
            case inlineActionsPosition = "inline_actions_position"
        }
    }

    let inlineActionsPref: String?       // "on" | "off" | nil
    let inlineActionsPosition: String?   // "header" | "footer" | nil
    let defaults: Defaults

    enum CodingKeys: String, CodingKey {
        case inlineActionsPref = "inline_actions_pref"
        case inlineActionsPosition = "inline_actions_position"
        case defaults
    }
}

// An allow/block rule. Scope is implied by which id is set: alias-specific
// (alias_id), subdomain-wide (domain_id, personal subdomains only), or
// account-wide (both null). Mirrors the Worker's resolution in db/queries.ts.
struct Block: Identifiable, Decodable, Hashable {
    let id: Int
    let aliasId: Int?
    let domainId: Int?
    let kind: String        // "block" | "allow"
    let pattern: String
    let createdAt: Double

    var isAllow: Bool { kind == "allow" }

    enum CodingKeys: String, CodingKey {
        case id, kind, pattern
        case aliasId = "alias_id"
        case domainId = "domain_id"
        case createdAt = "created_at"
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

// POST /api/passkey/challenge → WebAuthn authentication options. We only need
// the challenge (base64url), the relying-party id, and the signed challenge
// token the native flow echoes back on verify (since we hold no cookie).
struct PasskeyChallengeOptions: Decodable {
    let challenge: String
    let rpId: String?
    let passkeyToken: String?

    enum CodingKeys: String, CodingKey {
        case challenge, rpId
        case passkeyToken = "passkey_token"
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
