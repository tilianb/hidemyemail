package dev.hidemyemail.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hidemyemail.app.AppViewModel
import dev.hidemyemail.app.net.Destination
import dev.hidemyemail.app.net.Domain
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

@Composable
fun CreateAliasSheet(app: AppViewModel, onCreated: () -> Unit) {
    val scope = rememberCoroutineScope()
    var domains by remember { mutableStateOf<List<Domain>>(emptyList()) }
    var destinations by remember { mutableStateOf<List<Destination>>(emptyList()) }
    var selectedDomainId by remember { mutableStateOf<Int?>(null) }
    var localPart by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var selectedDestination by remember { mutableStateOf("") }   // "" = use default
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val selectedDomain = domains.firstOrNull { it.id == selectedDomainId }
    // Global domains without custom-alias permission generate a random local
    // part server-side, so we hide the field in that case.
    val localPartRequired = selectedDomain?.let { !it.isGlobalDomain || it.allowsCustomAliases } ?: true
    val verifiedDestinations = destinations.filter { it.isVerified }

    LaunchedEffect(Unit) {
        val client = app.api() ?: return@LaunchedEffect
        loading = true
        try {
            coroutineScope {
                val d = async { client.domains() }
                val dest = async { client.destinations() }
                domains = d.await().filter { it.isUsable }
                destinations = dest.await()
            }
            if (selectedDomainId == null) selectedDomainId = domains.firstOrNull()?.id
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("New Alias", style = Theme.displayStyle(22.sp))

        if (loading) {
            Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Theme.accent)
            }
        } else if (domains.isEmpty()) {
            Text(
                "No domains available. Add and verify a domain in the web dashboard first.",
                style = Theme.bodyStyle(14.sp).copy(color = Theme.textSecondary),
            )
        } else {
            Text("DOMAIN", style = Theme.bodyStyle(11.sp).copy(color = Theme.textSecondary, letterSpacing = 0.8.sp))
            ChoiceChips(
                options = domains.map { it.id to it.domain },
                selected = selectedDomainId,
                onSelect = { selectedDomainId = it },
            )

            if (localPartRequired) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    OutlinedTextField(
                        value = localPart,
                        onValueChange = { localPart = it },
                        label = { Text("local-part") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                        shape = RoundedCornerShape(10.dp),
                        colors = fieldColors(),
                    )
                    Text(
                        "@${selectedDomain?.domain ?: ""}",
                        style = Theme.monoStyle(13.sp).copy(color = Theme.textSecondary),
                        maxLines = 1,
                    )
                }
            } else {
                Text(
                    "A random alias will be generated.",
                    style = Theme.bodyStyle(14.sp).copy(color = Theme.textSecondary),
                )
            }

            OutlinedTextField(
                value = label,
                onValueChange = { label = it },
                label = { Text("Label (optional)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(10.dp),
                colors = fieldColors(),
            )

            Text("FORWARD TO", style = Theme.bodyStyle(11.sp).copy(color = Theme.textSecondary, letterSpacing = 0.8.sp))
            ChoiceChips(
                options = listOf("" to "Default destination") + verifiedDestinations.map { it.email to it.email },
                selected = selectedDestination,
                onSelect = { selectedDestination = it ?: "" },
            )
        }

        error?.let { Text(it, color = Theme.red, fontSize = 13.sp) }

        Button(
            onClick = {
                val domainId = selectedDomainId ?: return@Button
                busy = true
                scope.launch {
                    try {
                        app.api()?.createAlias(
                            domainId = domainId,
                            localPart = if (localPartRequired) localPart.lowercase() else "x",
                            destination = selectedDestination.ifEmpty { null },
                            label = label,
                        )
                        onCreated()
                    } catch (e: Exception) {
                        error = e.message
                    } finally {
                        busy = false
                    }
                }
            },
            enabled = !busy && selectedDomainId != null && (!localPartRequired || localPart.isNotEmpty()),
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(10.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Theme.accent, contentColor = Color.Black),
        ) {
            Text(if (busy) "Creating…" else "Create")
        }
    }
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Theme.accent,
    unfocusedBorderColor = Theme.borderStrong,
    focusedLabelColor = Theme.accent,
    unfocusedLabelColor = Theme.textSecondary,
)

/** Wrapping single-select chip group — Compose's stand-in for the iOS Picker. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun <T> ChoiceChips(options: List<Pair<T, String>>, selected: T?, onSelect: (T?) -> Unit) {
    androidx.compose.foundation.layout.FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        options.forEach { (value, title) ->
            val isSelected = value == selected
            androidx.compose.material3.FilterChip(
                selected = isSelected,
                onClick = { onSelect(value) },
                label = { Text(title, maxLines = 1) },
                colors = androidx.compose.material3.FilterChipDefaults.filterChipColors(
                    selectedContainerColor = Theme.accentDim,
                    selectedLabelColor = Theme.accent,
                    containerColor = Theme.surface2,
                    labelColor = Theme.textSecondary,
                ),
                border = null,
            )
        }
    }
}
