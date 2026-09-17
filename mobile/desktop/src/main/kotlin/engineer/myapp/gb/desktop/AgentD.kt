package engineer.myapp.gb.desktop

import engineer.myapp.gb.shared.ChatMsg
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

    private fun systemPrompt(main: CefBrowser?): String {
        val tools = listOf(
            "browser_read: read the active tab {url,title,elements:[{i,tag,type,text}],text} — use before click/type",
            "browser_navigate {url}: open a url in the active tab",
            "browser_click {index}: click element i from browser_read",
            "browser_click_text {text}: click the element whose text/label contains this",
            "browser_posts: read the post-like text blocks of a feed (Facebook groups etc.)",
            "browser_type {index,text}: type into element i",
            "browser_scroll {dy}: scroll the page",
            "list_workflows / run_workflow {id}: your automations",
            "list_devices / list_platforms",
        ).joinToString("\n") { "- $it" }
        val url = try { main?.url ?: "" } catch (e: Exception) { "" }
        return "You are the Ghost Browser agent running ON this desktop. You DRIVE the machine's own real, " +
            "logged-in Chromium tab. To check the user's accounts/pages, act on the ACTIVE TAB (browser_navigate " +
            "then browser_read/browser_posts). Reply each turn with EXACTLY ONE compact JSON object:\n" +
            "  {\"reply\":\"text\"}  — to talk/answer/report\n" +
            "  {\"tool\":\"<name>\",\"args\":{...}} — to act; you then get TOOL RESULT and continue\n" +
            "Be concise. Never invent tool results. CURRENT TAB: ${url.ifBlank { "(home)" }}\nTools:\n" + tools
    }

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
            try {
                val sys = systemPrompt(main)
                var turns = 0
                while (turns < 12) {
                    val reply = try { if (custom) chat(ep, st.apiKey.value, st.model.value, sys, transcript(st)) else chatCluster(sys, transcript(st)) }
                    catch (e: Exception) { push(st, "assistant", "⚠ model error: ${e.message}"); break }
                    val obj = extractJson(reply)
                    if (obj == null || (obj.isNull("reply") && !obj.has("tool"))) { push(st, "assistant", reply.trim().ifBlank { "(no reply)" }); break }
                    if (!obj.isNull("reply")) { push(st, "assistant", obj.optString("reply")); break }
                    val name = obj.optString("tool"); val args = obj.optJSONObject("args") ?: JSONObject()
                    pushTool(st, name, JSONObject().put("tool", name).put("args", args).toString())
                    var result = try { runTool(name, args, main, st) } catch (e: Exception) { "{\"error\":${jsonStr(e.message ?: "error")}}" }
                    if (result.length > 3500) result = result.take(3500) + "…"
                    pushTool(st, name, result)
                    turns++
                }
                if (turns >= 12) push(st, "assistant", "(stopped — too many steps; ask me to continue)")
            } finally { st.agentBusy.value = false }
        }
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
