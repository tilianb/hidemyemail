package dev.hidemyemail.app.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Talks to the HideMyEmail Cloudflare Worker using the bearer-token auth mode.
 * The web app uses HttpOnly cookies; native clients opt into tokens by sending
 * `X-Auth-Mode: token` on login and `Authorization: Bearer <token>` on every
 * guarded request. Mirrors the iOS `APIClient` actor.
 */
class ApiClient(private val baseUrl: String, @Volatile var token: String? = null) {

    /**
     * Short-lived (10 min) token gating sensitive actions (export, passkey and
     * MFA changes). Held in memory only — it expires long before app restart
     * matters, and persisting it would defeat the freshness guarantee.
     */
    @Volatile var freshAuth: String? = null

    private val http = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        // We manage auth ourselves and never want a cookie store to leak a
        // stale session between accounts.
        .cookieJar(CookieJar.NO_COOKIES)
        .build()

    private val json = Json { ignoreUnknownKeys = true }
    private val jsonMedia = "application/json".toMediaType()

    // MARK: Auth

    /** Returns the raw login response so the caller can branch on MFA. */
    suspend fun login(password: String): LoginResponse = request(
        "/api/login", "POST",
        buildJsonObject { put("password", password) },
        authMode = true, authed = false,
    )

    /**
     * Exchange a web-session handoff code (+ its PKCE verifier) for a bearer
     * token. Used by the web sign-in flow via Custom Tabs.
     */
    suspend fun appAuthExchange(code: String, verifier: String): LoginResponse = request(
        "/api/app-auth/exchange", "POST",
        buildJsonObject { put("code", code); put("verifier", verifier) },
        authMode = true, authed = false,
    )

    suspend fun completeMfa(code: String, mfaToken: String?): LoginResponse = request(
        "/api/mfa/complete", "POST",
        buildJsonObject {
            put("code", code)
            if (mfaToken != null) put("mfa_token", mfaToken)
        },
        authMode = true, authed = false,
    )

    // MARK: Resources

    suspend fun stats(): Stats = request("/api/stats")

    suspend fun aliases(query: String = ""): List<Alias> {
        val path = if (query.isEmpty()) "/api/aliases"
        else "/api/aliases?q=" + URLEncoder.encode(query, "UTF-8")
        return request(path)
    }

    suspend fun createAlias(
        domainId: Int,
        localPart: String,
        destination: String?,
        label: String?,
    ): Alias = request(
        "/api/aliases", "POST",
        buildJsonObject {
            put("domain_id", domainId)
            put("local_part", localPart)
            if (!destination.isNullOrEmpty()) put("destination", destination)
            if (!label.isNullOrEmpty()) put("label", label)
        },
    )

    suspend fun setAliasActive(id: Int, active: Boolean) {
        requestVoid("/api/aliases/$id", "PATCH", buildJsonObject { put("active", if (active) 1 else 0) })
    }

    suspend fun updateAliasLabel(id: Int, label: String?) {
        // JSON null clears the label, matching the Worker's PATCH contract.
        val value: JsonElement = if (label == null) JsonNull else JsonPrimitive(label)
        requestVoid("/api/aliases/$id", "PATCH", JsonObject(mapOf("label" to value)))
    }

    suspend fun deleteAlias(id: Int) = requestVoid("/api/aliases/$id", "DELETE")

    suspend fun destinations(): List<Destination> = request("/api/destinations")

    suspend fun createDestination(email: String) =
        requestVoid("/api/destinations", "POST", buildJsonObject { put("email", email) })

    suspend fun deleteDestination(id: Int) = requestVoid("/api/destinations/$id", "DELETE")

    suspend fun setDefaultDestination(id: Int) = requestVoid("/api/destinations/$id/default", "PATCH")

    /** Resume forwarding to a soft-suppressed destination. */
    suspend fun unsuppressDestination(id: Int) =
        requestVoid("/api/destinations/$id/unsuppress", "POST")

    suspend fun domains(): List<Domain> = request("/api/domains")

    /**
     * Create a personal subdomain (`prefix.<base global domain>`). `prefix` is
     * the label only; the Worker appends the base domain. `defaultDestination`
     * is "global" or a verified destination email. The POST response is a
     * partial row, so we don't decode it — callers reload domains() afterwards.
     */
    suspend fun createDomain(prefix: String, defaultDestination: String, baseDomainId: Int?) {
        requestVoid(
            "/api/domains", "POST",
            buildJsonObject {
                put("domain", prefix)
                put("default_destination", defaultDestination)
                if (baseDomainId != null) put("base_domain_id", baseDomainId)
            },
        )
    }

    suspend fun deleteDomain(id: Int) = requestVoid("/api/domains/$id", "DELETE")

    /**
     * Change a personal subdomain's default destination. [destination] is
     * "global" or a verified destination email (PATCH /api/domains/:id).
     */
    suspend fun updateDomainDestination(id: Int, destination: String) =
        requestVoid("/api/domains/$id", "PATCH", buildJsonObject { put("default_destination", destination) })

    /**
     * Patch any combination of a personal subdomain's settings; JsonNull
     * resets a field to "inherit" (catch_all, inline_actions_pref).
     */
    suspend fun updateDomain(id: Int, fields: JsonObject) =
        requestVoid("/api/domains/$id", "PATCH", fields)

    /**
     * Re-route one alias: a verified destination email, or null to fall back
     * to the default (global domains) / subdomain inheritance.
     */
    suspend fun updateAliasDestination(id: Int, destination: String?) {
        val value: JsonElement = if (destination == null) JsonNull else JsonPrimitive(destination)
        requestVoid("/api/aliases/$id", "PATCH", JsonObject(mapOf("destination" to value)))
    }

    // MARK: Account settings (Settings tab)

    suspend fun preferences(): Preferences = request("/api/settings/preferences")

    /** Update inline-action preferences; JsonNull means "inherit". */
    suspend fun updatePreferences(fields: JsonObject) =
        requestVoid("/api/settings/preferences", "PATCH", fields)

    suspend fun mfaStatus(): MfaStatus = request("/api/settings/mfa")

    // MARK: Username & self-service recovery codes

    /** Current user's username + recovery-code status. */
    suspend fun profile(): Profile = request("/api/account/profile")

    /**
     * Set or clear the public username (null clears). Not a secret and not a
     * login credential, so a normal session is enough. Returns the new value.
     */
    suspend fun setUsername(username: String?): UsernameResponse {
        val value: JsonElement = if (username == null) JsonNull else JsonPrimitive(username)
        return request("/api/account/username", "PATCH", JsonObject(mapOf("username" to value)))
    }

    suspend fun recoveryCodesStatus(): RecoveryCodesStatus = request("/api/account/recovery-codes")

    /**
     * (Re)generate recovery codes. Fresh-auth gated; the Worker 401s without a
     * fresh session. Returns the new plaintext codes (shown once).
     */
    suspend fun regenerateRecoveryCodes(): RecoveryCodesResponse =
        request("/api/account/recovery-codes", "POST")

    /**
     * Self-service recovery: username identifies the account, a one-time code is
     * the secret proof. Public (no session yet), token mode for native.
     */
    suspend fun recoverWithCode(username: String, code: String): RecoverResponse = request(
        "/api/recover/code", "POST",
        buildJsonObject { put("username", username); put("code", code) },
        authMode = true, authed = false,
    )

    suspend fun passkeys(): List<Passkey> = request("/api/settings/passkeys")

    suspend fun renamePasskey(id: String, name: String) =
        requestVoid("/api/settings/passkeys/$id", "PATCH", buildJsonObject { put("deviceName", name) })

    suspend fun deletePasskey(id: String) = requestVoid("/api/settings/passkeys/$id", "DELETE")

    /**
     * Full account export (aliases, domains, destinations, rules…) as raw
     * JSON text. Requires a fresh session; the Worker 401s otherwise.
     */
    suspend fun exportData(): String =
        perform("/api/account/export", "GET", null, authMode = false, authed = true)

    suspend fun config(): ServerConfig = request("/api/config", authed = false)

    suspend fun blocks(): List<Block> = request("/api/blocks")

    /**
     * Create a sender rule. Scope: pass [aliasId] OR [domainId] (personal
     * subdomains only), or neither for an account-wide rule.
     */
    suspend fun createBlock(
        pattern: String,
        kind: String,
        aliasId: Int? = null,
        domainId: Int? = null,
    ): Block = request(
        "/api/blocks", "POST",
        buildJsonObject {
            put("pattern", pattern)
            put("kind", kind)
            if (aliasId != null) put("alias_id", aliasId)
            if (domainId != null) put("domain_id", domainId)
        },
    )

    suspend fun deleteBlock(id: Int) = requestVoid("/api/blocks/$id", "DELETE")

    /** Recent activity for one alias, newest first. */
    suspend fun events(aliasId: Int): List<EmailEvent> = request("/api/aliases/$aliasId/events")

    // MARK: Core request plumbing

    private suspend inline fun <reified T> request(
        path: String,
        method: String = "GET",
        body: JsonObject? = null,
        authMode: Boolean = false,
        authed: Boolean = true,
    ): T {
        val data = perform(path, method, body, authMode, authed)
        return try {
            json.decodeFromString(data)
        } catch (e: Exception) {
            throw ApiException.Decoding()
        }
    }

    private suspend fun requestVoid(path: String, method: String, body: JsonObject? = null) {
        perform(path, method, body, authMode = false, authed = true)
    }

    private suspend fun perform(
        path: String,
        method: String,
        body: JsonObject?,
        authMode: Boolean,
        authed: Boolean,
    ): String = withContext(Dispatchers.IO) {
        val base = baseUrl.trimEnd('/')
        val builder = Request.Builder().url(base + path)
        builder.header("Content-Type", "application/json")
        if (authMode) builder.header("X-Auth-Mode", "token")
        if (authed) {
            val t = token ?: throw ApiException.Unauthorized()
            builder.header("Authorization", "Bearer $t")
            freshAuth?.let { builder.header("X-Fresh-Auth", it) }
        }
        // OkHttp requires a body for POST/PATCH/PUT — send `{}` when empty
        // (e.g. PATCH /destinations/:id/default), matching what the Worker expects.
        if (method == "GET") {
            builder.get()
        } else {
            builder.method(method, (body?.toString() ?: "{}").toRequestBody(jsonMedia))
        }

        val response = try {
            http.newCall(builder.build()).await()
        } catch (e: IOException) {
            throw ApiException.Transport(e)
        }

        response.use { res ->
            val text = res.body?.string() ?: ""
            // A 401 on an authenticated request means the session token is gone
            // or expired → drop it and bounce to login. On the unauthenticated
            // auth endpoints a 401 instead carries a meaningful message like
            // "Invalid passphrase", so fall through and surface that.
            if (res.code == 401 && authed) {
                // Fresh-auth expiry is not a dead session: the bearer token is
                // still valid, only the 10-minute freshness window lapsed.
                // Surface the message so the UI can ask for a re-login on that
                // action instead of signing the whole app out.
                val message = try {
                    json.decodeFromString<ErrorBody>(text).error
                } catch (_: Exception) {
                    null
                }
                if (message == "Fresh authentication required") {
                    throw ApiException.Server(res.code, message)
                }
                throw ApiException.Unauthorized()
            }
            if (res.code !in 200..299) {
                val message = try {
                    json.decodeFromString<ErrorBody>(text).error
                } catch (_: Exception) {
                    "Request failed (${res.code})"
                }
                throw ApiException.Server(res.code, message)
            }
            text
        }
    }

    @kotlinx.serialization.Serializable
    private data class ErrorBody(val error: String)
}

/** Bridge OkHttp's callback API into a cancellable coroutine. */
private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = cont.resume(response)
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }
    })
    cont.invokeOnCancellation { runCatching { cancel() } }
}
