package dev.hidemyemail.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import dev.hidemyemail.app.R

/**
 * Design tokens lifted from the web dashboard (`dashboard/src/index.css`) and
 * the iOS app's `Theme.swift`, so all three clients read as the same product:
 * a dark "privacy console" with a phosphor amber accent, layered near-black
 * surfaces, and the same three typefaces (Bricolage Grotesque display /
 * IBM Plex Sans body / JetBrains Mono data).
 */
object Theme {
    // Canvas layers (--canvas / --surface-*)
    val canvas = Color(0xFF0D0D0F)
    val surface0 = Color(0xFF111114)
    val surface1 = Color(0xFF18181D)
    val surface2 = Color(0xFF1F1F26)
    val surface3 = Color(0xFF26262F)
    val border = Color.White.copy(alpha = 0.07f)
    val borderStrong = Color.White.copy(alpha = 0.13f)

    // Accent — phosphor amber
    val accent = Color(0xFFFFB300)
    val accentDim = Color(0xFFFFB300).copy(alpha = 0.15f)
    val accentHover = Color(0xFFFFC933)

    // Text
    val textPrimary = Color(0xFFE8E8EC)
    val textSecondary = Color(0xFF9898A8)
    val textMuted = Color(0xFF55555F)

    // Semantic
    val green = Color(0xFF3DDC84)
    val red = Color(0xFFFF5050)
    val blue = Color(0xFF6CB4FF)

    /** Bricolage Grotesque — page titles, section labels, stats. */
    val display = FontFamily(
        Font(R.font.bricolage_regular, FontWeight.Normal),
        Font(R.font.bricolage_medium, FontWeight.Medium),
        Font(R.font.bricolage_semibold, FontWeight.SemiBold),
        Font(R.font.bricolage_bold, FontWeight.Bold),
    )

    /** IBM Plex Sans — running body text and controls. */
    val body = FontFamily(
        Font(R.font.plex_regular, FontWeight.Normal),
        Font(R.font.plex_medium, FontWeight.Medium),
        Font(R.font.plex_semibold, FontWeight.SemiBold),
    )

    /** JetBrains Mono — addresses, tokens, any monospaced data. */
    val mono = FontFamily(
        Font(R.font.jbmono_regular, FontWeight.Normal),
        Font(R.font.jbmono_medium, FontWeight.Medium),
    )

    fun displayStyle(size: TextUnit, weight: FontWeight = FontWeight.SemiBold) =
        TextStyle(fontFamily = display, fontSize = size, fontWeight = weight, color = textPrimary)

    fun bodyStyle(size: TextUnit = 16.sp, weight: FontWeight = FontWeight.Normal) =
        TextStyle(fontFamily = body, fontSize = size, fontWeight = weight, color = textPrimary)

    fun monoStyle(size: TextUnit = 14.sp, medium: Boolean = false) = TextStyle(
        fontFamily = mono,
        fontSize = size,
        fontWeight = if (medium) FontWeight.Medium else FontWeight.Normal,
        color = textPrimary,
    )
}

private val DarkScheme = darkColorScheme(
    primary = Theme.accent,
    onPrimary = Color.Black,
    secondary = Theme.accent,
    onSecondary = Color.Black,
    background = Theme.canvas,
    onBackground = Theme.textPrimary,
    surface = Theme.surface0,
    onSurface = Theme.textPrimary,
    surfaceVariant = Theme.surface1,
    onSurfaceVariant = Theme.textSecondary,
    surfaceContainer = Theme.surface1,
    surfaceContainerHigh = Theme.surface2,
    surfaceContainerHighest = Theme.surface3,
    surfaceContainerLow = Theme.surface0,
    surfaceContainerLowest = Theme.canvas,
    outline = Theme.borderStrong,
    outlineVariant = Theme.border,
    error = Theme.red,
    onError = Color.White,
)

@Composable
fun HmeTheme(content: @Composable () -> Unit) {
    // Dark-only by design, like the iOS app and web dashboard.
    MaterialTheme(
        colorScheme = DarkScheme,
        typography = androidx.compose.material3.Typography(
            displayLarge = Theme.displayStyle(32.sp, FontWeight.Bold),
            titleLarge = Theme.displayStyle(22.sp, FontWeight.Bold),
            titleMedium = Theme.displayStyle(17.sp),
            bodyLarge = Theme.bodyStyle(16.sp),
            bodyMedium = Theme.bodyStyle(14.sp),
            bodySmall = Theme.bodyStyle(12.sp),
            labelLarge = Theme.bodyStyle(14.sp, FontWeight.Medium),
            labelMedium = Theme.bodyStyle(12.sp, FontWeight.Medium),
            labelSmall = Theme.bodyStyle(10.sp, FontWeight.Medium),
        ),
        content = content,
    )
}
