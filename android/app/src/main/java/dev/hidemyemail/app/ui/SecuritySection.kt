package dev.hidemyemail.app.ui

import android.graphics.Bitmap
import android.os.Build
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import com.google.zxing.common.BitMatrix
import dev.hidemyemail.app.AppViewModel
import dev.hidemyemail.app.net.ApiException
import dev.hidemyemail.app.net.ApiClient
import dev.hidemyemail.app.net.MfaSetup
import dev.hidemyemail.app.net.MfaStatus
import dev.hidemyemail.app.net.Passkey
import dev.hidemyemail.app.net.isSafeSecurityHandoff
import dev.hidemyemail.app.net.isValidNativePasskeyChallenge
import dev.hidemyemail.app.net.usesNativePasskeys
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException
import java.text.DateFormat
import java.util.Date

internal fun shouldRequestReauthentication(error: Throwable, retryAvailable: Boolean) =
    retryAvailable && error is ApiException.Server && error.message == "Fresh authentication required"

internal class SecurityOperationGate {
    private var running = false
    @Synchronized fun tryAcquire(): Boolean = if (running) false else true.also { running = true }
    @Synchronized fun release() { running = false }
}

internal fun isCurrentPendingRetry(current: (() -> Unit)?, captured: () -> Unit) = current === captured

internal fun reauthenticationContinuation(
    retry: () -> Unit,
    replacement: (() -> Unit)?,
) = replacement ?: retry

internal fun securityErrorMessage(error: Exception, onUnauthorized: () -> Unit): String? {
    if (error is ApiException.Unauthorized) {
        onUnauthorized()
        return null
    }
    return error.message
}

@Composable
fun SecuritySection(app: AppViewModel) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var mfa by remember { mutableStateOf<MfaStatus?>(null) }
    var passkeys by remember { mutableStateOf<List<Passkey>>(emptyList()) }
    var setup by remember { mutableStateOf<MfaSetup?>(null) }
    var codes by remember { mutableStateOf<List<String>>(emptyList()) }
    var codePurpose by remember { mutableStateOf<String?>(null) }
    var code by remember { mutableStateOf("") }
    var renaming by remember { mutableStateOf<Passkey?>(null) }
    var deleting by remember { mutableStateOf<Passkey?>(null) }
    var renameDraft by remember { mutableStateOf("") }
    var deviceName by remember { mutableStateOf(Build.MODEL ?: "Android device") }
    var namingPasskey by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableStateOf(0) }
    var pending by remember { mutableStateOf<(() -> Unit)?>(null) }
    var busy by remember { mutableStateOf(false) }
    val operationGate = remember { SecurityOperationGate() }

    fun clearSecrets() {
        setup = null
        codes = emptyList()
        code = ""
        codePurpose = null
    }

    fun operation(action: suspend (ApiClient) -> Unit) {
        scope.launch {
            if (!operationGate.tryAcquire()) return@launch
            busy = true
            val client = app.api()
            try {
                if (client != null) action(client)
                error = null
            } catch (e: CancellationException) {
                clearSecrets()
                pending = null
                throw e
            } catch (e: Exception) {
                error = securityErrorMessage(e) { client?.let(app::handleAuthFailure) }
            } finally {
                busy = false
                operationGate.release()
            }
        }
    }

    fun sensitive(
        mayReauthenticate: Boolean = true,
        afterReauthentication: (() -> Unit)? = null,
        action: suspend (ApiClient) -> Unit,
    ) {
        scope.launch {
            if (!operationGate.tryAcquire()) return@launch
            busy = true
            val client = app.api()
            try {
                if (client != null) action(client)
                error = null
            } catch (e: CancellationException) {
                clearSecrets(); pending = null; throw e
            } catch (e: Exception) {
                if (shouldRequestReauthentication(e, mayReauthenticate)) {
                    pending = reauthenticationContinuation(
                        retry = { sensitive(mayReauthenticate = false, action = action) },
                        replacement = afterReauthentication,
                    )
                } else error = securityErrorMessage(e) { client?.let(app::handleAuthFailure) }
            } finally {
                busy = false
                operationGate.release()
            }
        }
    }

    LaunchedEffect(reload) {
        val client = app.api() ?: return@LaunchedEffect
        try {
            mfa = client.mfaStatus()
            passkeys = client.passkeys()
        } catch (e: CancellationException) {
            clearSecrets(); pending = null; throw e
        } catch (e: Exception) { error = securityErrorMessage(e) { app.handleAuthFailure(client) } }
    }

    SectionHeader("Security")
    SectionCard {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().clickable(enabled = !busy) {
                if (mfa?.enabled == true) codePurpose = "Manage backup codes" else sensitive {
                    setup = it.setupMfa()
                }
            }.padding(horizontal = 16.dp, vertical = 12.dp),
        ) {
            Icon(Icons.Default.Lock, "Two-factor authentication", tint = Theme.accent, modifier = Modifier.size(18.dp))
            Spacer(Modifier.size(10.dp))
            Text("Two-factor auth", style = Theme.bodyStyle(15.sp), modifier = Modifier.weight(1f))
            Text(
                if (mfa?.enabled == true) "On · ${mfa?.backupCodesRemaining} codes" else "Set up",
                style = Theme.bodyStyle(13.sp).copy(color = if (mfa?.enabled == true) Theme.green else Theme.accent),
            )
        }
        if (mfa?.enabled == true) {
            RowDivider()
            Text(
                "Disable two-factor authentication",
                color = Theme.red,
                style = Theme.bodyStyle(14.sp),
                modifier = Modifier.fillMaxWidth().clickable(enabled = !busy) { codePurpose = "Disable two-factor auth" }
                    .padding(horizontal = 16.dp, vertical = 12.dp),
            )
        }
        RowDivider()
        Text(
            "Add Passkey",
            color = Theme.accent,
            style = Theme.bodyStyle(15.sp),
            modifier = Modifier.fillMaxWidth().clickable(enabled = !busy) { namingPasskey = true }
                .padding(horizontal = 16.dp, vertical = 12.dp),
        )
        passkeys.forEach { pk ->
            RowDivider()
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(start = 16.dp, top = 5.dp, bottom = 5.dp),
            ) {
                Column(Modifier.weight(1f)) {
                    Text(pk.deviceName ?: "Unnamed passkey", style = Theme.bodyStyle(15.sp))
                    Text(
                        DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(pk.createdAt.toLong())),
                        style = Theme.bodyStyle(11.sp).copy(color = Theme.textSecondary),
                    )
                }
                IconButton(enabled = !busy, onClick = { renameDraft = pk.deviceName.orEmpty(); renaming = pk }) {
                    Icon(Icons.Default.Edit, "Rename ${pk.deviceName ?: "passkey"}", tint = Theme.textSecondary)
                }
                IconButton(enabled = !busy, onClick = { deleting = pk }) {
                    Icon(Icons.Default.Delete, "Delete ${pk.deviceName ?: "passkey"}", tint = Theme.red)
                }
            }
        }
    }
    SectionFooter(error ?: "Protect your account with an authenticator app and device-bound passkeys.")

    setup?.let { value -> MfaSetupDialog(value, onDismiss = ::clearSecrets) { entered ->
        operation { client ->
                codes = client.verifyMfa(entered).backupCodes
                setup = null
                reload++
        }
    } }
    if (codes.isNotEmpty()) BackupCodesDialog(codes, onDismiss = ::clearSecrets)
    codePurpose?.let { purpose ->
        val regenerating = !purpose.startsWith("Disable")
        CodeDialog(purpose, code, { code = it }, regenerating, onDismiss = ::clearSecrets) {
        val entered = code
        clearSecrets()
        val afterReauthentication = if (regenerating) null else {
            { codePurpose = "Disable two-factor auth" }
        }
        sensitive(afterReauthentication = afterReauthentication) { client ->
            if (!regenerating) client.disableMfa(entered)
            else codes = client.regenerateMfaBackupCodes(entered).backupCodes
            reload++
        }
    } }
    pending?.let { retry -> ReauthDialog(mfa?.enabled == true, error, onDismiss = { pending = null }) { passphrase, mfaCode ->
        scope.launch {
            if (!operationGate.tryAcquire()) return@launch
            busy = true
            val client = app.api()
            var succeeded = false
            try {
                if (client != null) client.reauthenticate(passphrase, mfaCode)
                if (client != null && isCurrentPendingRetry(pending, retry)) {
                    pending = null
                    error = null
                    succeeded = true
                }
            } catch (e: CancellationException) {
                clearSecrets(); pending = null; throw e
            } catch (e: Exception) {
                error = securityErrorMessage(e) { client?.let(app::handleAuthFailure) }
            } finally {
                busy = false
                operationGate.release()
            }
            if (succeeded) retry()
        }
    } }
    renaming?.let { pk -> NameDialog("Rename Passkey", renameDraft, { renameDraft = it }, { renaming = null }) {
        val name = renameDraft.trim(); renaming = null
        if (name.isNotEmpty()) operation { client -> client.renamePasskey(pk.id, name); reload++ }
    } }
    deleting?.let { pk -> ConfirmDelete(pk.deviceName ?: "this passkey", { deleting = null }) {
        deleting = null
        sensitive { client -> client.deletePasskey(pk.id); reload++ }
    } }
    if (namingPasskey) NameDialog("Add Passkey", deviceName, { deviceName = it }, { namingPasskey = false }) {
        namingPasskey = false
        sensitive { client ->
            if (usesNativePasskeys(app.serverUrl.value)) {
                val challenge = client.passkeyChallenge()
                check(isValidNativePasskeyChallenge(app.serverUrl.value, challenge.rpId)) {
                    "Server returned an invalid passkey RP ID"
                }
                val manager = CredentialManager.create(context)
                val response = manager.createCredential(
                    context,
                    CreatePublicKeyCredentialRequest(challenge.creationOptionsJson),
                ) as? CreatePublicKeyCredentialResponse ?: error("Credential provider returned an unexpected response")
                client.registerPasskey(response.registrationResponseJson, deviceName, challenge.challengeToken)
                reload++
            } else {
                val url = client.securityHandoff().url
                check(isSafeSecurityHandoff(app.serverUrl.value, url)) { "Server returned an unsafe security URL" }
                CustomTabsIntent.Builder().build().launchUrl(context, android.net.Uri.parse(url))
            }
        }
    }
}

@Composable
private fun MfaSetupDialog(setup: MfaSetup, onDismiss: () -> Unit, onVerify: (String) -> Unit) {
    val clipboard = LocalClipboardManager.current
    var code by remember { mutableStateOf("") }
    val qr = remember(setup.uri) { qrBitmap(setup.uri).asImageBitmap() }
    AlertDialog(onDismissRequest = onDismiss, containerColor = Theme.surface2,
        title = { Text("Set up two-factor auth", style = Theme.displayStyle(18.sp)) },
        text = { Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Image(qr, "QR code for authenticator setup", Modifier.size(190.dp))
            Text(setup.secret, style = Theme.monoStyle(13.sp), modifier = Modifier.padding(top = 10.dp))
            TextButton(onClick = { clipboard.setText(AnnotatedString(setup.secret)) }) { Text("Copy manual key") }
            OutlinedTextField(code, { code = it.filter(Char::isDigit).take(6) }, label = { Text("6-digit code") }, singleLine = true)
        } },
        confirmButton = { TextButton(enabled = code.length == 6, onClick = { onVerify(code); code = "" }) { Text("Verify") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

@Composable
private fun BackupCodesDialog(codes: List<String>, onDismiss: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    AlertDialog(onDismissRequest = onDismiss, containerColor = Theme.surface2,
        title = { Text("Save backup codes", style = Theme.displayStyle(18.sp)) },
        text = { Column { Text("These codes are shown once. Store them somewhere safe.", style = Theme.bodyStyle(14.sp)); codes.forEach { Text(it, style = Theme.monoStyle(14.sp), modifier = Modifier.padding(top = 5.dp)) } } },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
        dismissButton = { TextButton(onClick = { clipboard.setText(AnnotatedString(codes.joinToString("\n"))) }) { Text("Copy codes") } })
}

@Composable
private fun ReauthDialog(mfa: Boolean, error: String?, onDismiss: () -> Unit, onSubmit: (String, String?) -> Unit) {
    var passphrase by remember { mutableStateOf("") }; var code by remember { mutableStateOf("") }
    AlertDialog(onDismissRequest = { passphrase = ""; code = ""; onDismiss() }, containerColor = Theme.surface2,
        title = { Text("Confirm it's you", style = Theme.displayStyle(18.sp)) },
        text = { Column { OutlinedTextField(passphrase, { passphrase = it }, label = { Text("Passphrase") }, visualTransformation = PasswordVisualTransformation(), singleLine = true); if (mfa) OutlinedTextField(code, { code = it.take(64) }, label = { Text("Authenticator or backup code") }, singleLine = true, modifier = Modifier.padding(top = 8.dp)); error?.let { Text(it, color = Theme.red, style = Theme.bodyStyle(13.sp), modifier = Modifier.padding(top = 8.dp)) } } },
        confirmButton = { TextButton(enabled = passphrase.isNotEmpty() && (!mfa || code.isNotBlank()), onClick = { val p = passphrase; val c = code.takeIf { it.isNotBlank() }; passphrase = ""; code = ""; onSubmit(p, c) }) { Text("Continue") } },
        dismissButton = { TextButton(onClick = { passphrase = ""; code = ""; onDismiss() }) { Text("Cancel") } })
}

@Composable private fun CodeDialog(title: String, value: String, onValue: (String) -> Unit, totpOnly: Boolean, onDismiss: () -> Unit, onSubmit: () -> Unit) =
    AlertDialog(onDismissRequest = onDismiss, containerColor = Theme.surface2, title = { Text(title, style = Theme.displayStyle(18.sp)) }, text = { OutlinedTextField(value, { onValue(if (totpOnly) it.filter(Char::isDigit).take(6) else it.take(64)) }, label = { Text(if (totpOnly) "6-digit authenticator code" else "Authenticator or backup code") }, singleLine = true) }, confirmButton = { TextButton(enabled = if (totpOnly) value.length == 6 else value.isNotBlank(), onClick = onSubmit) { Text("Continue") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })

@Composable private fun NameDialog(title: String, value: String, onValue: (String) -> Unit, onDismiss: () -> Unit, onSubmit: () -> Unit) =
    AlertDialog(onDismissRequest = onDismiss, containerColor = Theme.surface2, title = { Text(title, style = Theme.displayStyle(18.sp)) }, text = { OutlinedTextField(value, onValue, label = { Text("Device name (optional)") }, singleLine = true) }, confirmButton = { TextButton(onClick = onSubmit) { Text("Continue") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })

@Composable private fun ConfirmDelete(name: String, onDismiss: () -> Unit, onConfirm: () -> Unit) =
    AlertDialog(onDismissRequest = onDismiss, containerColor = Theme.surface2, title = { Text("Delete Passkey", style = Theme.displayStyle(18.sp)) }, text = { Text("Delete $name? This cannot be undone.") }, confirmButton = { TextButton(onClick = onConfirm) { Text("Delete", color = Theme.red) } }, dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })

private fun qrBitmap(value: String): Bitmap {
    val matrix: BitMatrix = MultiFormatWriter().encode(value, BarcodeFormat.QR_CODE, 512, 512)
    val pixels = IntArray(512 * 512) { i -> if (matrix[i % 512, i / 512]) android.graphics.Color.BLACK else android.graphics.Color.WHITE }
    return Bitmap.createBitmap(pixels, 512, 512, Bitmap.Config.RGB_565)
}
