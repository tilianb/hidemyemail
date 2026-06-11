package dev.hidemyemail.app.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import dev.hidemyemail.app.AppViewModel

private data class Tab(val title: String, val icon: ImageVector)

private val tabs = listOf(
    Tab("Aliases", Icons.Default.AlternateEmail),
    Tab("Domains", Icons.Default.Public),
    Tab("Rules", Icons.Default.Shield),
    Tab("Stats", Icons.Default.BarChart),
    Tab("Settings", Icons.Default.Settings),
)

/** Bottom-tab shell mirroring the iOS `MainTabView`. */
@Composable
fun MainScaffold(app: AppViewModel) {
    var selected by rememberSaveable { mutableIntStateOf(0) }

    Scaffold(
        containerColor = Theme.canvas,
        bottomBar = {
            NavigationBar(containerColor = Theme.surface0) {
                tabs.forEachIndexed { index, tab ->
                    NavigationBarItem(
                        selected = selected == index,
                        onClick = { selected = index },
                        icon = { Icon(tab.icon, contentDescription = tab.title) },
                        label = { Text(tab.title) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = Theme.accent,
                            selectedTextColor = Theme.accent,
                            unselectedIconColor = Theme.textSecondary,
                            unselectedTextColor = Theme.textSecondary,
                            indicatorColor = Theme.accentDim,
                        ),
                    )
                }
            }
        },
    ) { padding ->
        val modifier = Modifier.padding(padding)
        when (selected) {
            0 -> AliasesScreen(app, modifier)
            1 -> DomainsScreen(app, modifier)
            2 -> RulesScreen(app, modifier)
            3 -> StatsScreen(app, modifier)
            4 -> SettingsScreen(app, modifier)
        }
    }
}
