package dev.hidemyemail.app.ui

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
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hidemyemail.app.AppViewModel
import dev.hidemyemail.app.net.ApiException
import dev.hidemyemail.app.net.Stats

@Composable
fun StatsScreen(app: AppViewModel, modifier: Modifier = Modifier) {
    var stats by remember { mutableStateOf<Stats?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        val client = app.api() ?: return@LaunchedEffect
        loading = true
        try {
            stats = client.stats()
            error = null
        } catch (e: ApiException) {
            if (e.isAuthFailure) app.handleAuthFailure() else error = e.message
        } catch (e: Exception) {
            error = e.message
        } finally {
            loading = false
        }
    }

    Box(modifier = modifier.fillMaxSize()) {
        val s = stats
        when {
            s != null -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                Text(
                    "Stats",
                    style = Theme.displayStyle(32.sp, FontWeight.Bold),
                    modifier = Modifier.padding(start = 20.dp, top = 16.dp, bottom = 8.dp),
                )

                SectionHeader("Totals")
                SectionCard {
                    MetricRow("Aliases", s.totals.aliases)
                    RowDivider()
                    MetricRow("Active", s.totals.active, Theme.green)
                }

                SectionHeader("Last 24 hours")
                SectionCard {
                    MetricRow("Forwarded", s.last24h.forward, Theme.green)
                    RowDivider()
                    MetricRow("Replied", s.last24h.reply, Theme.accent)
                    RowDivider()
                    MetricRow("Blocked", s.last24h.block, Theme.red)
                    RowDivider()
                    MetricRow("Rejected", s.last24h.reject, Theme.red)
                    RowDivider()
                    MetricRow("Errors", s.last24h.error, Theme.red)
                }

                if (s.topAliases.isNotEmpty()) {
                    SectionHeader("Top aliases")
                    SectionCard {
                        s.topAliases.forEachIndexed { i, top ->
                            if (i > 0) RowDivider()
                            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
                                Text(top.fullAddress, style = Theme.monoStyle(14.sp), maxLines = 1)
                                Text(
                                    "${top.fwdCount} forwarded · ${top.replyCount} replied · ${top.blockedCount} blocked",
                                    style = Theme.bodyStyle(11.sp).copy(color = Theme.textSecondary),
                                )
                            }
                        }
                    }
                }
                Spacer(Modifier.size(32.dp))
            }

            loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Theme.accent)
            }

            else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                EmptyState(Icons.Default.BarChart, "No stats")
            }
        }

        error?.let { ErrorBanner(it, Modifier.align(Alignment.BottomCenter)) }
    }
}

@Composable
private fun MetricRow(title: String, value: Int, color: Color = Theme.textPrimary) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Text(title, style = Theme.bodyStyle(16.sp), modifier = Modifier.weight(1f))
        Text("$value", style = Theme.monoStyle(15.sp).copy(color = color))
    }
}
