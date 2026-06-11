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
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hidemyemail.app.AppViewModel
import dev.hidemyemail.app.net.ApiException
import dev.hidemyemail.app.net.Destination
import dev.hidemyemail.app.net.Domain
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/**
 * Manage personal subdomains (`name.<base global domain>`). Mirrors the iOS
 * `SubdomainsView` / the create-list-delete subset of the web dashboard.
 */
@Composable
fun DomainsScreen(app: AppViewModel, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var domains by remember { mutableStateOf<List<Domain>>(emptyList()) }
    var destinations by remember { mutableStateOf<List<Destination>>(emptyList()) }
    var maxSubdomains by remember { mutableStateOf(-1) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    var prefix by remember { mutableStateOf("") }
    var baseDomainId by remember { mutableStateOf<Int?>(null) }
    var selectedDestination by remember { mutableStateOf("global") }
    var creating by remember { mutableStateOf(false) }
    var pendingDelete by remember { mutableStateOf<Domain?>(null) }

    val baseDomains = domains.filter { it.canHostSubdomains }
    val personalSubdomains = domains.filter { it.isPersonal }
    val verifiedDestinations = destinations.filter { it.isVerified }
    val selectedBaseDomain = domains.firstOrNull { it.id == baseDomainId } ?: baseDomains.firstOrNull()
    val canCreate = !creating && prefix.isNotEmpty() && selectedBaseDomain != null && verifiedDestinations.isNotEmpty()
    val quotaLabel = if (maxSubdomains >= 0) "${personalSubdomains.size} / $maxSubdomains used"
    else "${personalSubdomains.size} used"

    fun handle(e: Exception) {
        if (e is ApiException && e.isAuthFailure) app.handleAuthFailure() else error = e.message
    }

    suspend fun reload() {
        val client = app.api() ?: return
        loading = true
        try {
            coroutineScope {
                val d = async { client.domains() }
                val dest = async { client.destinations() }
                val conf = async { client.config() }
                domains = d.await()
                destinations = dest.await()
                maxSubdomains = conf.await().maxSubdomains
            }
            val bases = domains.filter { it.canHostSubdomains }
            if (baseDomainId == null || bases.none { it.id == baseDomainId }) {
                baseDomainId = bases.firstOrNull()?.id
            }
            error = null
        } catch (e: Exception) {
            handle(e)
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { if (domains.isEmpty()) reload() }

    Box(modifier = modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            Text(
                "Domains",
                style = Theme.displayStyle(32.sp, FontWeight.Bold),
                modifier = Modifier.padding(start = 20.dp, top = 16.dp, bottom = 8.dp),
            )

            SectionHeader("Add Subdomain ($quotaLabel)")
            SectionCard {
                when {
                    loading && domains.isEmpty() -> Box(
                        Modifier.fillMaxWidth().padding(16.dp),
                        contentAlignment = Alignment.Center,
                    ) { CircularProgressIndicator(color = Theme.accent, modifier = Modifier.size(22.dp)) }

                    baseDomains.isEmpty() -> Text(
                        "No global domains currently allow subdomain aliases.",
                        style = Theme.bodyStyle(13.sp).copy(color = Theme.textSecondary),
                        modifier = Modifier.padding(16.dp),
                    )

                    verifiedDestinations.isEmpty() -> Text(
                        "Verify a destination email first.",
                        style = Theme.bodyStyle(13.sp).copy(color = Theme.textSecondary),
                        modifier = Modifier.padding(16.dp),
                    )

                    else -> Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            OutlinedTextField(
                                value = prefix,
                                onValueChange = { value ->
                                    prefix = value.lowercase().filter { it.isLetterOrDigit() || it == '-' }
                                },
                                label = { Text("name") },
                                singleLine = true,
                                modifier = Modifier.weight(1f),
                                shape = RoundedCornerShape(8.dp),
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = Theme.accent,
                                    unfocusedBorderColor = Theme.border,
                                    focusedLabelColor = Theme.accent,
                                    unfocusedLabelColor = Theme.textSecondary,
                                ),
                            )
                            Text(
                                ".${selectedBaseDomain?.domain ?: ""}",
                                style = Theme.monoStyle(13.sp).copy(color = Theme.textSecondary),
                                maxLines = 1,
                            )
                        }

                        if (baseDomains.size > 1) {
                            Text("BASE DOMAIN", style = Theme.bodyStyle(11.sp).copy(color = Theme.textSecondary, letterSpacing = 0.8.sp))
                            ChoiceChips(
                                options = baseDomains.map { it.id to it.domain },
                                selected = baseDomainId ?: baseDomains.firstOrNull()?.id,
                                onSelect = { baseDomainId = it },
                            )
                        }

                        Text("DEFAULT DESTINATION", style = Theme.bodyStyle(11.sp).copy(color = Theme.textSecondary, letterSpacing = 0.8.sp))
                        ChoiceChips(
                            options = listOf("global" to "Global default") + verifiedDestinations.map { it.email to it.email },
                            selected = selectedDestination,
                            onSelect = { selectedDestination = it ?: "global" },
                        )

                        Button(
                            onClick = {
                                val base = selectedBaseDomain ?: return@Button
                                creating = true
                                scope.launch {
                                    try {
                                        app.api()?.createDomain(prefix, selectedDestination, base.id)
                                        prefix = ""
                                        selectedDestination = "global"
                                        reload()
                                    } catch (e: Exception) {
                                        handle(e)
                                    } finally {
                                        creating = false
                                    }
                                }
                            },
                            enabled = canCreate,
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(8.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = Theme.accent, contentColor = Color.Black),
                        ) {
                            Text(if (creating) "Adding…" else "Add Subdomain")
                        }
                    }
                }
            }

            SectionHeader("Your Subdomains")
            SectionCard {
                if (personalSubdomains.isEmpty()) {
                    Text(
                        if (loading) "Loading…" else "No subdomains yet.",
                        style = Theme.bodyStyle(14.sp).copy(color = Theme.textSecondary),
                        modifier = Modifier.padding(16.dp),
                    )
                } else {
                    personalSubdomains.forEachIndexed { i, d ->
                        if (i > 0) RowDivider()
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth().padding(start = 16.dp, top = 6.dp, bottom = 6.dp),
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(d.domain, style = Theme.monoStyle(14.sp))
                                Text(
                                    when (d.defaultDestination) {
                                        null -> "Drops mail (no destination)"
                                        "global" -> "Global default"
                                        else -> "→ ${d.defaultDestination}"
                                    },
                                    style = Theme.bodyStyle(11.sp).copy(color = Theme.textSecondary),
                                )
                            }
                            IconButton(onClick = { pendingDelete = d }) {
                                Icon(Icons.Default.Delete, contentDescription = "Delete", tint = Theme.red, modifier = Modifier.size(18.dp))
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.size(32.dp))
        }

        error?.let { ErrorBanner(it, Modifier.align(Alignment.BottomCenter)) }
    }

    pendingDelete?.let { d ->
        AlertDialog(
            onDismissRequest = { pendingDelete = null },
            containerColor = Theme.surface2,
            title = { Text("Delete ${d.domain} and all its aliases?", style = Theme.displayStyle(18.sp)) },
            confirmButton = {
                TextButton(onClick = {
                    pendingDelete = null
                    scope.launch {
                        try {
                            app.api()?.deleteDomain(d.id)
                            reload()
                        } catch (e: Exception) {
                            handle(e)
                        }
                    }
                }) { Text("Delete", color = Theme.red) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDelete = null }) { Text("Cancel", color = Theme.accent) }
            },
        )
    }
}
