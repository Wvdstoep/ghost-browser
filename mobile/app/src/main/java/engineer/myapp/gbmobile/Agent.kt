package engineer.myapp.gbmobile

import org.json.JSONArray
import org.json.JSONObject

/** The device's own brain-in-a-loop: perceive the page (set-of-mark) -> ask the LLM for ONE action ->
 *  act -> repeat. Runs fully on-device with the user's own Ollama key; no cluster/master involved. */
class Agent(
    private val browser: DeviceBrowser,
    private val llm: Llm,
    private val log: (String) -> Unit,
    private val isStopped: () -> Boolean
) {
    interface DeviceBrowser {
        fun navigate(url: String): String
        fun evalGb(expr: String): String   // injects gb.js, evaluates, returns JSON-encoded result
    }

    private val system =
        "You are GB, an autonomous agent operating a real mobile web browser. Each turn you get the " +
        "current page and a numbered list of its interactive elements. Reply with EXACTLY ONE action as " +
        "compact JSON and NOTHING else (no prose, no markdown). Valid actions: " +
        "{\"action\":\"click\",\"index\":N,\"reason\":\"..\"} | " +
        "{\"action\":\"type\",\"index\":N,\"text\":\"..\",\"reason\":\"..\"} | " +
        "{\"action\":\"navigate\",\"url\":\"https://..\",\"reason\":\"..\"} | " +
        "{\"action\":\"scroll\",\"dy\":600,\"reason\":\"..\"} | " +
        "{\"action\":\"done\",\"reason\":\"..\"}. Choose the single best next step toward the GOAL. " +
        "Prefer filling fields then clicking the submit/continue button. Use done when the goal is met. " +
        "If the current URL/TITLE already satisfies the GOAL, reply done immediately. NEVER navigate to a " +
        "page you are already on, and never repeat the same navigation twice. A navigate url must be ONE " +
        "plain https URL — no quotes, spaces, code or expressions."

    fun run(goal: String, maxSteps: Int = 20) {
        try {
            val visited = HashMap<String, Int>()   // normalized url -> times we've tried to go there
            var garbage = 0                          // consecutive unusable model outputs
            for (step in 1..maxSteps) {
                if (isStopped()) { log("■ stopped"); return }
                Thread.sleep(900) // let the page settle

                val info = safeJson(browser.evalGb("window.__gb.info()"))
                val url = info.optString("url", "")
                val title = info.optString("title", "")
                val marks = try { JSONArray(browser.evalGb("window.__gb.mark()")) } catch (e: Exception) { JSONArray() }
                val pageText = decode(browser.evalGb("window.__gb.text()")).take(1200)

                val els = StringBuilder()
                val n = minOf(marks.length(), 60)
                for (i in 0 until n) {
                    val o = marks.getJSONObject(i)
                    els.append(o.optInt("i")).append(": ").append(o.optString("tag"))
                    val t = o.optString("type"); if (t.isNotEmpty()) els.append("[").append(t).append("]")
                    val txt = o.optString("text"); if (txt.isNotEmpty()) els.append(" \"").append(txt).append("\"")
                    els.append("\n")
                }

                val user = "GOAL: $goal\nURL: $url\nTITLE: $title\nPAGE TEXT (truncated):\n$pageText\n\n" +
                        "ELEMENTS:\n$els\nReply with ONE JSON action."

                log("· step $step — thinking…")
                val reply = llm.chat(system, user)
                val act = extractJson(reply)
                if (act == null) { log("! could not parse: ${reply.take(120)}"); if (++garbage >= 3) { log("■ stopped — model output unusable"); return }; continue }

                val action = act.optString("action")
                val reason = act.optString("reason")
                when (action) {
                    "done" -> { log("✓ done — $reason"); return }
                    "navigate" -> {
                        val u = act.optString("url").trim()
                        if (!isCleanUrl(u)) { log("! ignored malformed url: ${u.take(60)}"); if (++garbage >= 3) { log("■ stopped — repeated malformed output"); return }; continue }
                        val norm = normUrl(u)
                        if (norm == normUrl(url)) {   // already there — don't reload, nudge toward an on-page action
                            val c = (visited[norm] ?: 0) + 1; visited[norm] = c
                            log("· already on ${hostOf(url)} — pick an on-page action or 'done'")
                            if (c >= 3) { log("■ stopped — stuck on the same page (goal may already be met)"); return }
                            continue
                        }
                        val c = (visited[norm] ?: 0) + 1; visited[norm] = c
                        if (c >= 3) { log("■ stopped — revisiting the same page in a loop (goal may already be met)"); return }
                        garbage = 0
                        log("→ navigate $u ($reason)"); browser.navigate(u)
                    }
                    "click" -> { garbage = 0; val i = act.optInt("index", -1); log("→ click $i ($reason)"); browser.evalGb("window.__gb.click($i)") }
                    "type" -> {
                        garbage = 0
                        val i = act.optInt("index", -1); val txt = act.optString("text")
                        log("→ type $i \"${txt.take(40)}\" ($reason)")
                        browser.evalGb("window.__gb.type($i,${JSONObject.quote(txt)})")
                    }
                    "scroll" -> { garbage = 0; val dy = act.optInt("dy", 600); log("→ scroll $dy ($reason)"); browser.evalGb("window.__gb.scroll($dy)") }
                    else -> log("! unknown action: $action")
                }
            }
            log("■ reached step limit")
        } catch (e: Exception) {
            log("! error: ${e.message}")
        }
    }

    private fun isCleanUrl(u: String): Boolean =
        (u.startsWith("http://") || u.startsWith("https://")) &&
        !u.contains(' ') && !u.contains('+') && !u.contains('"') &&
        !u.contains("document.") && !u.contains("encodeURI") && !u.contains("javascript:")

    private fun hostOf(u: String): String = try { java.net.URI(u).host ?: u } catch (e: Exception) { u }

    /** Normalize for loop detection: host without www./m., path without trailing slash, no query. */
    private fun normUrl(u: String): String = try {
        val uri = java.net.URI(u)
        val h = (uri.host ?: "").lowercase().removePrefix("www.").removePrefix("m.")
        h + (uri.path ?: "").trimEnd('/')
    } catch (e: Exception) { u.lowercase() }

    private fun safeJson(v: String): JSONObject = try { JSONObject(v) } catch (e: Exception) { JSONObject() }
    private fun decode(v: String): String = try { if (v.startsWith("\"")) JSONArray("[$v]").getString(0) else v } catch (e: Exception) { v }
    private fun extractJson(s: String): JSONObject? {
        val a = s.indexOf('{'); val b = s.lastIndexOf('}')
        if (a < 0 || b <= a) return null
        return try { JSONObject(s.substring(a, b + 1)) } catch (e: Exception) { null }
    }
}
