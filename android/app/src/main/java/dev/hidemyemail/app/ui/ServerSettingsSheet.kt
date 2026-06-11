package dev.hidemyemail.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hidemyemail.app.AppViewModel

/**
 * Lets self-hosters point the app at their own Worker deployment before signing
 * in. The default is the hosted instance at app.hidemyemail.dev.
 */
@Composable
fun ServerSettingsSheet(app: AppViewModel, onDone: () -> Unit) {
    var draft by remember { mutableStateOf(app.serverUrl.value) }

    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Server", style = Theme.displayStyle(22.sp))
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
            label = { Text("Server URL") },
            placeholder = { Text(AppViewModel.DEFAULT_SERVER) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(10.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = Theme.accent,
                unfocusedBorderColor = Theme.borderStrong,
                focusedLabelColor = Theme.accent,
                unfocusedLabelColor = Theme.textSecondary,
            ),
        )
        Text(
            "The origin of your HideMyEmail Worker, including https://.",
            style = Theme.bodyStyle(12.sp).copy(color = Theme.textSecondary),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { draft = AppViewModel.DEFAULT_SERVER }) {
                Text("Reset to default", color = Theme.accent)
            }
        }
        Button(
            onClick = {
                app.setServerUrl(draft.trim())
                onDone()
            },
            enabled = draft.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(10.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Theme.accent, contentColor = Color.Black),
        ) {
            Text("Save")
        }
    }
}
