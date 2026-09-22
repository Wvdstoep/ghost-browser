package engineer.myapp.gb.desktop

import engineer.myapp.gb.shared.AgentCore
import engineer.myapp.gb.shared.AgentHost
import engineer.myapp.gb.shared.ChatMsg
import engineer.myapp.gb.shared.ToolSpec
import org.cef.browser.CefBrowser
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.concurrent.thread

/**
 * The desktop Agent — same conversational tool-loop as the phone, but the LLM is an OpenAI-compatible
 * endpoint (Ollama at http://localhost:11434/v1, or any compatible host) since the desktop can't run
 * the on-device model. Tools drive THIS machine's real Chromium (via gb.js + CDP) and the cluster
 * (via the control channel), so the agent acts on the user's own logged-in browser.
 */
object Agent {
    private val cfg = File(System.getProperty("user.home"), ".ghostbrowser/agent.properties")

    fun load(): Triple<String, String, String> = try {
        val p = java.util.Properties(); if (cfg.exists()) cfg.inputStream().use { p.load(it) }
        Triple(p.getProperty("endpoint", ""), p.getProperty("apiKey", ""), p.getProperty("model", "llama3.1"))
    } catch (e: Exception) { Triple("", "", "llama3.1") }

    fun save(endpoint: String, apiKey: String, model: String) = try {
        val p = java.util.Properties(); p.setProperty("endpoint", endpoint); p.setProperty("apiKey", apiKey); p.setProperty("model", model)
        cfg.parentFile?.mkdirs(); cfg.outputStream().use { p.store(it, "gb agent") }
    } catch (e: Exception) {}

    /**
     * WHAT THIS MACHINE CAN DO, told to the agent.
     *
     * This list used to stop at click/type/scroll while the machine underneath could click at a
     * coordinate, drag, and put a local file into a page input — those lived privately inside
     * DesktopNode, reachable only by the ring. So a CapCut edit handed to this desktop could not be
     * performed by the agent sitting in front of the very browser that could do it. They are in
     * Hands now, and they are offered here.
     *
     * The order matters a little: a canvas app is driven by looking and then pointing, so screenshot
     * and click_xy are described in terms of each other.
     */
    private fun toolCatalogue(): List<ToolSpec> = listOf(
        ToolSpec("browser_read", "read the active tab {url,title,elements:[{i,tag,type,text}],text} — use before click/type"),
        ToolSpec("browser_navigate", "{url}: open a url in the active tab"),
        ToolSpec("browser_click", "{index}: click element i from browser_read"),
        ToolSpec("browser_click_text", "{text}: click the element whose text/label contains this"),
        ToolSpec("browser_posts", "read the post-like text blocks of a feed (Facebook groups etc.)"),
        ToolSpec("browser_type", "{index,text}: type into element i"),
        ToolSpec("browser_scroll", "{dy}: scroll the page"),
        ToolSpec("screenshot", "a picture of the tab, base64 PNG — the ONLY way to see a canvas (a video timeline, a crop box), and what you aim click_xy and drag at"),
        ToolSpec("click_xy", "{x,y}: click at a point in DEVICE PIXELS as the screenshot shows them — for canvases and toolbars that browser_read cannot see"),
        ToolSpec("drag", "{fromX,fromY,toX,toY}: press, move and release — drags a clip onto a timeline, trims an edge, moves a box. Real pointer input, so it works on a canvas"),
        ToolSpec("upload_file", "{path}: put a LOCAL file into the page's file input (open the page's upload control first). No file dialog is involved"),
        ToolSpec("download_url", "{url,name}: save a url onto this machine and get back its local path — use it to fetch footage before upload_file"),
        ToolSpec("list_workflows", "your automations"),
        ToolSpec("run_workflow", "{id}: run an automation"),
        ToolSpec("list_devices", "connected device nodes"),
        ToolSpec("list_platforms", "the browser profiles/presets"),
    )

    /** THE OPERATOR on the cluster: "/op <goal>" starts an engineer-grade job inside Ghost Browser (reads
     *  what the browser did, changes the smallest wrong thing, runs and proves it); its steps stream into
     *  this chat as tool chips and the final DONE/BLOCKED line lands as the reply. "/say <text>" speaks
     *  into the running job. */
    @Volatile private var operatorJobId: String = ""
    private fun runOperatorJob(st: DesktopState, goal: String) {
        if (goal.isBlank()) { push(st, "assistant", "Tell the operator what to do — e.g. make a post watcher for my LinkedIn posts, or: why does the notifications watcher draft nothing?"); return }
        if (st.agentBusy.value) { push(st, "assistant", "The agent is still busy here. Wait for it to finish, then hand the operator its job."); return }
        push(st, "user", "⚙ $goal"); st.agentBusy.value = true
        thread(isDaemon = true) {
            try {
                val started = try { JSONObject(Cluster.authed("POST", "/v1/operator/jobs", JSONObject().put("goal", goal).toString())) } catch (e: Exception) { JSONObject().put("error", e.message ?: "no answer") }
                val jid = started.optString("id")
                if (jid.isBlank()) { push(st, "assistant", "⚠ the operator could not start: ${started.optString("error").ifBlank { "no answer from the cluster" }}"); return@thread }
                operatorJobId = jid; var lastT = 0L; var status = "running"; var idle = 0
                push(st, "assistant", "operator job $jid started — reading the machine…")
                while (status == "running" || status == "queued") {
                    Thread.sleep(6000)
                    val v = try { JSONObject(Cluster.authed("GET", "/v1/operator/jobs/$jid", null)) } catch (e: Exception) { if (++idle > 5) break else continue }
                    idle = 0; status = v.optString("status", "running")
                    val ev = v.optJSONArray("events") ?: org.json.JSONArray()
                    for (i in 0 until ev.length()) {
                        val e = ev.optJSONObject(i) ?: continue
                        val t = e.optLong("t", 0L); if (t <= lastT) continue; lastT = t
                        when (e.optString("kind")) {
                            "tool" -> pushTool(st, e.optString("name"), JSONObject().put("tool", e.optString("name")).put("args", e.opt("args") ?: "").toString())
                            "result" -> pushTool(st, e.optString("name"), e.optString("text"))
                            "thought" -> push(st, "assistant", e.optString("text"))
                        }
                    }
                }
                val v = try { JSONObject(Cluster.authed("GET", "/v1/operator/jobs/$jid", null)) } catch (e: Exception) { JSONObject() }
                val rep = v.optJSONObject("report")
                val evidence = rep?.opt("evidence")?.let { if (it is JSONObject) it.toString(2) else it.toString() } ?: ""
                push(st, "assistant", v.optString("finalLine").ifBlank { "the job ended: ${v.optString("status")}" } + (if (evidence.isNotBlank()) "\n\nEvidence: " + evidence.take(1200) else "") + (rep?.optString("lesson")?.takeIf { it.isNotBlank() }?.let { "\n\nLesson kept: $it" } ?: ""))
            } finally { operatorJobId = ""; st.agentBusy.value = false }
        }
    }
    private fun sayToOperator(st: DesktopState, text: String) {
        val jid = operatorJobId
        if (jid.isBlank()) { push(st, "assistant", "No operator job is running. Switch on Operator and give it a goal."); return }
        push(st, "user", "💬 $text")
        thread(isDaemon = true) { try { Cluster.authed("POST", "/v1/operator/jobs/$jid/say", JSONObject().put("text", text).toString()) } catch (e: Exception) { push(st, "assistant", "⚠ could not reach the job: ${e.message}") } }
    }
    private fun stopOperator(st: DesktopState) {
        val jid = operatorJobId
        if (jid.isBlank()) { push(st, "assistant", "No operator job is running."); return }
        push(st, "user", "⏹ stop")
        thread(isDaemon = true) { try { Cluster.authed("POST", "/v1/operator/jobs/$jid/stop", "{}") } catch (e: Exception) { push(st, "assistant", "⚠ could not reach the job: ${e.message}") } }
    }

    fun send(st: DesktopState, main: CefBrowser?, text: String) {
        val t = text.trim()
        // The Operator switch sends every message as "/op": a new job, or — while one runs — spoken into it.
        if (t.startsWith("/op ") || t == "/op") { val g = t.removePrefix("/op").trim(); if (operatorJobId.isNotBlank()) sayToOperator(st, g) else runOperatorJob(st, g); return }
        if (t.startsWith("/say ")) { sayToOperator(st, t.removePrefix("/say").trim()); return }
        if (t == "/stop") { stopOperator(st); return }
        if (st.agentBusy.value) return
        // Cloud (default) uses the cluster's LLM via the control channel — no key needed. A custom
        // self-hosted endpoint+key overrides.
        val ep = st.endpoint.value.trim()
        val custom = ep.isNotBlank() && st.apiKey.value.isNotBlank() && !ep.contains("ollama.com")
        push(st, "user", text)
        st.agentBusy.value = true
        thread(isDaemon = true) {
            /*
             * ONE LOOP, IN shared/. This was a copy of the phone's: same JSON-per-turn protocol, same
             * reply-or-tool handling, same turn budget — and the two had already drifted, most visibly
             * in the tool list. AgentCore holds the loop; what a device brings is declared below, and
             * nothing else differs.
             *
             * The budget is AgentCore's 24 rather than the old 12: a video edit is a dozen actions
             * before anything is even on the timeline, and stopping at 12 was why a real edit ended in
             * a report about the editor.
             */
            try { AgentCore.run(desktopHost(st, main)) }
            finally { st.agentBusy.value = false }
        }
    }

    /** What this desktop brings to the shared agent: its name, its tools, its tab, its model. */
    private fun desktopHost(st: DesktopState, main: CefBrowser?): AgentHost = object : AgentHost {
        override val deviceNoun = "desktop"
        override fun tools() = toolCatalogue()
        override fun liveContext(): String {
            val url = try { main?.url ?: "" } catch (e: Exception) { "" }
            return "CURRENT TAB: ${url.ifBlank { "(home)" }} — a real Chromium tab on this machine, " +
                "probably already signed in."
        }
        override fun runTool(name: String, argsJson: String): String {
            val a = try { JSONObject(argsJson) } catch (e: Exception) { JSONObject() }
            return this@Agent.runTool(name, a, main, st)
        }
        override fun chat(system: String, user: String): String {
            val ep = st.endpoint.value.trim()
            val custom = ep.isNotBlank() && st.apiKey.value.isNotBlank() && !ep.contains("ollama.com")
            return if (custom) this@Agent.chat(ep, st.apiKey.value, st.model.value, system, user)
                   else chatCluster(system, user)
        }
        override fun push(role: String, text: String) = this@Agent.push(st, role, text)
        // This app shows a call and its result the same way, as two tool chips.
        override fun pushToolCall(name: String, argsJson: String) =
            this@Agent.pushTool(st, name, "{\"tool\":\"$name\",\"args\":$argsJson}")
        override fun pushToolResult(name: String, result: String) = this@Agent.pushTool(st, name, result)
        override fun transcript() = this@Agent.transcript(st)
    }

    /** Chat via the cluster's configured LLM (no key on this machine) over the control channel. */
    private fun chatCluster(system: String, user: String): String {
        val r = Cluster.authed("POST", "/v1/agent/chat", JSONObject().put("system", system).put("prompt", user).toString())
        val o = try { JSONObject(r) } catch (e: Exception) { throw RuntimeException("cluster chat: ${r.take(120)}") }
        val text = o.optString("text")
        if (text.isBlank()) throw RuntimeException(o.optString("error", "no model set on the cluster (set one in the GB console)"))
        return text
    }

    private fun push(st: DesktopState, role: String, content: String) { st.agentMsgs.value = st.agentMsgs.value + ChatMsg(role, content) }
    private fun pushTool(st: DesktopState, name: String, content: String) { st.agentMsgs.value = st.agentMsgs.value + ChatMsg("tool", content, name) }

    private fun transcript(st: DesktopState): String {
        val sb = StringBuilder()
        for (m in st.agentMsgs.value) when (m.role) {
            "user" -> sb.append("User: ").append(m.content).append("\n")
            "assistant" -> sb.append("Assistant: ").append(m.content).append("\n")
            "tool" -> sb.append("TOOL RESULT (").append(m.tool).append("): ").append(m.content).append("\n")
        }
        sb.append("Reply with ONE JSON object now.")
        return sb.toString()
    }

    private fun runTool(name: String, a: JSONObject, main: CefBrowser?, st: DesktopState): String {
        val m = main ?: return "{\"error\":\"no browser\"}"
        fun gb(expr: String) = Cef.evalJs(m, st.gbJs + "\n" + expr)
        return when (name) {
            "browser_read" -> "{\"info\":" + gb("JSON.stringify(window.__gb.info())").ifBlank { "{}" } + ",\"elements\":" + gb("JSON.stringify(window.__gb.mark())").ifBlank { "[]" } + ",\"text\":" + gb("JSON.stringify(window.__gb.text())").ifBlank { "\"\"" } + "}"
            "browser_posts" -> gb("JSON.stringify(window.__gb.posts())").ifBlank { "[]" }
            "browser_navigate" -> { m.loadURL(a.optString("url")); Thread.sleep(2800); "{\"url\":${jsonStr(m.url ?: a.optString("url"))}}" }
            "browser_click" -> gb("JSON.stringify(window.__gb.click(${a.optInt("index", -1)}))").ifBlank { "{}" }
            "browser_click_text" -> gb("JSON.stringify(window.__gb.clickText(${jsonStr(a.optString("text"))},${a.optInt("nth", 0)}))").ifBlank { "{}" }
            "browser_type" -> gb("JSON.stringify(window.__gb.type(${a.optInt("index", -1)},${jsonStr(a.optString("text"))}))").ifBlank { "{}" }
            "browser_scroll" -> gb("JSON.stringify(window.__gb.scroll(${a.optInt("dy", 600)}))").ifBlank { "{}" }
            /*
             * The same hands the ring drives this machine with. Offering them to the agent is the
             * point of Hands.kt: the agent in front of the browser can now do what the cluster could
             * already ask for remotely — see a canvas, point at it, drag on it, and import a file.
             */
            "screenshot" -> Hands.screenshot(m)
            "click_xy" -> Hands.clickXy(m, a.optDouble("x", 0.0), a.optDouble("y", 0.0))
            "drag" -> Hands.drag(
                m,
                a.optDouble("fromX", a.optDouble("x1", 0.0)), a.optDouble("fromY", a.optDouble("y1", 0.0)),
                a.optDouble("toX", a.optDouble("x2", 0.0)), a.optDouble("toY", a.optDouble("y2", 0.0)),
                a.optInt("steps", 14), a.optLong("holdMs", 60L),
            )
            "upload_file" -> Hands.uploadFile(m, a.optString("path"), a.optInt("nth", 0))
            "download_url" -> Hands.downloadUrl(a.optString("url"), a.optString("name")) { st.log(it) }
            "list_workflows" -> Cluster.authed("GET", "/v1/workflows", null)
            "run_workflow" -> Cluster.authed("POST", "/v1/workflows/${a.optString("id")}/run", "{}")
            "list_devices" -> Cluster.authed("GET", "/v1/device/list", null)
            "list_platforms" -> Cluster.authed("GET", "/v1/profiles/presets", null)
            else -> "{\"error\":${jsonStr("unknown tool $name")}}"
        }
    }

    /** OpenAI-compatible chat completion (works with Ollama's /v1, OpenAI, etc.). */
    private fun chat(endpoint: String, apiKey: String, model: String, system: String, user: String): String {
        val url = endpoint.trimEnd('/') + "/chat/completions"
        val body = JSONObject()
            .put("model", model)
            .put("stream", false)
            .put("messages", JSONArray()
                .put(JSONObject().put("role", "system").put("content", system))
                .put(JSONObject().put("role", "user").put("content", user)))
            .toString()
        val c = java.net.URL(url).openConnection() as java.net.HttpURLConnection
        c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 15000; c.readTimeout = 120000
        c.setRequestProperty("Content-Type", "application/json")
        if (apiKey.isNotBlank()) c.setRequestProperty("Authorization", "Bearer $apiKey")
        c.outputStream.use { it.write(body.toByteArray()) }
        val text = (if (c.responseCode in 200..299) c.inputStream else c.errorStream).bufferedReader().use { it.readText() }
        return try { JSONObject(text).optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")?.optString("content") ?: text } catch (e: Exception) { text }
    }

    private fun extractJson(s: String): JSONObject? {
        val i = s.indexOf('{'); val j = s.lastIndexOf('}')
        if (i < 0 || j <= i) return null
        return try { JSONObject(s.substring(i, j + 1)) } catch (e: Exception) { null }
    }
}
