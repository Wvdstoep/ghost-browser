package engineer.myapp.gbmobile.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * GB design system — the single source of brand style for every new (Compose) screen.
 * ONE green accent (#3fb950) on dark ink, calm spacing, no gradients/glow. This is the toolkit-level
 * home the whole UX overhaul (run sheet, settings, results) is built on.
 */

val GbGreen = Color(0xFF3FB950)
val GbGreenDim = Color(0xFF2B7D38)
val GbGreenGhost = Color(0x1A3FB950)

private val Ink = Color(0xFFE8F0EA)
private val Muted = Color(0xFF93A79A)
private val Bg = Color(0xFF0B0F0D)
private val Surface = Color(0xFF121A16)
private val SurfaceHi = Color(0xFF16211B)
private val Line = Color(0xFF1F2C25)

private val GbDark = darkColorScheme(
    primary = GbGreen,
    onPrimary = Color(0xFF04140A),
    primaryContainer = GbGreenDim,
    onPrimaryContainer = Ink,
    secondary = GbGreen,
    background = Bg,
    onBackground = Ink,
    surface = Surface,
    onSurface = Ink,
    surfaceVariant = SurfaceHi,
    onSurfaceVariant = Muted,
    outline = Line,
    outlineVariant = Line,
    error = Color(0xFFE06C75),
)

private val GbLight = lightColorScheme(
    primary = GbGreenDim,
    onPrimary = Color.White,
    background = Color(0xFFF4F7F5),
    onBackground = Color(0xFF0B0F0D),
    surface = Color.White,
    onSurface = Color(0xFF0B0F0D),
    surfaceVariant = Color(0xFFE6EDE8),
    onSurfaceVariant = Color(0xFF4B5A51),
    outline = Color(0xFFD0DAD3),
)

private val GbType = Typography(
    headlineSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 22.sp),
    titleLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 18.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 15.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 14.sp),
    labelSmall = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 11.sp),
)

@Composable
fun GbTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (dark) GbDark else GbLight,
        typography = GbType,
        content = content,
    )
}
