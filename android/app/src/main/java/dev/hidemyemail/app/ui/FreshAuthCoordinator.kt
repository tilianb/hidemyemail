package dev.hidemyemail.app.ui

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import dev.hidemyemail.app.AppViewModel
import dev.hidemyemail.app.net.ApiClient
import dev.hidemyemail.app.net.ApiException
import dev.hidemyemail.app.net.isValidNativePasskeyChallenge
import dev.hidemyemail.app.net.usesNativePasskeys
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** One Settings-wide, one-shot continuation. It deliberately is not an HTTP interceptor. */
internal class FreshAuthCoordinator {
    private data class Pending(
        val client: ApiClient,
        val retry: suspend () -> Unit,
        val onError: (String?) -> Unit,
    )

    private var pending by mutableStateOf<Pending?>(null)
    private var mfaEnabled by mutableStateOf(false)
    private var authError by mutableStateOf<String?>(null)
    private var busy by mutableStateOf(false)
    val isPending: Boolean get() = pending != null

    fun request(client: ApiClient, retry: suspend () -> Unit, onError: (String?) -> Unit): Boolean {
        if (pending != null) {
            onError("Another security action is awaiting confirmation.")
            return false
        }
        pending = Pending(client, retry, onError)
        authError = null
        onError(null)
        return true
    }

    fun clear() {
        pending = null
        authError = null
    }
    fun updateMfaEnabled(enabled: Boolean) { mfaEnabled = enabled }

    suspend fun passphrase(app: AppViewModel, passphrase: String, code: String?) =
        elevate(app) { it.reauthenticate(passphrase, code) }

    suspend fun passkey(app: AppViewModel, context: Context) = elevate(app) { client ->
        val challenge = client.freshAuthPasskeyChallenge()
        check(isValidNativePasskeyChallenge(app.serverUrl.value, challenge.rpId)) {
            "Server returned an invalid passkey RP ID"
        }
        val credential = CredentialManager.create(context).getCredential(
            context,
            GetCredentialRequest(listOf(GetPublicKeyCredentialOption(challenge.requestOptionsJson))),
        ).credential as? PublicKeyCredential
            ?: error("Credential provider returned an unexpected response")
        client.reauthenticateWithPasskey(credential.authenticationResponseJson, challenge.passkeyToken)
    }

    private suspend fun elevate(app: AppViewModel, authenticate: suspend (ApiClient) -> Unit) {
        val operation = pending ?: return
        if (busy) return
        busy = true
        try {
            if (app.api() !== operation.client) { clear(); return }
            authenticate(operation.client)
            if (pending !== operation || app.api() !== operation.client) { clear(); return }
            clear() // consume before retry: the operation can never request a second elevation
            try { operation.retry() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (e is ApiException.Unauthorized) app.handleAuthFailure(operation.client)
                operation.onError(e.message)
            }
        } catch (e: CancellationException) {
            clear()
            throw e
        } catch (e: Exception) {
            if (e is ApiException.Unauthorized) {
                clear()
                app.handleAuthFailure(operation.client)
            } else {
                // Keep the account-bound operation while this dialog remains
                // visible so a mistyped passphrase or code can be corrected.
                authError = e.message
            }
        } finally {
            busy = false
        }
    }

    @Composable
    fun Host(app: AppViewModel, scope: CoroutineScope) {
        val operation = pending ?: return
        val context = LocalContext.current
        val serverUrl by app.serverUrl.collectAsState()
        DisposableEffect(operation.client) { onDispose { clear() } }
        ReauthDialog(
            mfa = mfaEnabled,
            error = authError,
            busy = busy,
            onDismiss = ::clear,
            onUsePasskey = if (usesNativePasskeys(serverUrl)) {
                { scope.launch { passkey(app, context) } }
            } else null,
        ) { passphrase, code -> scope.launch { passphrase(app, passphrase, code) } }
    }
}
