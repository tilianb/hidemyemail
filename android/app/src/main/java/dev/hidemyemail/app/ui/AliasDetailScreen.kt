package dev.hidemyemail.app.ui

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.GppGood
import androidx.compose.material.icons.filled.HelpOutline
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hidemyemail.app.AppViewModel
import dev.hidemyemail.app.net.Alias
import dev.hidemyemail.app.net.ApiException
import dev.hidemyemail.app.net.Block
import dev.hidemyemail.app.net.EmailEvent
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

@Composable
fun AliasDetailScreen(
    app: AppViewModel,
    alias: Alias,
    onBack: () -> Unit,
    onChange: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current

    var isActive by remember { mutableStateOf(alias.isActive) }
    var label by remember { mutableStateOf(alias.label ?: "") }
    var error by remember { mutableStateOf<String?>(null) }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    var blocks by remember { mutableStateOf<List<Block>>(emptyList()) }
    var events by remember { mutableStateOf<List<EmailEvent>>(emptyList()) }
    var loadingEvents by remember { mutableStateOf(false) }

    fun handle(e: Exception) {
        if (e is ApiException && e.isAuthFailure) app.handleAuthFailure() else error = e.message
    }

    // Rules that apply to this alias, in the Worker's resolution order:
    // alias-specific, then its subdomain, then account-wide.
    val scopedBlocks = blocks.filter { b ->
        b.aliasId == alias.id ||
            (b.domainId != null && b.domainId == alias.domainId) ||
            (b.aliasId == null && b.domainId == null)
    }

    LaunchedEffect(alias.id) {
        loadingEvents = true
        try {
            events = app.api()?.events(alias.id) ?: emptyList()
        } catch (e: Exception) {
            handle(e)
        } finally {
            loadingEvents = false
        }
    }
    LaunchedEffect(alias.id) {
        try {
            blocks = app.api()?.blocks() ?: emptyList()
        } catch (e: Exception) {
            handle(e)
        }
    }

    fun saveLabelIfChanged() {
        if (label != (alias.label ?: "")) {
            scope.launch {
                try {
                    app.api()?.updateAliasLabel(alias.id, label.ifEmpty { null })
                    onChange()
                } catch (e: Exception) {
                    if (e is ApiException) handle(e)
                }
            }
        }
    }

    fun goBack() {
        // Persist a pending label edit when the user navigates back, like iOS.
        saveLabelIfChanged()
        onBack()
    }

    BackHandler(onBack = ::goBack)

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            // Inline top bar matching the iOS pushed-detail chrome.
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(4.dp)) {
                IconButton(onClick = ::goBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = Theme.accent)
                }
                Text(
                    alias.label ?: alias.localPart,
                    style = Theme.displayStyle(17.sp),
                    maxLines = 1,
                    modifier = Modifier.weight(1f),
                )
            }

            SectionHeader("Address")
            SectionCard {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                ) {
                    Text(alias.fullAddress, style = Theme.monoStyle(15.sp), modifier = Modifier.weight(1f))
                    IconButton(onClick = { clipboard.setText(AnnotatedString(alias.fullAddress)) }) {
                        Icon(Icons.Default.ContentCopy, contentDescription = "Copy", tint = Theme.accent, modifier = Modifier.size(18.dp))
                    }
                    IconButton(onClick = {
                        val send = Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_TEXT, alias.fullAddress)
                        }
                        context.startActivity(Intent.createChooser(send, "Share alias"))
                    }) {
                        Icon(Icons.Default.Share, contentDescription = "Share", tint = Theme.accent, modifier = Modifier.size(18.dp))
                    }
                }
            }
            alias.destination?.let { SectionFooter("Forwards to $it") }

            SectionHeader("Settings")
            SectionCard {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                ) {
                    Text("Active", style = Theme.bodyStyle(16.sp), modifier = Modifier.weight(1f))
                    Switch(
                        checked = isActive,
                        onCheckedChange = { value ->
                            isActive = value
                            scope.launch {
                                try {
                                    app.api()?.setAliasActive(alias.id, value)
                                    onChange()
                                } catch (e: Exception) {
                                    isActive = !value
                                    if (e is ApiException) handle(e)
                                }
                            }
                        },
                        colors = SwitchDefaults.colors(
                            checkedTrackColor = Theme.accent,
                            checkedThumbColor = Color.Black,
                        ),
                    )
                }
                RowDivider()
                OutlinedTextField(
                    value = label,
                    onValueChange = { label = it },
                    label = { Text("Label") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                    shape = RoundedCornerShape(8.dp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = Theme.accent,
                        unfocusedBorderColor = Theme.border,
                        focusedLabelColor = Theme.accent,
                        unfocusedLabelColor = Theme.textSecondary,
                    ),
                )
            }

            SectionHeader("Activity")
            SectionCard {
                StatRow("Forwarded", alias.fwdCount, Theme.green)
                RowDivider()
                StatRow("Replied", alias.replyCount, Theme.accent)
                RowDivider()
                StatRow("Blocked", alias.blockedCount, Theme.red)
            }

            SectionHeader("Recent Mail")
            SectionCard {
                when {
                    loadingEvents && events.isEmpty() -> Box(
                        Modifier.fillMaxWidth().padding(16.dp),
                        contentAlignment = Alignment.Center,
                    ) { CircularProgressIndicator(color = Theme.accent, modifier = Modifier.size(22.dp)) }
                    events.isEmpty() -> Text(
                        "No mail yet.",
                        style = Theme.bodyStyle(14.sp).copy(color = Theme.textSecondary),
                        modifier = Modifier.padding(16.dp),
                    )
                    else -> events.take(20).forEachIndexed { i, e ->
                        if (i > 0) RowDivider()
                        EventRow(e)
                    }
                }
            }

            SectionHeader("Allow & Block Rules")
            SectionCard {
                if (scopedBlocks.isEmpty()) {
                    Text(
                        "No allow or block rules apply.",
                        style = Theme.bodyStyle(14.sp).copy(color = Theme.textSecondary),
                        modifier = Modifier.padding(16.dp),
                    )
                } else {
                    scopedBlocks.forEachIndexed { i, b ->
                        if (i > 0) RowDivider()
                        RuleRow(
                            block = b,
                            scope = when {
                                b.aliasId == alias.id -> "This alias"
                                b.domainId != null -> "Subdomain rule"
                                else -> "Account-wide"
                            },
                        )
                    }
                }
            }
            SectionFooter("Rules from this alias, its subdomain, and account-wide settings. Manage them in the Rules tab.")

            SectionCard(Modifier.padding(top = 20.dp)) {
                TextButton(onClick = { showDeleteConfirm = true }, modifier = Modifier.fillMaxWidth()) {
                    Text("Delete Alias", color = Theme.red)
                }
            }
            Spacer(Modifier.size(32.dp))
        }

        error?.let { ErrorBanner(it, Modifier.align(Alignment.BottomCenter)) }
    }

    if (showDeleteConfirm) {
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            containerColor = Theme.surface2,
            title = { Text("Delete this alias?", style = Theme.displayStyle(18.sp)) },
            text = {
                Text(
                    "Mail sent to ${alias.fullAddress} will be rejected. This cannot be undone.",
                    style = Theme.bodyStyle(14.sp).copy(color = Theme.textSecondary),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showDeleteConfirm = false
                    scope.launch {
                        try {
                            app.api()?.deleteAlias(alias.id)
                            onChange()
                            onBack()
                        } catch (e: Exception) {
                            if (e is ApiException) handle(e)
                        }
                    }
                }) { Text("Delete", color = Theme.red) }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteConfirm = false }) { Text("Cancel", color = Theme.accent) }
            },
        )
    }
}

@Composable
private fun StatRow(title: String, value: Int, color: Color) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Text(title, style = Theme.bodyStyle(16.sp), modifier = Modifier.weight(1f))
        Text("$value", style = Theme.monoStyle(15.sp).copy(color = color))
    }
}

@Composable
fun RuleRow(block: Block, scope: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Icon(
            if (block.isAllow) Icons.Default.GppGood else Icons.Default.Block,
            contentDescription = null,
            tint = if (block.isAllow) Theme.green else Theme.red,
            modifier = Modifier.size(20.dp),
        )
        Column(Modifier.weight(1f)) {
            Text(block.pattern, style = Theme.monoStyle(13.sp), maxLines = 1)
            Text(scope, style = Theme.bodyStyle(11.sp).copy(color = Theme.textSecondary), maxLines = 1)
        }
        val color = if (block.isAllow) Theme.green else Theme.red
        Text(
            if (block.isAllow) "ALLOW" else "BLOCK",
            style = Theme.bodyStyle(10.sp, FontWeight.SemiBold).copy(color = color),
            modifier = Modifier
                .padding(start = 4.dp)
                .background(color.copy(alpha = 0.15f), CircleShape)
                .padding(horizontal = 7.dp, vertical = 3.dp),
        )
    }
}

@Composable
private fun EventRow(e: EmailEvent) {
    val (icon, color) = eventStyle(e.type)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(18.dp))
        Column(Modifier.weight(1f)) {
            Text(
                e.subject ?: e.externalSender ?: e.detail ?: e.type,
                style = Theme.bodyStyle(14.sp),
                maxLines = 1,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (e.subject != null && e.externalSender != null) {
                    Text(e.externalSender, style = Theme.monoStyle(11.sp).copy(color = Theme.textSecondary), maxLines = 1)
                }
                Text(
                    DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
                        .format(Date(e.ts.toLong())),
                    style = Theme.bodyStyle(11.sp).copy(color = Theme.textSecondary),
                )
            }
        }
        Text(
            e.type.uppercase(),
            style = Theme.bodyStyle(9.sp, FontWeight.SemiBold).copy(color = color),
        )
    }
}

private fun eventStyle(type: String): Pair<ImageVector, Color> = when (type) {
    "forward" -> Icons.Default.ArrowForward to Theme.green
    "reply" -> Icons.AutoMirrored.Filled.Reply to Theme.accent
    "block" -> Icons.Default.Block to Theme.red
    "reject" -> Icons.Default.Cancel to Theme.red
    "bounce", "soft_bounce", "error" -> Icons.Default.Warning to Theme.red
    else -> Icons.Default.HelpOutline to Theme.textSecondary
}
