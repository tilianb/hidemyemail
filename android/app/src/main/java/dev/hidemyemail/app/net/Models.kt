package dev.hidemyemail.app.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// These types mirror the JSON contract served by the Cloudflare Worker
// (worker/src/api/...) — the same shapes the iOS app and web dashboard decode.
// The API encodes booleans as 0/1 integers and timestamps as epoch millis.

@Serializable
data class Alias(
    val id: Int,
    @SerialName("domain_id") val domainId: Int,
    @SerialName("local_part") val localPart: String,
    @SerialName("full_address") val fullAddress: String,
    val destination: String? = null,
    val label: String? = null,
    val active: Int,
    val source: String,
    @SerialName("fwd_count") val fwdCount: Int,
    @SerialName("blocked_count") val blockedCount: Int,
    @SerialName("reply_count") val replyCount: Int,
    @SerialName("created_at") val createdAt: Double,
    @SerialName("last_seen_at") val lastSeenAt: Double? = null,
    @SerialName("muted_until") val mutedUntil: Double? = null,
    // Joined from the domains table by GET /api/aliases.
    val domain: String? = null,
) {
    val isActive: Boolean get() = active == 1
}

@Serializable
data class Destination(
    val id: Int,
    val email: String,
    @SerialName("is_default") val isDefault: Int,
    @SerialName("verified_at") val verifiedAt: Double? = null,
    @SerialName("created_at") val createdAt: Double,
    // Bounce/complaint suppression (migration 0020). Optional so the app
    // still decodes responses from servers that predate the migration.
    @SerialName("suppressed_at") val suppressedAt: Double? = null,
    @SerialName("suppression_reason") val suppressionReason: String? = null,
    @SerialName("suppression_class") val suppressionClass: String? = null,
) {
    val isDefaultDestination: Boolean get() = isDefault == 1
    val isVerified: Boolean get() = verifiedAt != null
    val isSuppressed: Boolean get() = suppressedAt != null
    // Soft suppressions (repeated temporary failures) are user-clearable;
    // hard ones (permanent bounce / spam complaint) need an admin.
    val canSelfUnsuppress: Boolean get() = isSuppressed && suppressionClass == "soft"
}

// One row of an alias's activity feed (GET /api/aliases/:id/events).
@Serializable
data class EmailEvent(
    val id: Int,
    val type: String,        // forward | reply | block | reject | error | bounce | …
    @SerialName("external_sender") val externalSender: String? = null,
    val subject: String? = null,
    val detail: String? = null,
    val ts: Double,
)

@Serializable
data class Domain(
    val id: Int,
    @SerialName("user_id") val userId: Int,
    @SerialName("is_global") val isGlobal: Int,
    val domain: String,
    val active: Int,
    @SerialName("allow_custom_aliases") val allowCustomAliases: Int,
    @SerialName("allow_subdomain_aliases") val allowSubdomainAliases: Int? = null,
    @SerialName("verified_at") val verifiedAt: Double? = null,
    @SerialName("default_destination") val defaultDestination: String? = null,
    @SerialName("created_at") val createdAt: Double? = null,
) {
    val isGlobalDomain: Boolean get() = isGlobal == 1
    val isPersonal: Boolean get() = isGlobal == 0
    val allowsCustomAliases: Boolean get() = allowCustomAliases == 1
    val allowsSubdomainAliases: Boolean get() = (allowSubdomainAliases ?: 0) == 1
    val isUsable: Boolean get() = active == 1 && (isGlobal == 0 || verifiedAt != null)
    // A verified, active global domain that permits subdomain aliases can serve
    // as the base for a user's personal subdomain (mirrors dashboard/Domains.tsx).
    val canHostSubdomains: Boolean
        get() = isGlobalDomain && active == 1 && verifiedAt != null && allowsSubdomainAliases
}

// An allow/block rule. Scope is implied by which id is set: alias-specific
// (alias_id), subdomain-wide (domain_id, personal subdomains only), or
// account-wide (both null). Mirrors the Worker's resolution in db/queries.ts.
@Serializable
data class Block(
    val id: Int,
    @SerialName("alias_id") val aliasId: Int? = null,
    @SerialName("domain_id") val domainId: Int? = null,
    val kind: String,        // "block" | "allow"
    val pattern: String,
    @SerialName("created_at") val createdAt: Double,
) {
    val isAllow: Boolean get() = kind == "allow"
}

@Serializable
data class Stats(
    val totals: Totals,
    val last24h: Window,
    val topAliases: List<TopAlias> = emptyList(),
    val isAdmin: Boolean? = null,
    val userName: String? = null,
) {
    @Serializable
    data class Totals(val aliases: Int, val active: Int)

    @Serializable
    data class Window(
        val forward: Int,
        val reply: Int,
        val block: Int,
        val reject: Int,
        val error: Int,
    )

    @Serializable
    data class TopAlias(
        @SerialName("full_address") val fullAddress: String,
        @SerialName("fwd_count") val fwdCount: Int,
        @SerialName("reply_count") val replyCount: Int,
        @SerialName("blocked_count") val blockedCount: Int,
    )
}

@Serializable
data class ServerConfig(
    @SerialName("main_global_domain") val mainGlobalDomain: String,
    @SerialName("max_subdomains") val maxSubdomains: Int,
    @SerialName("max_total_aliases") val maxTotalAliases: Int,
    @SerialName("alias_quota_buffer_enabled") val aliasQuotaBufferEnabled: Boolean,
)

// POST /api/login, /api/mfa/complete, and /api/app-auth/exchange return one of
// these shapes.
@Serializable
data class LoginResponse(
    val ok: Boolean? = null,
    val userId: Int? = null,
    val token: String? = null,
    @SerialName("mfa_required") val mfaRequired: Boolean? = null,
    @SerialName("mfa_token") val mfaToken: String? = null,
)
