package engineer.myapp.gb.shared

import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * ONE UI, TWO DEVICES, ONE ENGINE — the parsing that makes it true.
 *
 * Ask on the phone and the job may run on the desktop; ask on the desktop and it may run on the
 * phone. So "what is happening" comes from the cluster, and this reads it. Parsed at string level
 * because commonMain deliberately carries no JSON parser, which means the brace and quote handling
 * is the thing that breaks — a log line is full of both.
 */
class RingWatchTest {

    private val mine = "WojMagEmi"

    /*
     * RingWork is a singleton, because there is one device and one thing it can be doing. That means
     * state leaks between tests unless it is cleared — and the leak is not cosmetic: the never-shrink
     * rule then holds the PREVIOUS test's lines, which is what made a passing parser look broken.
     */
    @BeforeTest fun clean() = RingWork.clear()

    @Test
    fun nothing_running_anywhere_clears_busy_without_wiping_the_account() {
        RingWork.lines.value = listOf("· click_xy {\"x\":10}")
        RingWatch.apply("{\"working\":[]}", mine)
        assertFalse(RingWork.busy.value)
        assertEquals(1, RingWork.lines.value.size)   // what it last did stays readable
    }

    @Test
    fun a_missing_field_is_not_a_crash() {
        RingWatch.apply("{}", mine)
        assertFalse(RingWork.busy.value)
        RingWatch.apply("not json at all", mine)
        assertFalse(RingWork.busy.value)
    }

    @Test
    fun work_on_ANOTHER_device_is_named() {
        /* The whole point: asked on the desktop, running on the phone, and the desktop says so. */
        val body = """{"working":[{"deviceId":"d1","name":"SM-F926B","online":true,"goal":"make a short","lines":["▶ took the goal"]}]}"""
        RingWatch.apply(body, mine)
        assertTrue(RingWork.busy.value)
        assertEquals("SM-F926B", RingWork.onDevice.value)
        assertEquals("make a short", RingWork.goal.value)
    }

    @Test
    fun work_on_THIS_device_is_not_named_as_elsewhere() {
        val body = """{"working":[{"name":"WojMagEmi","goal":"g","lines":["▶ took the goal"]}]}"""
        RingWatch.apply(body, mine)
        assertTrue(RingWork.busy.value)
        assertEquals("", RingWork.onDevice.value)
    }

    @Test
    fun the_device_name_is_matched_case_insensitively() {
        val body = """{"working":[{"name":"wojmagemi","goal":"g","lines":[]}]}"""
        RingWatch.apply(body, mine)
        assertEquals("", RingWork.onDevice.value)
    }

    @Test
    fun braces_and_quotes_inside_a_log_line_do_not_end_the_object_early() {
        /* Every reported line is a tool call with JSON args, so this is the normal case, not an edge. */
        val body = """{"working":[{"name":"SM-F926B","goal":"edit {the} clip","lines":["· click_xy {\"x\":120,\"y\":300}","· upload_file {\"path\":\"C:\\\\a.mp4\"}"],"next":2}]}"""
        RingWatch.apply(body, mine)
        assertEquals(2, RingWork.lines.value.size)
        assertTrue(RingWork.lines.value[0].contains("\"x\":120"))
        assertEquals("edit {the} clip", RingWork.goal.value)
    }

    @Test
    fun a_newline_escape_in_a_line_is_decoded() {
        val body = """{"working":[{"name":"d","goal":"g","lines":["first\nsecond"]}]}"""
        RingWatch.apply(body, mine)
        assertTrue(RingWork.lines.value[0].contains("\n"))
    }

    @Test
    fun an_empty_working_array_is_told_apart_from_an_object_later_in_the_body() {
        /* firstWorkingObject must not reach past the array's own bracket and mistake something else
           for a working entry. */
        assertNull(RingWatch.firstWorkingObject("""{"working":[],"other":{"name":"nope"}}"""))
    }

    @Test
    fun a_shorter_answer_never_shrinks_what_is_on_screen() {
        /* A poll that raced a pod restart would otherwise blank the account of a job still running. */
        RingWork.lines.value = listOf("a", "b", "c")
        RingWatch.apply("""{"working":[{"name":"d","goal":"g","lines":["a"]}]}""", mine)
        assertEquals(3, RingWork.lines.value.size)
    }

    @Test
    fun brackets_are_matched_by_depth() {
        val s = "[{\"a\":[1,2]},{\"b\":3}]"
        assertEquals(s.length - 1, RingWatch.matchingBracket(s, 0, '[', ']'))
    }

    @Test
    fun an_unterminated_object_is_refused_rather_than_half_read() {
        assertNull(RingWatch.firstWorkingObject("""{"working":[{"name":"d","goal":"g" """))
    }
}
