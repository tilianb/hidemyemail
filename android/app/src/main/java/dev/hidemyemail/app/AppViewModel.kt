package dev.hidemyemail.app

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.hidemyemail.app.auth.TokenStore
import dev.hidemyemail.app.auth.AuthTokenStore
import dev.hidemyemail.app.auth.WebSessionAuth
import dev.hidemyemail.app.auth.ServerOrigin
import dev.hidemyemail.app.net.ApiClient
import dev.hidemyemail.app.net.ApiException
import dev.hidemyemail.app.push.PushManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

sealed interface AuthPhase {
    data object LoggedOut : AuthPhase
    data class AwaitingMfa(val mfaToken: String?) : AuthPhase
    data object LoggedIn : AuthPhase
}

/**
 * App-wide auth + server state, mirroring the iOS `AppState`. Screens own their
 * own data loading; this holds the phase, identity, and the shared ApiClient.
 */
class AppViewModel(
    application: Application,
    private val tokenStore: AuthTokenStore = TokenStore(application),
    private val logoutPush: suspend (ApiClient?) -> Unit = PushManager::onLogout,
    private val beginWebAuth: (Context, String, Long) -> WebSessionAuth.Pending = WebSessionAuth::begin,
) : AndroidViewModel(application) {

    private val prefs = application.getSharedPreferences("settings", Context.MODE_PRIVATE)
    private val _phase = MutableStateFlow<AuthPhase>(AuthPhase.LoggedOut)
    val phase: StateFlow<AuthPhase> = _phase

    private val _serverUrl = MutableStateFlow(
        runCatching { ServerOrigin.parse(prefs.getString(SERVER_KEY, null) ?: DEFAULT_SERVER).value }
            .getOrDefault(DEFAULT_SERVER)
    )
    val serverUrl: StateFlow<String> = _serverUrl

    private val _userName = MutableStateFlow("")
    val userName: StateFlow<String> = _userName

    private val _isAdmin = MutableStateFlow(false)
    val isAdmin: StateFlow<Boolean> = _isAdmin

    private var client: ApiClient? = null
    private var generation = 0L

    // Held between launching the web sign-in Custom Tab and the deep-link
    // callback delivering the handoff code.
    private var pendingWebAuth: WebSessionAuth.Pending? = null

    val hasServer: Boolean get() = runCatching { ServerOrigin.parse(serverUrl.value) }.isSuccess

    fun api(): ApiClient? = client

    init {
        // Bridge push state to the authed client. Safe before login: registration
        // is gated on `enabled` and a valid session inside PushManager.
        PushManager.attach(application, viewModelScope) { client }
    }

    fun setServerUrl(url: String) {
        val origin = runCatching { ServerOrigin.parse(url).value }.getOrElse { return }
        if (origin != _serverUrl.value) {
            generation++
            pendingWebAuth = null
            pendingRecovery = null
            tokenStore.delete()
            client?.invalidate()
            client = null
            _phase.value = AuthPhase.LoggedOut
            _userName.value = ""
            _isAdmin.value = false
        }
        _serverUrl.value = origin
        prefs.edit().putString(SERVER_KEY, origin).apply()
        bootstrap()
    }

    /**
     * Builds (or rebuilds) the API client for the current server, restoring a
     * previously stored token if one exists, and validates it via /api/stats.
     */
    fun bootstrap() {
        if (!hasServer) {
            _phase.value = AuthPhase.LoggedOut
            return
        }
        val origin = serverUrl.value
        val operationGeneration = generation
        val token = tokenStore.load(origin)
        val operationClient = ApiClient(origin, token)
        client = operationClient
        if (token == null) {
            _phase.value = AuthPhase.LoggedOut
            return
        }
        viewModelScope.launch {
            try {
                val stats = operationClient.stats()
                requireCurrent(origin, operationGeneration)
                if (client !== operationClient) return@launch
                _userName.value = stats.userName ?: ""
                _isAdmin.value = stats.isAdmin ?: false
                _phase.value = AuthPhase.LoggedIn
                runCatching { PushManager.onLogin() }
            } catch (_: Exception) {
                if (isCurrent(origin, operationGeneration) && client === operationClient) signOut(operationClient)
            }
        }
    }

    // MARK: Auth flow — these throw; callers surface the message.

    suspend fun login(password: String) {
        val binding = currentBinding()
        val client = ensureClient()
        val res = client.login(password)
        requireCurrent(binding.first, binding.second)
        if (res.mfaRequired == true) {
            _phase.value = AuthPhase.AwaitingMfa(res.mfaToken)
            return
        }
        finishLogin(res.token, res.freshAuth, binding, client)
    }

    suspend fun completeMfa(code: String) {
        val binding = currentBinding()
        val client = client ?: throw ApiException.NotConfigured()
        val mfaToken = (_phase.value as? AuthPhase.AwaitingMfa)?.mfaToken
        val res = client.completeMfa(code, mfaToken)
        finishLogin(res.token, res.freshAuth, binding, client)
    }

    /** Step 1 of web sign-in: open the server's dashboard login in a Custom Tab. */
    fun beginWebLogin(context: Context) {
        ensureClient()
        pendingWebAuth = beginWebAuth(context, serverUrl.value, generation)
    }

    /** Step 2: the hidemyemail://auth?code=… deep link landed — exchange it. */
    fun completeWebLogin(code: String, onError: (String) -> Unit) {
        val pending = pendingWebAuth ?: return
        pendingWebAuth = null
        if (!isCurrent(pending.origin, pending.generation)) return
        val pendingClient = client ?: return
        viewModelScope.launch {
            try {
                if (!isCurrent(pending.origin, pending.generation)) return@launch
                val res = pendingClient.appAuthExchange(code, pending.verifier)
                finishLogin(res.token, res.freshAuth, pending.origin to pending.generation, pendingClient)
            } catch (e: Exception) {
                onError(e.message ?: "Sign-in failed")
            }
        }
    }

    private fun ensureClient(): ApiClient {
        if (!hasServer) throw ApiException.NotConfigured()
        val existing = client
        if (existing != null) return existing
        return ApiClient(serverUrl.value, null).also { client = it }
    }

    private suspend fun finishLogin(
        token: String?,
        freshAuth: String?,
        binding: Pair<String, Long>,
        operationClient: ApiClient,
    ) {
        requireCurrent(binding.first, binding.second)
        if (client !== operationClient || token == null) {
            throw ApiException.Server(500, "No token returned")
        }
        operationClient.token = token
        operationClient.freshAuth = freshAuth
        tokenStore.save(token, binding.first)
        refreshIdentity(operationClient, binding)
        requireCurrent(binding.first, binding.second)
        if (client !== operationClient) throw ApiException.Unauthorized()
        _phase.value = AuthPhase.LoggedIn
        runCatching { PushManager.onLogin() }
    }

    private suspend fun refreshIdentity(
        operationClient: ApiClient = client ?: throw ApiException.NotConfigured(),
        binding: Pair<String, Long> = currentBinding(),
    ) {
        val stats = operationClient.stats()
        requireCurrent(binding.first, binding.second)
        if (client !== operationClient) throw ApiException.Unauthorized()
        _userName.value = stats.userName ?: ""
        _isAdmin.value = stats.isAdmin ?: false
    }

    /**
     * Refresh the displayed identity (e.g. after a username change). Best-effort:
     * failures leave the current name in place.
     */
    fun reloadIdentity() {
        viewModelScope.launch { runCatching { refreshIdentity() } }
    }

    // MARK: Self-service recovery (username + recovery code)

    // Token + freshAuth from a successful recovery, held until the user has
    // saved the new passphrase and taps continue.
    private data class PendingRecovery(
        val token: String?,
        val freshAuth: String?,
        val binding: Pair<String, Long>,
        val client: ApiClient,
    )

    private var pendingRecovery: PendingRecovery? = null

    /**
     * Recover with a username and one-time recovery code. Returns the freshly
     * generated passphrase to show the user; call [finishRecoveredLogin] once
     * they've saved it to complete sign-in.
     */
    suspend fun recoverWithCode(username: String, code: String): String {
        val binding = currentBinding()
        val client = ensureClient()
        val res = client.recoverWithCode(username, code)
        requireCurrent(binding.first, binding.second)
        if (this.client !== client) throw ApiException.Unauthorized()
        pendingRecovery = PendingRecovery(res.token, res.freshAuth, binding, client)
        return res.passphrase
    }

    suspend fun finishRecoveredLogin() {
        val pending = pendingRecovery ?: return
        pendingRecovery = null
        finishLogin(pending.token, pending.freshAuth, pending.binding, pending.client)
    }

    fun signOut() = signOut(client)

    private fun signOut(boundClient: ApiClient?) {
        if (client !== boundClient) return
        // Snapshot credentials for best-effort server cleanup, then synchronously
        // detach and invalidate the active client. Cleanup must never retain or
        // resolve the client slot, which may belong to a new login by the time it
        // resumes.
        val cleanupClient = boundClient?.token?.let { token ->
            ApiClient(serverUrl.value, token).also { it.freshAuth = boundClient.freshAuth }
        }
        generation++
        pendingWebAuth = null
        pendingRecovery = null
        if (client === boundClient) client = null
        boundClient?.invalidate()
        tokenStore.delete()
        _userName.value = ""
        _isAdmin.value = false
        _phase.value = AuthPhase.LoggedOut
        // Best-effort, in the background: invalidate the FCM token (stops delivery
        // even offline) and remove the server-side row. Mirrors iOS.
        viewModelScope.launch {
            try {
                runCatching { logoutPush(cleanupClient) }
            } finally {
                cleanupClient?.invalidate()
            }
        }
    }

    /** Ignore a 401 emitted by a client that has since been replaced. */
    fun handleAuthFailure(from: ApiClient) = signOut(from)

    companion object {
        private const val SERVER_KEY = "server_url"
        const val DEFAULT_SERVER = "https://app.hidemyemail.dev"
    }

    private fun currentBinding() = serverUrl.value to generation

    private fun requireCurrent(origin: String, operationGeneration: Long) {
        if (!isCurrent(origin, operationGeneration)) {
            throw ApiException.Unauthorized()
        }
    }

    private fun isCurrent(origin: String, operationGeneration: Long) =
        origin == serverUrl.value && operationGeneration == generation
}
