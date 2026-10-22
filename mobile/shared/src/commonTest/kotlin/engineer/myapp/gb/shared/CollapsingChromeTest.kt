package engineer.myapp.gb.shared

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Chrome that gets out of the way — the rules that make it feel right rather than broken.
 *
 * Each of these is a way a collapsing header goes wrong: it flickers on a finger resting on the
 * glass, it stays hidden at the top of a page where there is nothing to read past, or a slow drift
 * in one direction eventually trips it by accident.
 */
class CollapsingChromeTest {

    @Test
    fun it_starts_shown() {
        assertFalse(ChromeScroll().hidden.value)
    }

    @Test
    fun a_small_scroll_does_not_move_it() {
        /* A finger resting on the glass, or the rubber-band of an overscroll. Reacting to every
           event is what makes a collapsing header flicker. */
        val c = ChromeScroll()
        c.onScroll(10, atTop = false)
        c.onScroll(10, atTop = false)
        assertFalse(c.hidden.value)
    }

    @Test
    fun sustained_downward_scrolling_slides_it_away() {
        val c = ChromeScroll()
        c.onScroll(30, atTop = false)
        c.onScroll(30, atTop = false)
        assertTrue(c.hidden.value)
    }

    @Test
    fun scrolling_back_up_brings_it_straight_back() {
        val c = ChromeScroll()
        c.onScroll(200, atTop = false)
        assertTrue(c.hidden.value)
        c.onScroll(-60, atTop = false)
        assertFalse(c.hidden.value)
    }

    @Test
    fun the_top_of_a_page_always_shows_it() {
        /* There is nothing to read past at the top, and a hidden address bar there reads as a bug.
           This is also the recovery path: however confused the count gets, going to the top fixes it. */
        val c = ChromeScroll()
        c.onScroll(500, atTop = false)
        assertTrue(c.hidden.value)
        c.onScroll(0, atTop = true)
        assertFalse(c.hidden.value)
    }

    @Test
    fun a_direction_change_starts_the_count_again() {
        /*
         * Without this, letting go mid-flick leaves a half-built total in the other direction that
         * fires later, on a scroll that should not have been enough. 40 down then 40 up must leave
         * it shown — not hidden because 40 + 40 crossed a threshold in two directions at once.
         */
        val c = ChromeScroll()
        c.onScroll(40, atTop = false)
        c.onScroll(-40, atTop = false)
        assertFalse(c.hidden.value)
        c.onScroll(-40, atTop = false)
        assertFalse(c.hidden.value)
    }

    @Test
    fun a_slow_drift_in_one_direction_still_trips_it_eventually() {
        /* The threshold is about sustained direction, not about speed: reading slowly down a page
           should still give the space back. */
        val c = ChromeScroll()
        repeat(5) { c.onScroll(10, atTop = false) }
        assertTrue(c.hidden.value)
    }

    @Test
    fun a_zero_report_changes_nothing() {
        val c = ChromeScroll()
        c.onScroll(200, atTop = false)
        c.onScroll(0, atTop = false)
        assertTrue(c.hidden.value)
    }

    @Test
    fun reset_shows_it_and_forgets_the_direction() {
        /* A new page, a switched tab, or a surface that is not a page at all. The forgetting matters:
           the last page's direction means nothing on this one. */
        val c = ChromeScroll()
        c.onScroll(200, atTop = false)
        c.reset()
        assertFalse(c.hidden.value)
        c.onScroll(30, atTop = false)
        assertFalse(c.hidden.value)      // the 200 is gone, so 30 alone is not enough
    }

    @Test
    fun a_layout_jump_is_not_a_person_scrolling() {
        /* An image loading above the viewport moves the scroll position by thousands of pixels at
           once. Acting on that slides the chrome away while somebody is sitting still. */
        val c = ChromeScroll()
        assertTrue(c.plausible(300))
        assertTrue(c.plausible(-300))
        assertFalse(c.plausible(9000))
        assertFalse(c.plausible(-9000))
    }
}
