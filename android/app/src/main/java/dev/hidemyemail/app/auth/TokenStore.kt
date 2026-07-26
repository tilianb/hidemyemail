package dev.hidemyemail.app.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private val tokenKeyLock = Any()

internal inline fun <T> getOrCreateTokenKey(load: () -> T?, create: () -> T): T =
    synchronized(tokenKeyLock) {
        // Recheck while holding the process-wide lock: startup and FCM can both
        // arrive after an initial miss, but only one may create the alias.
        load() ?: create()
    }

/**
 * Persists an origin-bound bearer token encrypted by a non-exportable Android
 * Keystore key. The manifest additionally disables backup.
 */
interface AuthTokenStore {
    fun load(origin: String): String?
    fun save(token: String, origin: String)
    fun delete()
}

class TokenStore(context: Context) : AuthTokenStore {
    private val prefs = context.getSharedPreferences("auth", Context.MODE_PRIVATE)

    override fun load(origin: String): String? {
        // Old releases stored this value in plaintext without an origin. It is
        // impossible to bind safely after a server switch, so delete it.
        prefs.edit().remove(LEGACY_KEY).apply()
        if (prefs.getString(ORIGIN_KEY, null) != origin) return null
        val encrypted = prefs.getString(TOKEN_KEY, null) ?: return null
        val iv = prefs.getString(IV_KEY, null) ?: return null
        return runCatching {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, decode(iv)))
            String(cipher.doFinal(decode(encrypted)), Charsets.UTF_8)
        }.getOrElse { delete(); null }
    }

    override fun save(token: String, origin: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        prefs.edit()
            .remove(LEGACY_KEY)
            .putString(TOKEN_KEY, encode(encrypted))
            .putString(IV_KEY, encode(cipher.iv))
            .putString(ORIGIN_KEY, origin)
            .apply()
    }

    override fun delete() {
        prefs.edit().clear().apply()
    }

    private fun key(): SecretKey {
        return getOrCreateTokenKey(
            load = {
                val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
                store.getKey(KEY_ALIAS, null) as? SecretKey
            },
            create = {
                KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
                    init(KeyGenParameterSpec.Builder(KEY_ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setRandomizedEncryptionRequired(true)
                        .build())
                    generateKey()
                }
            },
        )
    }

    private fun encode(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
    private fun decode(value: String) = Base64.decode(value, Base64.NO_WRAP)

    private companion object {
        const val LEGACY_KEY = "session_token"
        const val TOKEN_KEY = "session_token_encrypted"
        const val IV_KEY = "session_token_iv"
        const val ORIGIN_KEY = "credential_origin"
        const val KEY_ALIAS = "dev.hidemyemail.app.session"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
