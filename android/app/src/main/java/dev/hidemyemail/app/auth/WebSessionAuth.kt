package dev.hidemyemail.app.auth

import android.content.Context
import android.net.Uri
import android.util.Base64
import androidx.browser.customtabs.CustomTabsIntent
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Web-session login for any server, self-hosted included.
 *
 * The app opens the server's own dashboard login (`/app-auth`) in a Custom Tab —
 * passkeys work there because the WebAuthn ceremony is associated with the
 * server's domain via the web, not the app. The dashboard then hands back a
 * short-lived code over the `hidemyemail://auth` deep link, which the app
 * exchanges (PKCE-style, with a verifier that never leaves the device) for a
 * bearer token. Mirrors the iOS `WebSessionAuthenticator`.
 */
object WebSessionAuth {

    data class Pending(val verifier: String)

    /** Launches the Custom Tab and returns the PKCE verifier to hold onto. */
    fun begin(context: Context, serverUrl: String): Pending {
        val verifier = randomVerifier()
        val challenge = challengeFor(verifier)
        val url = Uri.parse(serverUrl.trimEnd('/'))
            .buildUpon()
            .path("/app-auth")
            .appendQueryParameter("challenge", challenge)
            .build()
        CustomTabsIntent.Builder().build().launchUrl(context, url)
        return Pending(verifier)
    }

    private fun randomVerifier(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return base64url(bytes)
    }

    /** base64url SHA-256 — must match the Worker's `sha256Base64url`. */
    private fun challengeFor(verifier: String): String =
        base64url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))

    private fun base64url(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}
