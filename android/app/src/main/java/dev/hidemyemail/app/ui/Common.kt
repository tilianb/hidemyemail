package dev.hidemyemail.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Bottom error pill, matching the iOS `ErrorBanner`. */
@Composable
fun ErrorBanner(message: String, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .padding(bottom = 8.dp)
            .background(Theme.red, CircleShape)
            .padding(horizontal = 14.dp, vertical = 10.dp)
    ) {
        Text(message, color = Color.White, fontSize = 13.sp, fontFamily = Theme.body)
    }
}

/** Centered icon + title + description, matching iOS `ContentUnavailableView`. */
@Composable
fun EmptyState(icon: ImageVector, title: String, description: String? = null) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth().padding(32.dp),
    ) {
        Icon(icon, contentDescription = null, tint = Theme.textMuted, modifier = Modifier.padding(8.dp))
        Text(title, style = Theme.displayStyle(20.sp))
        if (description != null) {
            Text(
                description,
                style = Theme.bodyStyle(14.sp).copy(color = Theme.textSecondary),
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** Section header in the iOS grouped-list style. */
@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        style = Theme.bodyStyle(12.sp).copy(color = Theme.textSecondary, letterSpacing = 0.8.sp),
        modifier = modifier.padding(start = 16.dp, top = 20.dp, bottom = 6.dp),
    )
}

/** Grouped-list card: rows on a `surface1` panel with hairline dividers. */
@Composable
fun SectionCard(
    modifier: Modifier = Modifier,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .background(Theme.surface1, androidx.compose.foundation.shape.RoundedCornerShape(12.dp)),
        content = content,
    )
}

@Composable
fun RowDivider() {
    androidx.compose.material3.HorizontalDivider(color = Theme.border, modifier = Modifier.padding(start = 16.dp))
}

/** Footer caption under a section, iOS-style. */
@Composable
fun SectionFooter(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = Theme.bodyStyle(12.sp).copy(color = Theme.textSecondary),
        modifier = modifier.padding(horizontal = 16.dp, vertical = 6.dp),
    )
}
