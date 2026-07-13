import XCTest
@testable import HideMyEmail

/// These tests pin the JSON contract served by the Worker. The API encodes
/// booleans as 0/1 and timestamps as epoch milliseconds; if a route's shape
/// drifts, decoding here breaks before it reaches a device.
final class ModelDecodingTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testAliasDecodesAndMapsAccessors() throws {
        let json = """
        {
          "id": 7,
          "domain_id": 3,
          "local_part": "shop",
          "full_address": "shop@example.com",
          "destination": "me@inbox.com",
          "label": "Shopping",
          "active": 1,
          "source": "dashboard",
          "fwd_count": 12,
          "blocked_count": 2,
          "reply_count": 1,
          "created_at": 1700000000000,
          "last_seen_at": null,
          "muted_until": null,
          "domain": "example.com"
        }
        """.data(using: .utf8)!

        let alias = try decoder.decode(Alias.self, from: json)
        XCTAssertEqual(alias.id, 7)
        XCTAssertEqual(alias.fullAddress, "shop@example.com")
        XCTAssertEqual(alias.label, "Shopping")
        XCTAssertTrue(alias.isActive)
        XCTAssertEqual(alias.fwdCount, 12)
        XCTAssertNil(alias.lastSeenAt)
        XCTAssertEqual(alias.createdDate.timeIntervalSince1970, 1_700_000_000, accuracy: 1)
    }

    func testAliasFromCreateResponseWithoutJoinedDomain() throws {
        // POST /api/aliases returns the row via RETURNING *, which omits the
        // joined `domain` column. That must still decode.
        let json = """
        {
          "id": 9, "domain_id": 1, "local_part": "x9f2",
          "full_address": "x9f2@example.com", "destination": null,
          "label": null, "active": 1, "source": "dashboard",
          "fwd_count": 0, "blocked_count": 0, "reply_count": 0,
          "created_at": 1700000001000, "last_seen_at": null, "muted_until": null
        }
        """.data(using: .utf8)!

        let alias = try decoder.decode(Alias.self, from: json)
        XCTAssertNil(alias.domain)
        XCTAssertNil(alias.destination)
        XCTAssertNil(alias.label)
    }

    func testDestinationAccessors() throws {
        let json = """
        [
          {"id": 1, "email": "a@b.com", "is_default": 1, "verified_at": 1700000000000, "created_at": 1699999999000},
          {"id": 2, "email": "c@d.com", "is_default": 0, "verified_at": null, "created_at": 1699999998000}
        ]
        """.data(using: .utf8)!

        let dests = try decoder.decode([Destination].self, from: json)
        XCTAssertEqual(dests.count, 2)
        XCTAssertTrue(dests[0].isDefaultDestination)
        XCTAssertTrue(dests[0].isVerified)
        XCTAssertFalse(dests[1].isDefaultDestination)
        XCTAssertFalse(dests[1].isVerified)
    }

    func testDomainUsability() throws {
        let json = """
        [
          {"id": 1, "user_id": 0, "is_global": 1, "domain": "global.com", "active": 1, "allow_custom_aliases": 0, "verified_at": 1700000000000},
          {"id": 2, "user_id": 0, "is_global": 1, "domain": "pending.com", "active": 1, "allow_custom_aliases": 1, "verified_at": null},
          {"id": 3, "user_id": 5, "is_global": 0, "domain": "mine.com", "active": 1, "allow_custom_aliases": 1, "verified_at": null}
        ]
        """.data(using: .utf8)!

        let domains = try decoder.decode([Domain].self, from: json)
        XCTAssertTrue(domains[0].isUsable)           // verified global
        XCTAssertFalse(domains[0].allowsCustomAliases)
        XCTAssertFalse(domains[1].isUsable)          // unverified global
        XCTAssertTrue(domains[2].isUsable)           // own domain, active
    }

    func testStatsDecodes() throws {
        let json = """
        {
          "totals": {"aliases": 4, "active": 3},
          "last24h": {"forward": 5, "reply": 1, "block": 2, "reject": 0, "error": 0},
          "topAliases": [
            {"full_address": "a@x.com", "fwd_count": 9, "reply_count": 1, "blocked_count": 0}
          ],
          "isAdmin": true,
          "userName": "Admin"
        }
        """.data(using: .utf8)!

        let stats = try decoder.decode(Stats.self, from: json)
        XCTAssertEqual(stats.totals.aliases, 4)
        XCTAssertEqual(stats.last24h.forward, 5)
        XCTAssertEqual(stats.topAliases.first?.fwdCount, 9)
        XCTAssertEqual(stats.isAdmin, true)
        XCTAssertEqual(stats.userName, "Admin")
    }

    func testLoginResponseVariants() throws {
        let success = try decoder.decode(LoginResponse.self, from: Data("""
        {"ok": true, "userId": 1, "token": "v2.1.999.abc"}
        """.utf8))
        XCTAssertEqual(success.token, "v2.1.999.abc")
        XCTAssertNil(success.mfaRequired)

        let mfa = try decoder.decode(LoginResponse.self, from: Data("""
        {"mfa_required": true, "mfa_token": "mfa.1.999.def"}
        """.utf8))
        XCTAssertEqual(mfa.mfaRequired, true)
        XCTAssertEqual(mfa.mfaToken, "mfa.1.999.def")
        XCTAssertNil(mfa.token)
    }

    func testServerConfigDecodes() throws {
        let cfg = try decoder.decode(ServerConfig.self, from: Data("""
        {"main_global_domain": "example.com", "max_subdomains": 5, "max_total_aliases": 10, "alias_quota_buffer_enabled": true, "catch_all_auto_create": true, "inline_actions_default_enabled": false}
        """.utf8))
        XCTAssertEqual(cfg.mainGlobalDomain, "example.com")
        XCTAssertEqual(cfg.maxTotalAliases, 10)
        XCTAssertTrue(cfg.aliasQuotaBufferEnabled)
        XCTAssertEqual(cfg.catchAllAutoCreate, true)

        let legacy = try decoder.decode(ServerConfig.self, from: Data("""
        {"main_global_domain": "example.com", "max_subdomains": 5, "max_total_aliases": 10, "alias_quota_buffer_enabled": true}
        """.utf8))
        XCTAssertNil(legacy.catchAllAutoCreate)
    }

    func testDestinationSuppressionDecodes() throws {
        // Soft-suppressed destination → user can self-resume.
        let soft = try decoder.decode(Destination.self, from: Data("""
        {"id": 1, "email": "me@x.com", "is_default": 1, "verified_at": 1000, "created_at": 1000,
         "suppressed_at": 2000, "suppression_reason": "soft_bounce", "suppression_class": "soft"}
        """.utf8))
        XCTAssertTrue(soft.isSuppressed)
        XCTAssertTrue(soft.canSelfUnsuppress)

        // Hard suppression → admin-only clear.
        let hard = try decoder.decode(Destination.self, from: Data("""
        {"id": 2, "email": "b@x.com", "is_default": 0, "verified_at": 1000, "created_at": 1000,
         "suppressed_at": 2000, "suppression_reason": "complaint", "suppression_class": "hard"}
        """.utf8))
        XCTAssertTrue(hard.isSuppressed)
        XCTAssertFalse(hard.canSelfUnsuppress)

        // Pre-migration servers omit the fields entirely.
        let legacy = try decoder.decode(Destination.self, from: Data("""
        {"id": 3, "email": "c@x.com", "is_default": 0, "verified_at": null, "created_at": 1000}
        """.utf8))
        XCTAssertFalse(legacy.isSuppressed)
    }

    func testEmailEventDecodes() throws {
        let events = try decoder.decode([EmailEvent].self, from: Data("""
        [
          {"id": 1, "alias_id": 7, "type": "forward", "external_sender": "a@store.com",
           "subject": "Order", "bytes": 1200, "detail": null, "ts": 1700000000000},
          {"id": 2, "alias_id": 7, "type": "reject", "external_sender": null,
           "subject": null, "bytes": null, "detail": "rate", "ts": 1700000100000}
        ]
        """.utf8))
        XCTAssertEqual(events.count, 2)
        XCTAssertEqual(events[0].type, "forward")
        XCTAssertEqual(events[0].subject, "Order")
        XCTAssertEqual(events[1].detail, "rate")
        XCTAssertEqual(events[0].date.timeIntervalSince1970, 1_700_000_000, accuracy: 1)
    }
}
