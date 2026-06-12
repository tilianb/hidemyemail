package dev.hidemyemail.app.ui

import androidx.activity.compose.BackHandler
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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FloatingActionButton
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
import kotlinx.coroutines.launch

@Composable
fun DestinationsScreen(app: AppViewModel, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var destinations by remember { mutableStateOf<List<Destination>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showAdd by remember { mutableStateOf(false) }
    var newEmail by remember { mutableStateOf("") }

    fun handle(e: Exception) {
        if (e is ApiException && e.isAuthFailure) app.handleAuthFailure() else error = e.message
    }

    suspend fun reload() {
        val client = app.api() ?: return
        loading = true
        try {
            destinations = client.destinations()
            error = null
        } catch (e: Exception) {
            handle(e)
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { if (destinations.isEmpty()) reload() }
    BackHandler(onBack = onBack)

    Box(modifier = modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(4.dp)) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = Theme.accent)
                }
                Text("Destinations", style = Theme.displayStyle(17.sp))
            }

            when {
                loading && destinations.isEmpty() -> Box(
                    Modifier.fillMaxWidth().padding(48.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator(color = Theme.accent) }

                destinations.isEmpty() -> EmptyState(
                    Icons.Default.Inbox,
                    "No destinations",
                    "Add an inbox to forward your aliases to.",
                )

                else -> SectionCard(Modifier.padding(top = 8.dp)) {
                    destinations.forEachIndexed { i, dest ->
                        if (i > 0) RowDivider()
                        DestinationRow(
                            dest = dest,
                            onMakeDefault = {
                                scope.launch {
                                    try {
                                        app.api()?.setDefaultDestination(dest.id)
                                        reload()
                                    } catch (e: Exception) { handle(e) }
                                }
                            },
                            onResume = {
                                scope.launch {
                                    try {
                                        app.api()?.unsuppressDestination(dest.id)
                                        reload()
                                    } catch (e: Exception) { handle(e) }
                                }
                            },
                            onDelete = {
                                scope.launch {
                                    try {
                                        app.api()?.deleteDestination(dest.id)
                                        reload()
                                    } catch (e: Exception) { handle(e) }
                                }
                            },
                        )
                    }
                }
            }
            Spacer(Modifier.size(88.dp))
        }

        FloatingActionButton(
            onClick = { showAdd = true },
            containerColor = Theme.accent,
            contentColor = Color.Black,
            modifier = Modifier.align(Alignment.BottomEnd).padding(20.dp),
        ) {
            Icon(Icons.Default.Add, contentDescription = "Add destination")
        }

        error?.let { ErrorBanner(it, Modifier.align(Alignment.BottomCenter)) }
    }

    if (showAdd) {
        AlertDialog(
            onDismissRequest = { showAdd = false; newEmail = "" },
            containerColor = Theme.surface2,
            title = { Text("Add Destination", style = Theme.displayStyle(18.sp)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "We'll email a verification link before it can receive forwarded mail.",
                        style = Theme.bodyStyle(13.sp).copy(color = Theme.textSecondary),
                    )
                    OutlinedTextField(
                        value = newEmail,
                        onValueChange = { newEmail = it },
                        placeholder = { Text("you@example.com", color = Theme.textMuted) },
                        singleLine = true,
                        shape = RoundedCornerShape(8.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Theme.accent,
                            unfocusedBorderColor = Theme.borderStrong,
                        ),
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val email = newEmail.trim()
                        showAdd = false
                        newEmail = ""
                        if (email.isNotEmpty()) {
                            scope.launch {
                                try {
                                    app.api()?.createDestination(email)
                                    reload()
                                } catch (e: Exception) { handle(e) }
                            }
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Theme.accent, contentColor = Color.Black),
                ) { Text("Add") }
            },
            dismissButton = {
                TextButton(onClick = { showAdd = false; newEmail = "" }) { Text("Cancel", color = Theme.accent) }
            },
        )
    }
}

@Composable
private fun DestinationRow(
    dest: Destination,
    onMakeDefault: () -> Unit,
    onResume: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, top = 10.dp, bottom = 10.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(dest.email, style = Theme.bodyStyle(15.sp))
            // Status line: default star, suppression state, verification state.
            val (status, color) = when {
                dest.isSuppressed && dest.suppressionClass == "hard" -> "Suppressed" to Theme.red
                dest.isSuppressed -> "Paused" to Theme.red
                dest.isVerified -> "Verified" to Theme.green
                else -> "Pending" to Theme.textSecondary
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (dest.isDefaultDestination) {
                    Text("★ Default", style = Theme.bodyStyle(11.sp).copy(color = Theme.accent))
                }
                Text(status, style = Theme.bodyStyle(11.sp).copy(color = color))
            }
        }
        when {
            dest.canSelfUnsuppress -> TextButton(onClick = onResume) {
                Text("Resume", color = Theme.accent, fontSize = 12.sp)
            }
            !dest.isDefaultDestination && dest.isVerified && !dest.isSuppressed ->
                TextButton(onClick = onMakeDefault) {
                    Text("Make Default", color = Theme.textSecondary, fontSize = 12.sp)
                }
        }
        IconButton(onClick = onDelete) {
            Icon(Icons.Default.Delete, contentDescription = "Delete", tint = Theme.textMuted, modifier = Modifier.size(18.dp))
        }
    }
}
