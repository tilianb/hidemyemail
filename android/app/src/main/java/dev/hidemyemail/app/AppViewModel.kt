package dev.hidemyemail.app

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.hidemyemail.app.auth.TokenStore
import dev.hidemyemail.app.auth.WebSessionAuth
import dev.hidemyemail.app.net.ApiClient
import dev.hidemyemail.app.net.ApiException
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
class AppViewModel(application: Application) : AndroidViewModel(application) {

    private val prefs = application.getSharedPreferences("settings", Context.MODE_PRIVATE)
    private val tokenStore = TokenStore(application)

    private val _phase = MutableStateFlow<AuthPhase>(AuthPhase.LoggedOut)
    val phase: StateFlow<AuthPhase> = _phase

    private val _serverUrl = MutableStateFlow(
        prefs.getString(SERVER_KEY, null)?.takeIf { it.isNotEmpty() } ?: DEFAULT_SERVER
    )
    val serverUrl: StateFlow<String> = _serverUrl

    private val _userName = MutableStateFlow("")
    val userName: StateFlow<String> = _userName

    private val _isAdmin = MutableStateFlow(false)
    val isAdmin: StateFlow<Boolean> = _isAdmin

    private var client: ApiClient? = null

    // Held between launching the web sign-in Custom Tab and the deep-link
    // callback delivering the handoff code.
    private var pendingWebAuth: WebSessionAuth.Pending? = null

    val hasServer: Boolean
        get() = serverUrl.value.startsWith("http://") || serverUrl.value.startsWith("https://")

    fun api(): ApiClient? = client

    fun setServerUrl(url: String) {
        val trimmed = url.trim()
        _serverUrl.value = trimmed
        prefs.edit().putString(SERVER_KEY, trimmed).apply()
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
        val token = tokenStore.load()
        client = ApiClient(serverUrl.value, token)
        if (token == null) {
            _phase.value = AuthPhase.LoggedOut
            return
        }
        viewModelScope.launch {
            try {
                refreshIdentity()
                _phase.value = AuthPhase.LoggedIn
            } catch (_: Exception) {
                signOut()
            }
        }
    }

    // MARK: Auth flow — these throw; callers surface the message.

    suspend fun login(password: String) {
        val client = ensureClient()
        val res = client.login(password)
        if (res.mfaRequired == true) {
            _phase.value = AuthPhase.AwaitingMfa(res.mfaToken)
            return
        }
        finishLogin(res.token, res.freshAuth)
    }

    suspend fun completeMfa(code: String) {
        val client = client ?: throw ApiException.NotConfigured()
        val mfaToken = (_phase.value as? AuthPhase.AwaitingMfa)?.mfaToken
        val res = client.completeMfa(code, mfaToken)
        finishLogin(res.token, res.freshAuth)
    }

    /** Step 1 of web sign-in: open the server's dashboard login in a Custom Tab. */
    fun beginWebLogin(context: Context) {
        ensureClient()
        pendingWebAuth = WebSessionAuth.begin(context, serverUrl.value)
    }

    /** Step 2: the hidemyemail://auth?code=… deep link landed — exchange it. */
    fun completeWebLogin(code: String, onError: (String) -> Unit) {
        val pending = pendingWebAuth ?: return
        pendingWebAuth = null
        viewModelScope.launch {
            try {
                val client = ensureClient()
                val res = client.appAuthExchange(code, pending.verifier)
                finishLogin(res.token, res.freshAuth)
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

    private suspend fun finishLogin(token: String?, freshAuth: String?) {
        val client = client
        if (token == null || client == null) {
            throw ApiException.Server(500, "No token returned")
        }
        client.token = token
        client.freshAuth = freshAuth
        tokenStore.save(token)
        refreshIdentity()
        _phase.value = AuthPhase.LoggedIn
    }

    private suspend fun refreshIdentity() {
        val client = client ?: throw ApiException.NotConfigured()
        val stats = client.stats()
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
    private var pendingRecovery: Pair<String?, String?>? = null

    /**
     * Recover with a username and one-time recovery code. Returns the freshly
     * generated passphrase to show the user; call [finishRecoveredLogin] once
     * they've saved it to complete sign-in.
     */
    suspend fun recoverWithCode(username: String, code: String): String {
        val client = ensureClient()
        val res = client.recoverWithCode(username, code)
        pendingRecovery = res.token to res.freshAuth
        return res.passphrase
    }

    suspend fun finishRecoveredLogin() {
        val pending = pendingRecovery ?: return
        pendingRecovery = null
        finishLogin(pending.first, pending.second)
    }

    fun signOut() {
        tokenStore.delete()
        client?.token = null
        client?.freshAuth = null
        _userName.value = ""
        _isAdmin.value = false
        _phase.value = AuthPhase.LoggedOut
    }

    /** Called by screens when a request fails with 401 mid-session. */
    fun handleAuthFailure() = signOut()

    companion object {
        private const val SERVER_KEY = "server_url"
        const val DEFAULT_SERVER = "https://app.hidemyemail.dev"
    }
}
