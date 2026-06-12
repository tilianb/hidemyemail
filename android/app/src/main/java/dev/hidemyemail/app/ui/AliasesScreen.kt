package dev.hidemyemail.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hidemyemail.app.AppViewModel
import dev.hidemyemail.app.net.Alias
import dev.hidemyemail.app.net.ApiException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AliasesScreen(app: AppViewModel, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var aliases by remember { mutableStateOf<List<Alias>>(emptyList()) }
    var search by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showCreate by remember { mutableStateOf(false) }
    var detail by remember { mutableStateOf<Alias?>(null) }

    suspend fun reload() {
        val client = app.api() ?: return
        loading = true
        try {
            aliases = client.aliases(search)
            error = null
        } catch (e: ApiException) {
            if (e.isAuthFailure) app.handleAuthFailure() else error = e.message
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    LaunchedEffect(search) { reload() }

    val current = detail
    if (current != null) {
        AliasDetailScreen(
            app = app,
            alias = current,
            onBack = { detail = null },
            onChange = { scope.launch { reload() } },
        )
        return
    }

    Box(modifier = modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
            Text(
                "Aliases",
                style = Theme.displayStyle(32.sp, FontWeight.Bold),
                modifier = Modifier.padding(start = 20.dp, top = 16.dp, bottom = 8.dp),
            )

            OutlinedTextField(
                value = search,
                onValueChange = { search = it },
                placeholder = { Text("Search aliases", color = Theme.textMuted) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                shape = RoundedCornerShape(10.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Theme.accent,
                    unfocusedBorderColor = Theme.border,
                    focusedContainerColor = Theme.surface1,
                    unfocusedContainerColor = Theme.surface1,
                ),
            )

            when {
                loading && aliases.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = Theme.accent)
                }
                aliases.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    EmptyState(
                        Icons.Default.AlternateEmail,
                        "No aliases yet",
                        "Tap + to create your first alias.",
                    )
                }
                else -> LazyColumn(modifier = Modifier.fillMaxSize().padding(top = 8.dp)) {
                    items(aliases, key = { it.id }) { alias ->
                        AliasRow(alias = alias, onClick = { detail = alias })
                        RowDivider()
                    }
                }
            }
        }

        FloatingActionButton(
            onClick = { showCreate = true },
            containerColor = Theme.accent,
            contentColor = Color.Black,
            modifier = Modifier.align(Alignment.BottomEnd).padding(20.dp),
        ) {
            Icon(Icons.Default.Add, contentDescription = "New alias")
        }

        error?.let {
            ErrorBanner(it, Modifier.align(Alignment.BottomCenter))
        }
    }

    if (showCreate) {
        ModalBottomSheet(onDismissRequest = { showCreate = false }, containerColor = Theme.surface1) {
            CreateAliasSheet(app = app, onCreated = {
                showCreate = false
                scope.launch { reload() }
            })
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun AliasRow(alias: Alias, onClick: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    val context = androidx.compose.ui.platform.LocalContext.current
    var copied by remember { mutableStateOf(false) }

    LaunchedEffect(copied) {
        if (copied) {
            delay(1200)
            copied = false
        }
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            // Long-press shares the address — Android's counterpart of the iOS
            // row context menu.
            .combinedClickable(
                onClick = onClick,
                onLongClick = {
                    val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(android.content.Intent.EXTRA_TEXT, alias.fullAddress)
                    }
                    context.startActivity(android.content.Intent.createChooser(send, "Share alias"))
                },
            )
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Box(
            Modifier
                .size(8.dp)
                .background(if (alias.isActive) Theme.green else Theme.textMuted, CircleShape)
        )
        Spacer(Modifier.size(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                alias.label ?: alias.fullAddress,
                style = if (alias.label != null) Theme.bodyStyle(16.sp) else Theme.monoStyle(14.sp),
                maxLines = 1,
            )
            if (alias.label != null) {
                Text(
                    alias.fullAddress,
                    style = Theme.monoStyle(12.sp).copy(color = Theme.textSecondary),
                    maxLines = 1,
                )
            }
        }
        // Copy chip — mirrors the iOS capsule button with the brief ✓ state.
        val chipColor = if (copied) Theme.green else Theme.accent
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            modifier = Modifier
                .background(chipColor.copy(alpha = 0.15f), CircleShape)
                .clickable {
                    clipboard.setText(AnnotatedString(alias.fullAddress))
                    copied = true
                }
                .padding(horizontal = 12.dp, vertical = 7.dp),
        ) {
            Icon(
                if (copied) Icons.Default.Check else Icons.Default.ContentCopy,
                contentDescription = "Copy",
                tint = chipColor,
                modifier = Modifier.size(14.dp),
            )
            Text(
                if (copied) "Copied" else "Copy",
                style = Theme.bodyStyle(13.sp, FontWeight.Medium).copy(color = chipColor),
            )
        }
    }
}
