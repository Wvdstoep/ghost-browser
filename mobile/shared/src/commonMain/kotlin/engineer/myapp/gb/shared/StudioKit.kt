package engineer.myapp.gb.shared

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/*
 * THE STUDIO KIT — the few pieces every studio surface is built from, so the pages read as one
 * product rather than as cards each sized by whoever wrote them last.
 *
 * Spacing runs on a 4 dp grid (8 inside rows, 12 between rows, 16 inside cards, 16 between cards).
 * Type has five roles and no others: a card title, an eyebrow (small caps label over a group), the
 * body, a caption, and figures (monospace, so columns of numbers line up). Colour has four tones
 * for state - good, warn, bad, neutral - and the brand colour is spent only on what is good or
 * chosen. Everything else is the theme's own surfaces, which is what keeps light and dark honest.
 */
object Studio {
    val gapXs: Dp = 4.dp
    val gapS: Dp = 8.dp
    val gapM: Dp = 12.dp
    val gapL: Dp = 16.dp
    val gapXl: Dp = 24.dp
    val radius: Dp = 16.dp
    val radiusS: Dp = 10.dp
    /** Wider than this a page stops stretching and centres; a dashboard is not a banner. */
    val maxContent: Dp = 1440.dp
    val Warn = Color(0xFFE0A63A)
}

enum class Tone { GOOD, WARN, BAD, NEUTRAL }

@Composable
fun toneColor(t: Tone): Color = when (t) {
    Tone.GOOD -> Brand
    Tone.WARN -> Studio.Warn
    Tone.BAD -> MaterialTheme.colorScheme.error
    Tone.NEUTRAL -> MaterialTheme.colorScheme.onSurfaceVariant
}

/** A small-caps label over a group of things. */
@Composable
fun Eyebrow(text: String, modifier: Modifier = Modifier) {
    Text(text.uppercase(), modifier, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp)
}

/** One line of secondary text. */
@Composable
fun Caption(text: String, modifier: Modifier = Modifier, maxLines: Int = 2, color: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Text(text, modifier, color = color, fontSize = 11.sp, lineHeight = 15.sp, maxLines = maxLines, overflow = TextOverflow.Ellipsis)
}

/** A figure: monospace, so a column of them lines up. */
@Composable
fun Figure(text: String, modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.onSurface, size: Int = 12) {
    Text(text, modifier, color = color, fontSize = size.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** A state, as a chip: the word and the tone, nothing else. */
@Composable
fun StatusChip(text: String, tone: Tone) {
    val c = toneColor(tone)
    Surface(color = c.copy(alpha = 0.14f), shape = RoundedCornerShape(6.dp)) {
        Text(text, Modifier.padding(horizontal = 8.dp, vertical = 3.dp), color = c, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

/** A dot for a row: the tone at a glance. */
@Composable
fun ToneDot(tone: Tone, size: Dp = 8.dp) {
    Box(Modifier.size(size).clip(CircleShape).background(toneColor(tone)))
}

/**
 * The card. A title, one line under it, an optional chip on the right, and the body. Every studio
 * card is this one, which is what makes the pages read as one product.
 */
@Composable
fun StudioCard(
    title: String,
    sub: String = "",
    chip: (@Composable () -> Unit)? = null,
    modifier: Modifier = Modifier,
    body: @Composable ColumnScope.() -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(Studio.radius), modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(Studio.gapL)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(title, style = MaterialTheme.typography.titleMedium, color = cs.onSurface)
                    if (sub.isNotBlank()) { Spacer(Modifier.height(2.dp)); Caption(sub) }
                }
                if (chip != null) { Spacer(Modifier.width(Studio.gapS)); chip() }
            }
            Spacer(Modifier.height(Studio.gapM))
            body()
        }
    }
}

/** A thin bar: the share in the brand colour, the rest in the track. */
@Composable
fun Meter(share: Float, modifier: Modifier = Modifier, tone: Tone = Tone.GOOD, height: Dp = 6.dp) {
    val cs = MaterialTheme.colorScheme
    Box(modifier.height(height).clip(RoundedCornerShape(height / 2)).background(cs.surfaceVariant)) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(share.coerceIn(0f, 1f)).background(toneColor(tone)))
    }
}

/** A value with its label, for a row of them. */
@Composable
fun Kpi(label: String, value: String, modifier: Modifier = Modifier, tone: Tone = Tone.NEUTRAL, caption: String = "") {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(12.dp), modifier = modifier) {
        Column(Modifier.padding(12.dp)) {
            Eyebrow(label)
            Spacer(Modifier.height(4.dp))
            Text(value, color = if (tone == Tone.NEUTRAL) cs.onSurface else toneColor(tone), fontSize = 20.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (caption.isNotBlank()) { Spacer(Modifier.height(2.dp)); Caption(caption, maxLines = 1) }
        }
    }
}

/** A hairline between groups inside a card. */
@Composable
fun Hairline() {
    Spacer(Modifier.height(Studio.gapM)); HorizontalDivider(color = MaterialTheme.colorScheme.outline); Spacer(Modifier.height(Studio.gapM))
}

/** Nothing here yet - said plainly, with what would put something here. */
@Composable
fun EmptyState(title: String, line: String) {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Text(title, color = cs.onSurface, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        Caption(line, maxLines = 3)
    }
}
