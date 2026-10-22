package engineer.myapp.gb.shared

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.assertFalse

/**
 * THE DEVICE RING'S WORK, MADE LEARNABLE.
 *
 * The ring exists for the browsing that can only happen on a machine with a real login and a real
 * address — the most valuable and least reproducible work there is — and none of it taught the model
 * anything, because it was journalled as prose into a store nothing reads.
 *
 * Every test here is one way the recording would look fine and still be worthless:
 *
 *   - an observation with a kind the builder does not recognise, so the decision after it appears to
 *     have been made having seen nothing, and is dropped;
 *   - a look whose numbered list is summarised away, which is exactly what made 2,987 click and type
 *     turns unlearnable on the cluster for months;
 *   - the goal missing, which yields no turns at all;
 *   - a page full of quotes and braces breaking the body, so the whole run is lost rather than
 *     one step.
 */
class DeviceTraceTest {

    @Test
    fun theGoalIsTheFirstStep() {
        /* The builder keys everything off it: a job with no goal produces nothing whatsoever. */
        val r = DeviceTrace.Run("Find three suppliers")
        assertEquals(1, r.stepCount())
        assertTrue(r.body("done", "ok", "laptop").contains("\"kind\":\"you\""))
    }

    @Test
    fun aHandedOverRunNamesTheClusterJobItBelongsTo() {
        /* The master is polling the job the cluster made for this goal; without the id the run is
           filed as a new job and the master waits on the old one until it times out. */
        assertTrue(DeviceTrace.Run("g", runId = "j-abc").body("done", "ok", "laptop").contains("\"runId\":\"j-abc\""))
        assertTrue(!DeviceTrace.Run("g").body("done", "ok", "laptop").contains("runId"))
    }

    @Test
    fun aLookKEEPSItsNumberedList() {
        /*
         * The whole reason index-bearing turns were unlearnable. On a device the look's result IS
         * the list, so summarising it here would repeat the cluster's mistake on the one surface
         * where the data is scarcest.
         */
        val r = DeviceTrace.Run("g")
        r.tool("look", "{}")
        r.observed("look", "[1] Sign in\n[2] Dodaj ofertę\n[3] Close")
        val body = r.body("done", "done", "laptop")
        assertTrue(body.contains("\"marks\""), "a look must carry its list")
        assertTrue(body.contains("Dodaj"), "the list itself must survive")
    }

    @Test
    fun onlyALookCarriesMarks() {
        /* A read's text is not a set of numbers to click, and storing it as marks would put stale
           non-indexes in front of the model as though they were current. */
        val r = DeviceTrace.Run("g")
        r.tool("read", "{}")
        r.observed("read", "Some page text")
        assertFalse(r.body("done", "d", "l").contains("\"marks\""))
    }

    @Test
    fun everyResultGetsAKindTheBuilderKNOWS() {
        /* An unrecognised kind is not history. The turn after it then looks like a decision made
           having observed nothing, and the builder drops it — losing the good turn, silently. */
        assertEquals("look", DeviceTrace.kindFor("look"))
        assertEquals("read", DeviceTrace.kindFor("read_table"))
        assertEquals("open", DeviceTrace.kindFor("navigate"))
        assertEquals("click", DeviceTrace.kindFor("click_text"))
        assertEquals("scroll", DeviceTrace.kindFor("scroll"))
        /* The honest generic for anything new: something was observed. */
        assertEquals("read", DeviceTrace.kindFor("some_tool_invented_next_month"))
    }

    @Test
    fun theCallAndItsResultAlternate() {
        /* A turn is a decision plus what was visible before it. Two calls with no observation
           between them cannot be read as two turns. */
        val r = DeviceTrace.Run("g")
        r.tool("open", "{\"url\":\"https://example.com\"}")
        r.observed("open", "https://example.com")
        r.tool("look", "{}")
        r.observed("look", "[1] Learn more")
        val body = r.body("done", "ok", "laptop")
        val order = Regex("\"kind\":\"(\\w+)\"").findAll(body).map { it.groupValues[1] }.toList()
        assertEquals(listOf("you", "tool", "open", "tool", "look", "done"), order)
    }

    @Test
    fun argumentsStayAnObjectRatherThanBecomingAString() {
        /* The args are what the model actually chose; wrapped as a string they stop being a tool
           call and the turn cannot be used as one. */
        val r = DeviceTrace.Run("g")
        r.tool("click", "{\"index\":13}")
        assertTrue(r.body("done", "d", "l").contains("\"args\":{\"index\":13}"))
    }

    @Test
    fun argumentsThatAreNotAnObjectDoNotBreakTheRun() {
        /* One malformed call should cost one step, never the whole run. */
        val r = DeviceTrace.Run("g")
        r.tool("click", "not json at all")
        assertTrue(r.body("done", "d", "l").contains("\"raw\":"))
    }

    @Test
    fun aPageFullOfQuotesAndBracesSurvives() {
        /* Written at string level, so this is the thing that actually breaks. A page that broke the
           body would lose the entire run rather than one step. */
        val r = DeviceTrace.Run("Read the \"weird\" page")
        r.tool("read", "{}")
        r.observed("read", "He said \"hello\" and {\"tool\":\"look\"} appeared\nline two\ttabbed")
        val body = r.body("done", "Done \"fine\"", "laptop")
        assertTrue(body.startsWith("{") && body.endsWith("}"))
        assertTrue(body.contains("\\\"hello\\\""))
        assertTrue(body.contains("\\n"))
    }

    @Test
    fun aStoppedRunEndsDifferentlyFromAFinishedOne() {
        /* The verifiers read the ending: an owner stopping a run is not the agent failing, and the
           two have to be distinguishable or every interruption is scored as a fault. */
        val r = DeviceTrace.Run("g")
        assertTrue(r.body("stopped", "stopped by you", "l").contains("\"kind\":\"end\""))
        assertTrue(r.body("done", "all good", "l").contains("\"kind\":\"done\""))
    }
}
