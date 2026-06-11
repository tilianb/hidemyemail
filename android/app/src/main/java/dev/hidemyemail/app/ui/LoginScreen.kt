package dev.hidemyemail.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MailOutline
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hidemyemail.app.AppViewModel
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LoginScreen(app: AppViewModel, serverUrl: String) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var showServerSheet by remember { mutableStateOf(false) }

    fun submit() {
        if (password.isEmpty()) return
        error = null
        busy = true
        scope.launch {
            try {
                app.login(password)
                password = ""
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize().padding(24.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            IconButton(onClick = { showServerSheet = true }) {
                Icon(Icons.Default.Settings, contentDescription = "Server", tint = Theme.accent)
            }
        }

        Column(
            modifier = Modifier.fillMaxSize().weight(1f),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(
                Icons.Default.MailOutline,
                contentDescription = null,
                tint = Theme.accent,
                modifier = Modifier.size(52.dp),
            )
            Spacer(Modifier.height(8.dp))
            Text("HideMyEmail", style = Theme.displayStyle(34.sp, androidx.compose.ui.text.font.FontWeight.Bold))
            Text(serverUrl, style = Theme.monoStyle(12.sp).copy(color = Theme.textSecondary))

            Spacer(Modifier.height(24.dp))

            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("Passphrase") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(10.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Theme.accent,
                    unfocusedBorderColor = Theme.borderStrong,
                    focusedLabelColor = Theme.accent,
                    unfocusedLabelColor = Theme.textSecondary,
                    focusedContainerColor = Theme.surface1,
                    unfocusedContainerColor = Theme.surface1,
                ),
            )

            error?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, color = Theme.red, fontSize = 13.sp, modifier = Modifier.fillMaxWidth())
            }

            Spacer(Modifier.height(12.dp))

            Button(
                onClick = ::submit,
                enabled = !busy && password.isNotEmpty() && app.hasServer,
                modifier = Modifier.fillMaxWidth().height(50.dp),
                shape = RoundedCornerShape(10.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Theme.accent, contentColor = Color.Black),
            ) {
                if (busy) {
                    CircularProgressIndicator(modifier = Modifier.size(22.dp), color = Color.Black, strokeWidth = 2.dp)
                } else {
                    Text("Sign In", style = Theme.bodyStyle(16.sp, androidx.compose.ui.text.font.FontWeight.SemiBold).copy(color = Color.Black))
                }
            }

            Spacer(Modifier.height(10.dp))

            // Passkeys: the WebAuthn ceremony runs in the server's own web login,
            // so it works for ANY host — hosted or self-hosted. The browser hands
            // a one-time code back over the hidemyemail:// deep link.
            OutlinedButton(
                onClick = {
                    error = null
                    app.beginWebLogin(context)
                },
                enabled = !busy && app.hasServer,
                modifier = Modifier.fillMaxWidth().height(50.dp),
                shape = RoundedCornerShape(10.dp),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Theme.accent),
            ) {
                Icon(Icons.Default.Public, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.size(8.dp))
                Text("Sign in on the Web (Passkeys)")
            }

            Spacer(Modifier.height(8.dp))
            Text(
                "Web sign-in supports passkeys on any server.",
                style = Theme.bodyStyle(11.sp).copy(color = Theme.textSecondary),
            )
        }
    }

    if (showServerSheet) {
        ModalBottomSheet(
            onDismissRequest = { showServerSheet = false },
            containerColor = Theme.surface1,
        ) {
            ServerSettingsSheet(app = app, onDone = { showServerSheet = false })
        }
    }
}
