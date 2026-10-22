package engineer.myapp.gb.shared

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.Layout
import kotlin.math.abs

/**
 * CHROME THAT GETS OUT OF THE WAY — the address bar and the bottom nav slide off while you read
 * down a page, and come back the moment you go up.
 *
 * A phone screen is mostly chrome: a 44dp omnibox with its padding at the top and a nav bar at the
 * bottom take a fifth of the display, permanently, on every page. Every real browser gives that
 * space back while you are reading and returns it the instant you reach for it, and doing it by
 * SCROLL DIRECTION rather than by position is what makes it feel like the page is in charge.
 *
 * Three things here are the difference between this feeling right and feeling broken:
 *
 *   1. A THRESHOLD, NOT A PIXEL. Reacting to every scroll event makes the chrome flicker on the
 *      small jitter of a finger resting on the glass, and on the rubber-band of an overscroll. So a
 *      direction has to be sustained before anything moves, and the accumulator resets whenever the
 *      direction changes — otherwise a slow drift in one direction eventually trips it by accident.
 *   2. THE TOP ALWAYS SHOWS IT. At the top of a page there is nothing to read past, and a hidden
 *      address bar there reads as a bug. This is also the recovery path: however confused the
 *      accumulator gets, scrolling to the top puts the chrome back.
 *   3. IT NEVER HIDES WHAT ISN'T A PAGE. Sliding a nav bar off the Profiles screen or the chat would
 *      leave the app with no way out. Only the browser surface collapses, and leaving it shows the
 *      chrome again.
 */
class ChromeScroll {
    /** True while the chrome is slid away. Compose reads this and animates. */
    val hidden = mutableStateOf(false)

    /*
     * Sustained travel in the current direction. Positive is downward (content moving up, reading
     * on), negative upward. Reset on a direction change so a long slow drift cannot trip it.
     */
    private var travel = 0

    /** How far a direction has to be sustained before the chrome moves, in px. */
    private val threshold = 48

    /**
     * @param dy      pixels scrolled since the last report; positive = scrolled down the page
     * @param atTop   the page is at (or within a hair of) its top
     */
    fun onScroll(dy: Int, atTop: Boolean) {
        if (atTop) { travel = 0; hidden.value = false; return }
        if (dy == 0) return
        /* A direction change starts the count again rather than eating into the other direction's
           progress: otherwise letting go mid-flick leaves a half-built total that fires later. */
        if ((dy > 0) != (travel > 0)) travel = 0
        travel += dy
        if (travel > threshold) { hidden.value = true; travel = 0 }
        else if (travel < -threshold) { hidden.value = false; travel = 0 }
    }

    /** A new page, or a surface that is not a page at all: the chrome comes back and stays. */
    fun reset() { travel = 0; hidden.value = false }

    /** Ignore a report that is plainly a layout jump rather than a person scrolling. */
    fun plausible(dy: Int): Boolean = abs(dy) < 4000
}

/**
 * A slot that collapses to nothing while its content slides out of the screen edge.
 *
 * The content's own measured height is used, so nothing here has to know how tall an address bar is
 * with this device's status-bar inset — a hard-coded height is exactly the kind of number that is
 * right on one phone and wrong on the next. The slot shrinks as the content leaves, which is what
 * gives the page the space rather than just covering it.
 *
 * @param visible   0 = fully gone, 1 = fully shown; animated by the caller or by [rememberChromeFraction]
 * @param fromTop   true for a top bar (slides up out of the top), false for a bottom bar
 */
@Composable
fun CollapsingSlot(visible: Float, fromTop: Boolean, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val f = visible.coerceIn(0f, 1f)
    Layout(
        content = { Box { content() } },
        modifier = modifier.clipToBounds(),
    ) { measurables, constraints ->
        val p = measurables.first().measure(constraints)
        val full = p.height
        val shown = (full * f).toInt()
        /* The bar keeps its full height and is pushed out past the edge; the SLOT is what shrinks.
           Scaling the bar instead would squash its contents. */
        val y = if (fromTop) shown - full else full - shown
        layout(p.width, shown) { p.place(0, y) }
    }
}

/** The animated 0..1 the slots follow. One easing for both bars so they leave together. */
@Composable
fun rememberChromeFraction(hidden: Boolean): Float =
    animateFloatAsState(
        targetValue = if (hidden) 0f else 1f,
        animationSpec = tween(durationMillis = 180, easing = FastOutSlowInEasing),
        label = "chrome",
    ).value
