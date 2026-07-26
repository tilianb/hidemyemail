package dev.hidemyemail.app.ui

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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hidemyemail.app.AppViewModel
import dev.hidemyemail.app.net.Alias
import dev.hidemyemail.app.net.ApiException
import dev.hidemyemail.app.net.Block
import dev.hidemyemail.app.net.Domain
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/**
 * Manage sender allow/block rules — the native counterpart of the dashboard's
 * Blocks page and the iOS `BlocksView`. Block rules drop matching senders
 * before forwarding; any allow rule flips its scope into allowlist mode.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RulesScreen(app: AppViewModel, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var blocks by remember { mutableStateOf<List<Block>>(emptyList()) }
    var domains by remember { mutableStateOf<List<Domain>>(emptyList()) }
    var aliases by remember { mutableStateOf<List<Alias>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showCreate by remember { mutableStateOf(false) }

    val accountRules = blocks.filter { it.aliasId == null && it.domainId == null }
    val subdomainRules = blocks.filter { it.domainId != null }
    val aliasRules = blocks.filter { it.aliasId != null }

    fun handle(e: Exception, client: dev.hidemyemail.app.net.ApiClient) {
        if (e is ApiException && e.isAuthFailure) app.handleAuthFailure(client) else error = e.message
    }

    fun scopeText(b: Block): String {
        b.aliasId?.let { id -> return aliases.firstOrNull { it.id == id }?.fullAddress ?: "alias #$id" }
        b.domainId?.let { id -> return domains.firstOrNull { it.id == id }?.domain ?: "subdomain #$id" }
        return "every alias"
    }

    suspend fun reload() {
        val client = app.api() ?: return
        loading = true
        try {
            coroutineScope {
                val b = async { client.blocks() }
                val d = async { client.domains() }
                val a = async { client.aliases() }
                blocks = b.await(); domains = d.await(); aliases = a.await()
            }
            error = null
        } catch (e: Exception) {
            handle(e, client)
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { if (blocks.isEmpty()) reload() }

    Box(modifier = modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            Text(
                "Rules",
                style = Theme.displayStyle(32.sp, FontWeight.Bold),
                modifier = Modifier.padding(start = 20.dp, top = 16.dp, bottom = 8.dp),
            )

            when {
                loading && blocks.isEmpty() -> Box(
                    Modifier.fillMaxWidth().padding(48.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator(color = Theme.accent) }

                blocks.isEmpty() -> EmptyState(
                    Icons.Default.Shield,
                    "No rules yet",
                    "Block senders like *@spam.com, or add allow rules to lock a scope down to known senders.",
                )

                else -> {
                    @Composable
                    fun group(title: String, rules: List<Block>) {
                        if (rules.isEmpty()) return
                        SectionHeader(title)
                        SectionCard {
                            rules.forEachIndexed { i, b ->
                                if (i > 0) RowDivider()
                                DeletableRuleRow(b, scopeText(b)) {
                                    blocks = blocks - b
                                    scope.launch {
                                        val client = app.api() ?: return@launch
                                        try {
                                            client.deleteBlock(b.id)
                                        } catch (e: Exception) {
                                            handle(e, client)
                                        }
                                        reload()
                                    }
                                }
                            }
                        }
                    }
                    group("Account-wide", accountRules)
                    group("Subdomains", subdomainRules)
                    group("Single aliases", aliasRules)
                }
            }
            Spacer(Modifier.size(88.dp))
        }

        FloatingActionButton(
            onClick = { showCreate = true },
            containerColor = Theme.accent,
            contentColor = Color.Black,
            modifier = Modifier.align(Alignment.BottomEnd).padding(20.dp),
        ) {
            Icon(Icons.Default.Add, contentDescription = "New rule")
        }

        error?.let { ErrorBanner(it, Modifier.align(Alignment.BottomCenter)) }
    }

    if (showCreate) {
        ModalBottomSheet(onDismissRequest = { showCreate = false }, containerColor = Theme.surface1) {
            CreateRuleSheet(
                app = app,
                domains = domains.filter { it.isPersonal },
                aliases = aliases,
                onCreated = {
                    showCreate = false
                    scope.launch { reload() }
                },
            )
        }
    }
}

@Composable
private fun DeletableRuleRow(block: Block, scope: String, onDelete: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f)) { RuleRow(block, scope) }
        androidx.compose.material3.IconButton(onClick = onDelete) {
            Icon(
                Icons.Default.Delete,
                contentDescription = "Delete rule",
                tint = Theme.textMuted,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
private fun CreateRuleSheet(
    app: AppViewModel,
    domains: List<Domain>,
    aliases: List<Alias>,
    onCreated: () -> Unit,
) {
    val coScope = rememberCoroutineScope()
    var pattern by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf("block") }
    // Scope encoded as: null = account, "d<id>" = domain, "a<id>" = alias.
    var ruleScope by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("New Rule", style = Theme.displayStyle(22.sp))

        OutlinedTextField(
            value = pattern,
            onValueChange = { pattern = it },
            label = { Text("Sender pattern") },
            placeholder = { Text("*@spam.com or evil@badactor.org", color = Theme.textMuted) },
            singleLine = true,
            textStyle = Theme.monoStyle(14.sp),
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
            "Wildcards match anything: *@spam.com blocks a whole domain.",
            style = Theme.bodyStyle(12.sp).copy(color = Theme.textSecondary),
        )

        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            listOf("block" to "Block", "allow" to "Allow").forEachIndexed { index, (value, title) ->
                SegmentedButton(
                    selected = kind == value,
                    onClick = { kind = value },
                    shape = SegmentedButtonDefaults.itemShape(index = index, count = 2),
                    colors = SegmentedButtonDefaults.colors(
                        activeContainerColor = Theme.accentDim,
                        activeContentColor = Theme.accent,
                        inactiveContainerColor = Theme.surface2,
                        inactiveContentColor = Theme.textSecondary,
                    ),
                ) { Text(title) }
            }
        }

        Text("APPLIES TO", style = Theme.bodyStyle(11.sp).copy(color = Theme.textSecondary, letterSpacing = 0.8.sp))
        ChoiceChips(
            options = listOf<Pair<String?, String>>(null to "Every alias") +
                domains.map { "d${it.id}" as String? to it.domain } +
                aliases.map { "a${it.id}" as String? to it.fullAddress },
            selected = ruleScope,
            onSelect = { ruleScope = it },
        )
        if (kind == "allow") {
            Text(
                "An allow rule switches its scope to allowlist mode: only matching senders are forwarded.",
                style = Theme.bodyStyle(12.sp).copy(color = Theme.textSecondary),
            )
        }

        error?.let { Text(it, color = Theme.red, fontSize = 13.sp) }

        Button(
            onClick = {
                saving = true
                coScope.launch {
                    try {
                        val s = ruleScope
                        app.api()?.createBlock(
                            pattern = pattern.trim(),
                            kind = kind,
                            aliasId = s?.takeIf { it.startsWith("a") }?.drop(1)?.toIntOrNull(),
                            domainId = s?.takeIf { it.startsWith("d") }?.drop(1)?.toIntOrNull(),
                        )
                        onCreated()
                    } catch (e: Exception) {
                        error = e.message
                    } finally {
                        saving = false
                    }
                }
            },
            enabled = pattern.trim().isNotEmpty() && !saving,
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(10.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Theme.accent, contentColor = Color.Black),
        ) {
            Text(if (saving) "Saving…" else "Save")
        }
    }
}
