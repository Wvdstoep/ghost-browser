package engineer.myapp.gb.shared

/**
 * ONE AGENT, TWO DEVICES.
 *
 * The phone and the desktop each had their own copy of the same agent: the same JSON-per-turn
 * protocol, the same "reply or tool" loop, the same operator routing, the same prompt wording — and
 * they had already drifted. The desktop's tool list, for instance, never offered click_xy, drag or
 * upload_file, although the desktop NODE handles all three; so a CapCut edit handed to that machine
 * could not be performed by the agent standing in front of the browser that could do it.
 *
 * So the loop lives here, once, and the differences that are real — which device this is, and what
 * that device can actually do — are declared by the host rather than written twice.
 *
 * WHY THIS FILE HAS NO JSON LIBRARY. shared/ targets android, desktop and wasmJs, and only wasmJs
 * carries kotlinx-serialization. Adding a parser to commonMain for this would mean every target
 * paying for it, so the core stays string-level: it finds the one JSON object in a model reply and
 * hands the raw `args` text to the host, which parses it with the JSON its platform already has
 * (org.json on both JVM sides). The core never needs to understand a tool's arguments — only the
 * host runs tools.
 *
 * WHY IT IS SYNCHRONOUS. commonMain has no threads, and both platforms already run their agent on a
 * background thread of their own. run() blocks; the caller decides where.
 */

/** One tool as the model is told about it: its name, and the one line that explains when to use it. */
data class ToolSpec(val name: String, val help: String)

/**
 * What a device brings to the agent. Everything here is a real difference between a phone and a
 * laptop; everything else is in the core.
 */
interface AgentHost {
    /** "phone" or "desktop" — the agent is told plainly what it is running on. */
    val deviceNoun: String

    /** What THIS machine can do. The prompt is built from it, so a tool absent here cannot be asked
     *  for, and a tool present here must really run — an advertised tool that errors is worse than a
     *  missing one, because the model will keep trying it. */
    fun tools(): List<ToolSpec>

    /** The live situation this turn: the tab it controls, the profile it is in. */
    fun liveContext(): String

    /**
     * Anything that goes BEFORE the standard prompt. The phone adopts a role per browser profile
     * ("you are acting as <role>"), which changes what the agent should be doing at all, so it leads;
     * the desktop has none and returns "".
     */
    fun preamble(): String = ""

    /** Run one tool and return its result as a JSON string. `argsJson` is the raw object text. */
    fun runTool(name: String, argsJson: String): String

    /** Ask the model. The host decides whether that is the cluster's LLM or a local endpoint. */
    fun chat(system: String, user: String): String

    /** Show a message in the device's own chat. */
    fun push(role: String, text: String)

    /**
     * A tool being CALLED, and its RESULT — two methods rather than one, because the two apps already
     * render them differently (the phone shows the call as the assistant's own line and the result as
     * a tool chip). One method used for both would have forced one of them to change how it looks.
     */
    fun pushToolCall(name: String, argsJson: String)
    fun pushToolResult(name: String, result: String)

    /** The conversation so far, as the model should see it. */
    fun transcript(): String
}

object AgentCore {

    /** How many tool calls one goal may take before the agent has to report instead. */
    const val MAX_TURNS = 24

    /**
     * The prompt, built from what the device declares.
     *
     * The device noun and the tool list are the only parts that differ between a phone and a laptop,
     * and they come from the host — which is what makes "the same agent, and it knows what it is
     * running on" true rather than a claim. The wording was the phone's, which was the fuller of the
     * two: it says plainly that the tab is a real, probably signed-in browser and that the user's own
     * accounts are reached through it and not through the cluster.
     */
    fun systemPrompt(host: AgentHost): String {
        val tools = host.tools().joinToString("\n") { "- ${it.name}: ${it.help}" }
        val lead = host.preamble().trim().let { if (it.isEmpty()) "" else it + "\n\n" }
        return lead +
            "You are the Ghost Browser agent running ON this ${host.deviceNoun}. You DRIVE this " +
            "${host.deviceNoun}'s own real, logged-in browser tab — the user is often already signed in on " +
            "it. To check messages, notifications, feeds or pages on a site the user uses, DO IT ON THE " +
            "ACTIVE TAB: browser_navigate to the site, then browser_read / browser_posts. Do NOT reach the " +
            "user's own accounts through the cluster or another device; this browser is the one that holds " +
            "their login.\n" +
            "Each turn reply with EXACTLY ONE compact JSON object and nothing else:\n" +
            "  {\"reply\":\"text to the user\"}  — to talk, answer, or report what you did\n" +
            "  {\"tool\":\"<name>\",\"args\":{...}} — to act; you then get TOOL RESULT and continue\n" +
            "Chain tools as needed; when done, or when you need the user, use reply. Be concise. Never " +
            "invent a tool result.\n" +
            host.liveContext() + "\nTools:\n" + tools
    }

    /**
     * The turn loop. Blocks until the agent replies, gives up, or runs out of turns.
     *
     * A reply ends it. A tool call is run and fed back. Anything the model says that is neither is
     * shown to the user as text and ends the turn — a model that stops speaking the protocol is not
     * made to by asking again, and looping on it burns the budget in silence.
     */
    fun run(host: AgentHost, maxTurns: Int = MAX_TURNS) {
        val system = systemPrompt(host)
        var turns = 0
        while (turns < maxTurns) {
            val reply = try { host.chat(system, host.transcript()) }
            catch (e: Exception) { host.push("assistant", "⚠ model error: ${e.message}"); return }

            val obj = firstJsonObject(reply)
            if (obj == null) { host.push("assistant", reply.trim().ifBlank { "(no reply)" }); return }

            val said = stringField(obj, "reply")
            if (said != null) { host.push("assistant", said); return }

            val name = stringField(obj, "tool")
            if (name.isNullOrBlank()) { host.push("assistant", reply.trim().ifBlank { "(no reply)" }); return }

            val args = objectField(obj, "args") ?: "{}"
            host.pushToolCall(name, args)
            var result = try { host.runTool(name, args) }
            catch (e: Exception) { "{\"error\":\"${escape(e.message ?: "error")}\"}" }
            if (result.length > 3500) result = result.take(3500) + "…"
            host.pushToolResult(name, result)
            turns++
        }
        host.push("assistant", "(stopped after $maxTurns steps — ask me to continue)")
    }

    // ── string-level JSON, because commonMain has no parser ──────────────────────────────────────

    /** The first balanced {...} in a model reply, ignoring braces inside strings. */
    fun firstJsonObject(s: String): String? {
        val start = s.indexOf('{')
        if (start < 0) return null
        var depth = 0
        var inStr = false
        var esc = false
        for (i in start until s.length) {
            val c = s[i]
            when {
                esc -> esc = false
                c == '\\' && inStr -> esc = true
                c == '"' -> inStr = !inStr
                !inStr && c == '{' -> depth++
                !inStr && c == '}' -> { depth--; if (depth == 0) return s.substring(start, i + 1) }
            }
        }
        return null
    }

    /** A top-level string field, unescaped. Null when absent or not a string. */
    fun stringField(obj: String, key: String): String? {
        val i = keyIndex(obj, key) ?: return null
        var j = i
        while (j < obj.length && obj[j] != ':') j++
        j++
        while (j < obj.length && obj[j].isWhitespace()) j++
        if (j >= obj.length || obj[j] != '"') return null
        val sb = StringBuilder()
        var k = j + 1
        var esc = false
        while (k < obj.length) {
            val c = obj[k]
            if (esc) {
                sb.append(when (c) { 'n' -> '\n'; 't' -> '\t'; 'r' -> '\r'; else -> c })
                esc = false
            } else when (c) {
                '\\' -> esc = true
                '"' -> return sb.toString()
                else -> sb.append(c)
            }
            k++
        }
        return sb.toString()
    }

    /** A top-level object field, as raw text (so the host parses it with its own JSON). */
    fun objectField(obj: String, key: String): String? {
        val i = keyIndex(obj, key) ?: return null
        var j = i
        while (j < obj.length && obj[j] != ':') j++
        j++
        while (j < obj.length && obj[j].isWhitespace()) j++
        if (j >= obj.length || obj[j] != '{') return null
        return firstJsonObject(obj.substring(j))
    }

    /** Where "key" appears as a KEY (not inside some value), at any depth-1 position. */
    private fun keyIndex(obj: String, key: String): Int? {
        val needle = "\"$key\""
        var from = 0
        while (true) {
            val at = obj.indexOf(needle, from)
            if (at < 0) return null
            // A key is followed by a colon; a value that happens to equal the key name is not.
            var j = at + needle.length
            while (j < obj.length && obj[j].isWhitespace()) j++
            if (j < obj.length && obj[j] == ':') return at
            from = at + needle.length
        }
    }

    private fun escape(s: String) = s.replace("\\", "\\\\").replace("\"", "\\\"")
}
