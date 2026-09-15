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
 * GB design system — one brand blue (#0B5FFF, the launcher-icon colour) on clean, near-neutral greys.
 * Chrome-tight, calm, no gradients. Theme is Dark or Light only (no "system"). Every new screen reads
 * its colours from MaterialTheme.colorScheme; the [Brand]/[BrandOn]/[BrandSoft] tokens below name the
 * accent for the few places that want it directly.
 */

val Brand = Color(0xFF0B5FFF)          // the icon blue — buttons, FAB, selection
val BrandOnDark = Color(0xFF7EA8FF)    // lightened accent for text/icons on dark surfaces
val BrandOn = Color(0xFFFFFFFF)        // text/icon ON a brand-filled surface
val BrandSoft = Color(0x1F0B5FFF)      // translucent brand fill (selected chips/rows)

// Back-compat aliases (older screens reference these names).
val GbGreen = Brand
val GbGreenDim = Color(0xFF0A4FD6)
val GbGreenGhost = BrandSoft

// ── dark (default) — Chrome-like near-black ──
private val DBg = Color(0xFF16171A)
private val DSurface = Color(0xFF1F2024)
private val DSurfaceHi = Color(0xFF292A2E)
private val DText = Color(0xFFE6E7EA)
private val DMuted = Color(0xFF9AA0A6)
private val DLine = Color(0xFF34363B)

private val GbDark = darkColorScheme(
    primary = Brand,
    onPrimary = BrandOn,
    primaryContainer = Brand,
    onPrimaryContainer = BrandOn,
    secondary = BrandOnDark,
    onSecondary = BrandOn,
    background = DBg,
    onBackground = DText,
    surface = DSurface,
    onSurface = DText,
    surfaceVariant = DSurfaceHi,
    onSurfaceVariant = DMuted,
    outline = DLine,
    outlineVariant = DLine,
    error = Color(0xFFF2857D),
)

// ── light — clean white + brand blue ──
private val LBg = Color(0xFFFFFFFF)
private val LSurface = Color(0xFFF4F6FA)
private val LSurfaceHi = Color(0xFFE9EDF4)
private val LText = Color(0xFF16171A)
private val LMuted = Color(0xFF5F6368)
private val LLine = Color(0xFFDCE0E8)

private val GbLight = lightColorScheme(
    primary = Brand,
    onPrimary = BrandOn,
    primaryContainer = Brand,
    onPrimaryContainer = BrandOn,
    secondary = Brand,
    onSecondary = BrandOn,
    background = LBg,
    onBackground = LText,
    surface = LSurface,
    onSurface = LText,
    surfaceVariant = LSurfaceHi,
    onSurfaceVariant = LMuted,
    outline = LLine,
    outlineVariant = LLine,
    error = Color(0xFFC5372C),
)

private val GbType = Typography(
    headlineSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 22.sp),
    titleLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 18.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 15.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 14.sp),
    labelSmall = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 11.sp),
)

/** The accent to use for text/icons on the current theme's surfaces (lighter on dark for contrast). */
@Composable
fun accentOn(dark: Boolean): Color = if (dark) BrandOnDark else Brand

@Composable
fun GbTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (dark) GbDark else GbLight,
        typography = GbType,
        content = content,
    )
}
