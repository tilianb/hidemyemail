package dev.hidemyemail.app.ui

import android.content.Intent
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
import androidx.compose.material.icons.filled.IosShare
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hidemyemail.app.AppViewModel
import dev.hidemyemail.app.net.MfaStatus
import dev.hidemyemail.app.net.Passkey
import dev.hidemyemail.app.net.Preferences
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.text.DateFormat
import java.util.Date

/** Account-wide inline-action preferences (GET/PATCH /api/preferences). */
@Composable
fun InlineActionsSection(app: AppViewModel) {
    val scope = rememberCoroutineScope()
    var loaded by remember { mutableStateOf(false) }
    var pref by remember { mutableStateOf("") }       // "" inherit | on | off
    var position by remember { mutableStateOf("") }   // "" inherit | header | footer
    var defaults by remember { mutableStateOf<Preferences.Defaults?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            val p = app.api()?.preferences() ?: return@LaunchedEffect
            pref = p.inlineActionsPref ?: ""
            position = p.inlineActionsPosition ?: ""
            defaults = p.defaults
            loaded = true
        } catch (e: Exception) {
            error = e.message
        }
    }

    fun save(key: String, value: String) {
        scope.launch {
            try {
                app.api()?.updatePreferences(
                    buildJsonObject {
                        put(key, if (value.isEmpty()) JsonNull else JsonPrimitive(value))
                    }
                )
                error = null
            } catch (e: Exception) {
                error = e.message
            }
        }
    }

    SectionHeader("Inline Actions")
    SectionCard {
        Column(Modifier.padding(12.dp)) {
            val inheritOn = defaults?.let { if (it.inlineActionsEnabled) "On" else "Off" }
            Text(
                "ADD BLOCK/DEACTIVATE LINKS TO FORWARDED MAIL",
                style = Theme.bodyStyle(11.sp).copy(color = Theme.textSecondary, letterSpacing = 0.8.sp),
            )
            ChoiceChips(
                options = listOf("" to (inheritOn?.let { "Server default ($it)" } ?: "Server default"), "on" to "On", "off" to "Off"),
                selected = pref,
                onSelect = { if (loaded) { pref = it ?: ""; save("inline_actions_pref", pref) } },
            )
            Spacer(Modifier.size(10.dp))
            Text(
                "POSITION",
                style = Theme.bodyStyle(11.sp).copy(color = Theme.textSecondary, letterSpacing = 0.8.sp),
            )
            val inheritPos = defaults?.inlineActionsPosition?.replaceFirstChar { it.uppercase() }
            ChoiceChips(
                options = listOf("" to (inheritPos?.let { "Server default ($it)" } ?: "Server default"), "header" to "Header", "footer" to "Footer"),
                selected = position,
                onSelect = { if (loaded) { position = it ?: ""; save("inline_actions_position", position) } },
            )
        }
    }
    SectionFooter(error ?: "Subdomains can override this.")
}

/** Read-mostly security overview: TOTP status, passkey list with rename/delete. */
@Composable
fun SecuritySection(app: AppViewModel) {
    val scope = rememberCoroutineScope()
    var mfa by remember { mutableStateOf<MfaStatus?>(null) }
    var passkeys by remember { mutableStateOf<List<Passkey>>(emptyList()) }
    var renaming by remember { mutableStateOf<Passkey?>(null) }
    var renameDraft by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var reloadKey by remember { mutableStateOf(0) }

    LaunchedEffect(reloadKey) {
        try {
            val client = app.api() ?: return@LaunchedEffect
            mfa = client.mfaStatus()
            passkeys = client.passkeys()
        } catch (e: Exception) {
            error = e.message
        }
    }

    SectionHeader("Security")
    SectionCard {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        ) {
            Icon(Icons.Default.Lock, contentDescription = null, tint = Theme.accent, modifier = Modifier.size(18.dp))
            Spacer(Modifier.size(10.dp))
            Text("Two-factor auth", style = Theme.bodyStyle(15.sp), modifier = Modifier.weight(1f))
            val m = mfa
            Text(
                when {
                    m == null -> "—"
                    m.enabled -> "On · ${m.backupCodesRemaining} backup codes"
                    else -> "Off"
                },
                style = Theme.bodyStyle(13.sp).copy(
                    color = if (m?.enabled == true) Theme.green else Theme.textSecondary
                ),
            )
        }
        RowDivider()
        if (passkeys.isEmpty()) {
            Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
                Text("Passkeys", style = Theme.bodyStyle(15.sp), modifier = Modifier.weight(1f))
                Text("None registered", style = Theme.bodyStyle(13.sp).copy(color = Theme.textSecondary))
            }
        } else {
            passkeys.forEachIndexed { i, pk ->
                if (i > 0) RowDivider()
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().padding(start = 16.dp, top = 6.dp, bottom = 6.dp),
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(pk.deviceName ?: "Unnamed passkey", style = Theme.bodyStyle(15.sp))
                        Text(
                            DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(pk.createdAt.toLong())),
                            style = Theme.bodyStyle(11.sp).copy(color = Theme.textSecondary),
                        )
                    }
                    IconButton(onClick = { renameDraft = pk.deviceName ?: ""; renaming = pk }) {
                        Icon(Icons.Default.Edit, contentDescription = "Rename", tint = Theme.textSecondary, modifier = Modifier.size(18.dp))
                    }
                    IconButton(onClick = {
                        scope.launch {
                            try {
                                app.api()?.deletePasskey(pk.id)
                                reloadKey++
                            } catch (e: Exception) {
                                error = e.message
                            }
                        }
                    }) {
                        Icon(Icons.Default.Delete, contentDescription = "Delete", tint = Theme.red, modifier = Modifier.size(18.dp))
                    }
                }
            }
        }
    }
    SectionFooter(error ?: "Set up two-factor auth and register new passkeys in the web dashboard.")

    renaming?.let { pk ->
        AlertDialog(
            onDismissRequest = { renaming = null },
            containerColor = Theme.surface2,
            title = { Text("Rename Passkey", style = Theme.displayStyle(18.sp)) },
            text = {
                OutlinedTextField(value = renameDraft, onValueChange = { renameDraft = it }, singleLine = true)
            },
            confirmButton = {
                TextButton(onClick = {
                    val name = renameDraft.trim()
                    renaming = null
                    if (name.isNotEmpty()) {
                        scope.launch {
                            try {
                                app.api()?.renamePasskey(pk.id, name)
                                reloadKey++
                            } catch (e: Exception) {
                                error = e.message
                            }
                        }
                    }
                }) { Text("Save", color = Theme.accent) }
            },
            dismissButton = {
                TextButton(onClick = { renaming = null }) { Text("Cancel", color = Theme.accent) }
            },
        )
    }
}

/** Account export (GET /api/export) → system share sheet. */
@Composable
fun ExportSection(app: AppViewModel) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    SectionHeader("Data")
    SectionCard {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clickable(enabled = !busy) {
                    busy = true
                    scope.launch {
                        try {
                            val json = app.api()?.exportData() ?: return@launch
                            val send = Intent(Intent.ACTION_SEND).apply {
                                type = "application/json"
                                putExtra(Intent.EXTRA_SUBJECT, "HideMyEmail export")
                                putExtra(Intent.EXTRA_TEXT, json)
                            }
                            context.startActivity(Intent.createChooser(send, "Export account data"))
                            error = null
                        } catch (e: Exception) {
                            error = e.message
                        } finally {
                            busy = false
                        }
                    }
                }
                .padding(horizontal = 16.dp, vertical = 12.dp),
        ) {
            Icon(Icons.Default.IosShare, contentDescription = null, tint = Theme.accent, modifier = Modifier.size(18.dp))
            Spacer(Modifier.size(10.dp))
            Text(
                if (busy) "Exporting…" else "Export Account Data",
                style = Theme.bodyStyle(15.sp),
                modifier = Modifier.weight(1f),
            )
            if (busy) {
                CircularProgressIndicator(color = Theme.accent, modifier = Modifier.size(16.dp))
            }
        }
    }
    SectionFooter(error ?: "Aliases, domains, destinations, and rules as JSON. Requires a recent sign-in.")
}
