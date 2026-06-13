package dev.hidemyemail.app.auth

import android.content.Context

/**
 * Persists the bearer session token, mirroring the iOS KeychainStore. App-private
 * SharedPreferences are sandboxed per-app, and the manifest sets
 * `android:allowBackup="false"` so the token is excluded from Auto Backup and
 * device-to-device transfers — keep that attribute if these prefs ever move.
 */
class TokenStore(context: Context) {
    private val prefs = context.getSharedPreferences("auth", Context.MODE_PRIVATE)

    fun load(): String? = prefs.getString(KEY, null)

    fun save(token: String) {
        prefs.edit().putString(KEY, token).apply()
    }

    fun delete() {
        prefs.edit().remove(KEY).apply()
    }

    private companion object {
        const val KEY = "session_token"
    }
}
