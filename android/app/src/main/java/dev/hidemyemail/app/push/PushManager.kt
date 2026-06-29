package dev.hidemyemail.app.push

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import dev.hidemyemail.app.net.ApiClient
import dev.hidemyemail.app.net.PushPrefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Coordinates FCM push for Android: the user's intent (`enabled`) and per-category
 * `prefs`, the device token round-trip to the Worker (`/api/push/devices`), and
 * the session hooks. The shared singleton is the bridge between the
 * [PushMessagingService] token callback and the Settings UI — mirroring the iOS
 * `PushManager`.
 *
 * Push is *available* only when a Firebase project is configured (a
 * `google-services.json` was present at build time). Without it the toggle is
 * shown disabled, exactly like the iOS app no-ops when APNs is unconfigured.
 */
object PushManager {

    private val _enabled = MutableStateFlow(false)
    val enabled: StateFlow<Boolean> = _enabled

    private val _prefs = MutableStateFlow(PushPrefs())
    val prefs: StateFlow<PushPrefs> = _prefs

    /** Whether Firebase is configured in this build (google-services.json present). */
    private val _available = MutableStateFlow(false)
    val available: StateFlow<Boolean> = _available

    private var prefsStore: android.content.SharedPreferences? = null
    private var apiProvider: (() -> ApiClient?)? = null
    private var scope: CoroutineScope? = null

    // Latest FCM token, in memory only — FCM reissues it and onNewToken refreshes.
    @Volatile private var deviceToken: String? = null

    /** Wire up persistence + the authed API client. Safe to call repeatedly. */
    fun attach(context: Context, scope: CoroutineScope, apiProvider: () -> ApiClient?) {
        this.scope = scope
        this.apiProvider = apiProvider
        val store = context.applicationContext.getSharedPreferences("push", Context.MODE_PRIVATE)
        prefsStore = store
        _enabled.value = store.getBoolean(KEY_ENABLED, false)
        _prefs.value = PushPrefs(
            blocked = store.getBoolean("blocked", true),
            bounce = store.getBoolean("bounce", true),
            forward = store.getBoolean("forward", false),
            reply = store.getBoolean("reply", false),
        )
        _available.value = FirebaseApp.getApps(context).isNotEmpty()
    }

    // MARK: User actions

    /** Turn push on: fetch the FCM token and register this device with the Worker. */
    suspend fun enable() {
        if (!_available.value) return
        _enabled.value = true
        persist()
        val token = fetchToken() ?: return
        deviceToken = token
        runCatching { apiProvider?.invoke()?.registerPushDevice(token, _prefs.value) }
    }

    /** Turn push off: drop this device from the server and invalidate the token. */
    suspend fun disable() {
        _enabled.value = false
        persist()
        deviceToken?.let { token ->
            runCatching { apiProvider?.invoke()?.unregisterPushDevice(token) }
        }
        invalidateToken()
    }

    /** Update per-category prefs and push them to the server. */
    suspend fun setPrefs(newPrefs: PushPrefs) {
        _prefs.value = newPrefs
        persist()
        if (!_enabled.value) return
        val token = deviceToken ?: return
        val api = apiProvider?.invoke() ?: return
        // The token is already registered, so PATCH is enough; fall back to a
        // full register if the server doesn't know it yet.
        runCatching { api.updatePushPrefs(token, newPrefs) }
            .onFailure { runCatching { api.registerPushDevice(token, newPrefs) } }
    }

    // MARK: Session hooks

    /** After login, (re)register this device for the new account if push is on. */
    suspend fun onLogin() {
        if (!_enabled.value || !_available.value) return
        val token = fetchToken() ?: return
        deviceToken = token
        runCatching { apiProvider?.invoke()?.registerPushDevice(token, _prefs.value) }
    }

    /**
     * On sign-out, detach this device from the account. We first try the server
     * `DELETE` (best-effort — it can fail offline or with an expired session),
     * then **always invalidate the FCM token locally** so a signed-out or shared
     * device stops receiving the previous account's notifications even if that
     * `DELETE` didn't land. Invalidating the token also makes any lingering
     * server row self-heal: the next dispatch hits a now-unknown token, FCM
     * returns 404/UNREGISTERED, and the Worker prunes it. This mirrors iOS,
     * which calls `unregisterForRemoteNotifications()` on logout.
     */
    suspend fun onLogout() {
        deviceToken?.let { token ->
            runCatching { apiProvider?.invoke()?.unregisterPushDevice(token) }
        }
        invalidateToken()
        deviceToken = null
    }

    // MARK: FCM service callback

    /** Called by [PushMessagingService] when FCM issues a new token. */
    fun onNewToken(token: String) {
        deviceToken = token
        if (!_enabled.value) return
        scope?.launch {
            runCatching { apiProvider?.invoke()?.registerPushDevice(token, _prefs.value) }
        }
    }

    // MARK: Internals

    private suspend fun fetchToken(): String? = suspendCancellableCoroutine { cont ->
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { cont.resume(it) }
            .addOnFailureListener { cont.resume(null) }
    }

    /**
     * Force FCM to discard this device's registration token, so background
     * payloads can no longer be delivered to it. No-op (and never throws) when
     * Firebase isn't configured. The SDK mints a fresh token on next use.
     */
    private suspend fun invalidateToken() {
        if (!_available.value) return
        runCatching {
            suspendCancellableCoroutine { cont ->
                FirebaseMessaging.getInstance().deleteToken()
                    .addOnCompleteListener { cont.resume(Unit) }
            }
        }
    }

    private fun persist() {
        val store = prefsStore ?: return
        val p = _prefs.value
        store.edit()
            .putBoolean(KEY_ENABLED, _enabled.value)
            .putBoolean("blocked", p.blocked)
            .putBoolean("bounce", p.bounce)
            .putBoolean("forward", p.forward)
            .putBoolean("reply", p.reply)
            .apply()
    }

    private const val KEY_ENABLED = "enabled"
}
