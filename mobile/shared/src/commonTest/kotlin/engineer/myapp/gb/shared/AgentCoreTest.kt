package engineer.myapp.gb.shared

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * THE READER THAT REPLACES A JSON LIBRARY.
 *
 * commonMain carries no parser on purpose (three targets would all pay for it), so AgentCore reads
 * the model's one-object-per-turn reply by walking the string. That is fine and it is also exactly
 * the kind of code that fails quietly: a brace inside a quoted caption truncates the arguments, an
 * escaped quote ends the string early, and the agent then calls a tool with half its input. The
 * cases below are the ones that would do it.
 */
class AgentCoreTest {

    @Test
    fun findsTheObjectEvenWhenTheModelChatsAroundIt() {
        val reply = "Sure, here goes:\n{\"reply\":\"done\"}\nhope that helps"
        assertEquals("{\"reply\":\"done\"}", AgentCore.firstJsonObject(reply))
    }

    @Test
    fun aBraceInsideAStringDoesNotEndTheObject() {
        // A caption or a goal can easily contain a brace. Counting braces blindly cuts the object in
        // half here, and the tool then gets arguments that stop mid-word.
        val s = "{\"tool\":\"browser_type\",\"args\":{\"text\":\"price {incl. btw}\",\"index\":3}}"
        assertEquals(s, AgentCore.firstJsonObject(s))
        assertEquals("{\"text\":\"price {incl. btw}\",\"index\":3}", AgentCore.objectField(s, "args"))
    }

    @Test
    fun anEscapedQuoteDoesNotEndTheString() {
        val s = "{\"reply\":\"he said \\\"no\\\" and left\"}"
        assertEquals("he said \"no\" and left", AgentCore.stringField(s, "reply"))
    }

    @Test
    fun nestedObjectsInArgsSurvive() {
        val s = "{\"tool\":\"device_command\",\"args\":{\"deviceId\":\"d1\",\"body\":{\"x\":1,\"y\":{\"z\":2}}}}"
        assertEquals("{\"deviceId\":\"d1\",\"body\":{\"x\":1,\"y\":{\"z\":2}}}", AgentCore.objectField(s, "args"))
    }

    @Test
    fun newlinesInAReplyComeBackAsNewlines() {
        val s = "{\"reply\":\"line one\\nline two\"}"
        assertEquals("line one\nline two", AgentCore.stringField(s, "reply"))
    }

    @Test
    fun aValueThatLooksLikeAKeyIsNotMistakenForOne() {
        // The word "tool" appears as a VALUE here. Searching for the text alone finds it and then
        // reads the wrong field — which would have the agent calling a tool named by its own prose.
        val s = "{\"reply\":\"I will use a \\\"tool\\\" next\"}"
        assertNull(AgentCore.stringField(s, "tool"))
        assertEquals("I will use a \"tool\" next", AgentCore.stringField(s, "reply"))
    }

    @Test
    fun missingFieldsAreNullRatherThanEmpty() {
        val s = "{\"tool\":\"browser_read\"}"
        assertNull(AgentCore.stringField(s, "reply"))
        assertNull(AgentCore.objectField(s, "args"))
        assertEquals("browser_read", AgentCore.stringField(s, "tool"))
    }

    @Test
    fun noObjectAtAllIsNull() {
        assertNull(AgentCore.firstJsonObject("I could not do that."))
        assertNull(AgentCore.firstJsonObject(""))
    }

    @Test
    fun anUnclosedObjectIsNullRatherThanAGuess() {
        // A truncated reply must not be treated as a whole one; half a tool call is worse than none.
        assertNull(AgentCore.firstJsonObject("{\"tool\":\"browser_read\",\"args\":{"))
    }

    // ── the loop, against a fake device ──────────────────────────────────────────────────────────

    private class FakeHost(
        override val deviceNoun: String,
        private val replies: MutableList<String>,
        private val toolTable: List<ToolSpec> = listOf(ToolSpec("browser_read", "read the tab")),
    ) : AgentHost {
        val said = mutableListOf<String>()
        val ran = mutableListOf<Pair<String, String>>()
        val calls = mutableListOf<Pair<String, String>>()
        val results = mutableListOf<String>()
        var prompts = 0
        override fun tools() = toolTable
        override fun liveContext() = "CURRENT TAB: about:blank"
        override fun runTool(name: String, argsJson: String): String { ran += name to argsJson; return "{\"ok\":true}" }
        override fun chat(system: String, user: String): String { prompts++; return replies.removeAt(0) }
        override fun push(role: String, text: String) { said += "$role:$text" }
        override fun pushToolCall(name: String, argsJson: String) { calls += name to argsJson }
        override fun pushToolResult(name: String, result: String) { results += name }
        override fun transcript() = "…"
    }

    @Test
    fun aReplyEndsTheTurn() {
        val h = FakeHost("phone", mutableListOf("{\"reply\":\"all done\"}"))
        AgentCore.run(h)
        assertEquals(listOf("assistant:all done"), h.said)
        assertEquals(0, h.ran.size)
    }

    @Test
    fun aToolIsRunAndThenTheAgentCarriesOn() {
        val h = FakeHost("desktop", mutableListOf(
            "{\"tool\":\"browser_read\",\"args\":{\"a\":1}}",
            "{\"reply\":\"read it\"}",
        ))
        AgentCore.run(h)
        assertEquals(listOf("browser_read" to "{\"a\":1}"), h.ran)
        assertEquals(listOf("assistant:read it"), h.said)
    }

    @Test
    fun theBudgetStopsAnAgentThatNeverReplies() {
        // Without this an agent that only ever calls tools runs until something else kills it, and on
        // a phone that is the battery.
        val h = FakeHost("phone", MutableList(50) { "{\"tool\":\"browser_read\",\"args\":{}}" })
        AgentCore.run(h, maxTurns = 3)
        assertEquals(3, h.ran.size)
        assertTrue(h.said.single().contains("stopped after 3 steps"))
    }

    @Test
    fun prosePastTheProtocolIsShownRatherThanRetried() {
        val h = FakeHost("phone", mutableListOf("I am not going to answer in JSON."))
        AgentCore.run(h)
        assertEquals(1, h.prompts)                       // asked once, not in a loop
        assertEquals(listOf("assistant:I am not going to answer in JSON."), h.said)
    }

    @Test
    fun aCallIsShownBeforeItsResult() {
        // Two separate hooks because the apps render them differently; a single one would have made
        // the phone show a tool call the way it shows a result.
        val h = FakeHost("phone", mutableListOf(
            "{\"tool\":\"browser_read\",\"args\":{\"a\":1}}",
            "{\"reply\":\"ok\"}",
        ))
        AgentCore.run(h)
        assertEquals(listOf("browser_read" to "{\"a\":1}"), h.calls)
        assertEquals(listOf("browser_read"), h.results)
    }

    @Test
    fun aPreambleLeadsThePrompt() {
        // The phone adopts a role per browser profile, and that changes what the agent should be
        // doing at all — so it goes first, before the standard wording.
        val h = object : AgentHost {
            override val deviceNoun = "phone"
            override fun tools() = listOf(ToolSpec("browser_read", "read"))
            override fun liveContext() = "CURRENT TAB: x"
            override fun preamble() = "ROLE: you are acting as \"facebook.scout\"."
            override fun runTool(name: String, argsJson: String) = "{}"
            override fun chat(system: String, user: String) = "{}"
            override fun push(role: String, text: String) {}
            override fun pushToolCall(name: String, argsJson: String) {}
            override fun pushToolResult(name: String, result: String) {}
            override fun transcript() = ""
        }
        val p = AgentCore.systemPrompt(h)
        assertTrue(p.startsWith("ROLE: you are acting as"))
        assertTrue(p.contains("running ON this phone"))
    }

    // ── the prompt is built from the device, which is the whole point ─────────────────────────────

    @Test
    fun thePromptNamesTheDeviceAndOnlyItsOwnTools() {
        val desktop = FakeHost("desktop", mutableListOf(), listOf(
            ToolSpec("click_xy", "click at a coordinate"),
            ToolSpec("drag", "drag from one point to another"),
            ToolSpec("upload_file", "put a local file into a page input"),
        ))
        val p = AgentCore.systemPrompt(desktop)
        assertTrue(p.contains("running ON this desktop"))
        assertTrue(p.contains("- click_xy:"))
        assertTrue(p.contains("- drag:"))
        assertTrue(p.contains("- upload_file:"))

        val phone = FakeHost("phone", mutableListOf(), listOf(ToolSpec("browser_read", "read the tab")))
        val q = AgentCore.systemPrompt(phone)
        assertTrue(q.contains("running ON this phone"))
        // The phone cannot drag, so it is never told it can. An offered tool that fails is worse than
        // an absent one: the model keeps reaching for it.
        assertTrue(!q.contains("drag"))
    }
}
