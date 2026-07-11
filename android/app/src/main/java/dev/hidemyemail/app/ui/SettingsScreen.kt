package dev.hidemyemail.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hidemyemail.app.AppViewModel
import dev.hidemyemail.app.BuildConfig

@Composable
fun SettingsScreen(app: AppViewModel, modifier: Modifier = Modifier) {
    val userName by app.userName.collectAsState()
    val isAdmin by app.isAdmin.collectAsState()
    val serverUrl by app.serverUrl.collectAsState()
    var showSignOut by remember { mutableStateOf(false) }
    var showDestinations by remember { mutableStateOf(false) }

    if (showDestinations) {
        DestinationsScreen(app, onBack = { showDestinations = false }, modifier = modifier)
        return
    }

    Box(modifier = modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            Text(
                "Settings",
                style = Theme.displayStyle(32.sp, FontWeight.Bold),
                modifier = Modifier.padding(start = 20.dp, top = 16.dp, bottom = 8.dp),
            )

            SectionHeader("Account")
            SectionCard {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                ) {
                    Text("Signed in as", style = Theme.bodyStyle(16.sp), modifier = Modifier.weight(1f))
                    Text(
                        userName.ifEmpty { "—" },
                        style = Theme.bodyStyle(15.sp).copy(color = Theme.textSecondary),
                    )
                }
                if (isAdmin) {
                    RowDivider()
                    Text(
                        "Administrator",
                        style = Theme.bodyStyle(14.sp, FontWeight.Medium).copy(color = Theme.accent),
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    )
                }
            }

            SectionHeader("Server")
            SectionCard {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                ) {
                    Text("URL", style = Theme.bodyStyle(16.sp), modifier = Modifier.weight(1f))
                    Text(serverUrl, style = Theme.monoStyle(12.sp).copy(color = Theme.textSecondary), maxLines = 1)
                }
            }

            SectionHeader("Routing")
            SectionCard {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { showDestinations = true }
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                ) {
                    Icon(Icons.Default.Inbox, contentDescription = null, tint = Theme.accent, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.size(12.dp))
                    Text("Destinations", style = Theme.bodyStyle(16.sp), modifier = Modifier.weight(1f))
                    Icon(
                        Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = null,
                        tint = Theme.textMuted,
                    )
                }
            }

            UsernameSection(app)
            NotificationsSection(app)
            InlineActionsSection(app)
            SecuritySection(app)
            ApiKeysSection(app)
            RecoveryCodesSection(app)
            ExportSection(app)

            SectionCard(Modifier.padding(top = 20.dp)) {
                TextButton(onClick = { showSignOut = true }, modifier = Modifier.fillMaxWidth()) {
                    Text("Sign Out", color = Theme.red)
                }
            }

            SectionHeader("About")
            SectionCard {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                ) {
                    Text("Version", style = Theme.bodyStyle(16.sp), modifier = Modifier.weight(1f))
                    Text(
                        "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                        style = Theme.bodyStyle(15.sp).copy(color = Theme.textSecondary),
                    )
                }
            }
            Spacer(Modifier.size(32.dp))
        }
    }

    if (showSignOut) {
        AlertDialog(
            onDismissRequest = { showSignOut = false },
            containerColor = Theme.surface2,
            title = { Text("Sign out?", style = Theme.displayStyle(18.sp)) },
            confirmButton = {
                TextButton(onClick = {
                    showSignOut = false
                    app.signOut()
                }) { Text("Sign Out", color = Theme.red) }
            },
            dismissButton = {
                TextButton(onClick = { showSignOut = false }) { Text("Cancel", color = Theme.accent) }
            },
        )
    }
}
