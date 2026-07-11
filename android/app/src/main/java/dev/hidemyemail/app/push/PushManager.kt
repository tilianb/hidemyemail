package dev.hidemyemail.app.push

import android.content.Context
import dev.hidemyemail.app.AppViewModel
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import dev.hidemyemail.app.auth.TokenStore
import dev.hidemyemail.app.net.ApiClient
import dev.hidemyemail.app.net.PushPrefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Coordinates FCM push for Android: the user's intent (`enabled`) and per-category
 * `prefs`, the device token round-trip to the Worker (`/api/push/devices`), and
 * the session hooks. The shared singleton is the bridge between the
 * [PushMessagingService] token callback and the Settings UI — mirroring the iOS
 * `PushManager`.
 *
 * It can resolve an authed API client two ways: from the wired ViewModel
 * ([attach]) when the app is running, or — when FCM wakes the service in a cold
 * process — from the persisted server URL + bearer token, so token rotations are
 * registered immediately rather than dropped until the next app launch.
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
    private var appContext: Context? = null
    private var apiProvider: (() -> ApiClient?)? = null
    private var scope: CoroutineScope? = null

    // Latest FCM token, in memory only — FCM reissues it and onTokenRefresh refreshes.
    @Volatile private var deviceToken: String? = null

    /** Wire up persistence + the authed API client. Safe to call repeatedly. */
    fun attach(context: Context, scope: CoroutineScope, apiProvider: () -> ApiClient?) {
        this.scope = scope
        this.apiProvider = apiProvider
        ensureInit(context)
    }

    /**
     * Lazily load persisted state. Runs from both [attach] (app running) and the
     * FCM service path (cold process), so push state is correct without the
     * ViewModel. Idempotent — only the first call reads SharedPreferences.
     */
    private fun ensureInit(context: Context) {
        val app = context.applicationContext
        appContext = app
        if (prefsStore != null) return
        val store = app.getSharedPreferences("push", Context.MODE_PRIVATE)
        prefsStore = store
        _enabled.value = store.getBoolean(KEY_ENABLED, false)
        _prefs.value = PushPrefs(
            blocked = store.getBoolean("blocked", true),
            bounce = store.getBoolean("bounce", true),
            forward = store.getBoolean("forward", false),
            reply = store.getBoolean("reply", false),
        )
        _available.value = FirebaseApp.getApps(app).isNotEmpty()
    }

    /**
     * Resolve an authed client: prefer the wired ViewModel one; otherwise rebuild
     * it from the persisted server URL + bearer token (the FCM service path, where
     * no ViewModel exists). Returns null when there's no server/token yet.
     */
    private fun resolveApi(): ApiClient? {
        apiProvider?.invoke()?.let { return it }
        val ctx = appContext ?: return null
        // The bearer token is the real gate (no token → not signed in). The
        // server URL falls back to the default, because users on the default
        // server never persist `server_url` (AppViewModel only defaults it in
        // memory) — without this, a cold-process token rotation would be dropped.
        val token = TokenStore(ctx).load() ?: return null
        val serverUrl = ctx.getSharedPreferences("settings", Context.MODE_PRIVATE)
            .getString("server_url", null)?.takeIf { it.isNotEmpty() }
            ?: AppViewModel.DEFAULT_SERVER
        return ApiClient(serverUrl, token)
    }

    // MARK: User actions

    /** Turn push on: fetch the FCM token and register this device with the Worker. */
    suspend fun enable() {
        if (!_available.value) return
        _enabled.value = true
        persist()
        val token = fetchToken() ?: return
        deviceToken = token
        runCatching { resolveApi()?.registerPushDevice(token, _prefs.value) }
    }

    /** Turn push off: drop this device from the server and invalidate the token. */
    suspend fun disable() {
        _enabled.value = false
        persist()
        deviceToken?.let { token ->
            runCatching { resolveApi()?.unregisterPushDevice(token) }
        }
        invalidateToken()
    }

    /** Update per-category prefs and push them to the server. */
    suspend fun setPrefs(newPrefs: PushPrefs) {
        _prefs.value = newPrefs
        persist()
        if (!_enabled.value) return
        val token = deviceToken ?: return
        val api = resolveApi() ?: return
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
        runCatching { resolveApi()?.registerPushDevice(token, _prefs.value) }
    }

    /**
     * On sign-out, stop notifications for this device. We **invalidate the FCM
     * token locally first** so background payloads can no longer be delivered
     * even if the network is down, then best-effort drop the server-side row.
     * The caller ([dev.hidemyemail.app.AppViewModel.signOut]) clears the local
     * session synchronously and runs this in the background, passing a snapshot
     * of the still-authed client via [apiOverride] so the server `DELETE` can
     * succeed without blocking the UI. Any lingering server row self-heals when
     * the next dispatch hits the now-dead token (FCM 404/UNREGISTERED → prune).
     * Mirrors iOS calling `unregisterForRemoteNotifications()` on logout.
     */
    suspend fun onLogout(apiOverride: ApiClient? = null) {
        invalidateToken()
        val token = deviceToken
        val api = apiOverride ?: resolveApi()
        if (token != null && api != null) {
            runCatching { api.unregisterPushDevice(token) }
        }
        deviceToken = null
    }

    // MARK: FCM service callback

    /**
     * Called by [PushMessagingService] when FCM issues a new token — including in
     * a cold/background process where [attach] has not run. Initialises from
     * persisted state and registers the rotated token immediately if push is on,
     * so notifications keep flowing without waiting for the next app launch.
     */
    fun onTokenRefresh(context: Context, token: String) {
        ensureInit(context)
        deviceToken = token
        if (!_enabled.value) return
        val api = resolveApi() ?: return
        val activeScope = scope
        if (activeScope != null) {
            activeScope.launch { runCatching { api.registerPushDevice(token, _prefs.value) } }
        } else {
            // Cold process: no ViewModel scope. Block the FCM callback thread (it
            // is not the main thread) until registration completes so the rotation
            // isn't lost when the process is torn down.
            runBlocking { runCatching { api.registerPushDevice(token, _prefs.value) } }
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
