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
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hidemyemail.app.AppViewModel
import kotlinx.coroutines.launch

@Composable
fun MfaScreen(app: AppViewModel) {
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun submit() {
        error = null
        busy = true
        scope.launch {
            try {
                app.completeMfa(code)
            } catch (e: Exception) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize().padding(24.dp)) {
        Row(modifier = Modifier.fillMaxWidth()) {
            TextButton(onClick = { app.signOut() }) { Text("Cancel", color = Theme.accent) }
        }
        Column(
            modifier = Modifier.fillMaxSize().weight(1f),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(Icons.Default.Lock, contentDescription = null, tint = Theme.accent, modifier = Modifier.size(48.dp))
            Spacer(Modifier.height(12.dp))
            Text("Two-Factor Authentication", style = Theme.displayStyle(24.sp, FontWeight.Bold))
            Spacer(Modifier.height(8.dp))
            Text(
                "Enter the 6-digit code from your authenticator app, or an 8-character backup code.",
                style = Theme.bodyStyle(13.sp).copy(color = Theme.textSecondary),
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(20.dp))

            OutlinedTextField(
                value = code,
                onValueChange = { code = it },
                singleLine = true,
                textStyle = Theme.monoStyle(20.sp).copy(textAlign = TextAlign.Center),
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(10.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Theme.accent,
                    unfocusedBorderColor = Theme.borderStrong,
                    focusedContainerColor = Theme.surface1,
                    unfocusedContainerColor = Theme.surface1,
                ),
            )

            error?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, color = Theme.red, fontSize = 13.sp)
            }

            Spacer(Modifier.height(16.dp))
            Button(
                onClick = ::submit,
                enabled = !busy && code.isNotEmpty(),
                modifier = Modifier.fillMaxWidth().height(50.dp),
                shape = RoundedCornerShape(10.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Theme.accent, contentColor = Color.Black),
            ) {
                if (busy) {
                    CircularProgressIndicator(modifier = Modifier.size(22.dp), color = Color.Black, strokeWidth = 2.dp)
                } else {
                    Text("Verify", style = Theme.bodyStyle(16.sp, FontWeight.SemiBold).copy(color = Color.Black))
                }
            }
        }
    }
}
