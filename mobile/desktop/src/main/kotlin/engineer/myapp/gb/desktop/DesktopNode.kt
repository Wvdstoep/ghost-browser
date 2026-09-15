package engineer.myapp.gb.desktop

import org.cef.browser.CefBrowser
import org.json.JSONObject

/**
 * S8 — the desktop as a drivable NODE. Mirrors the Electron node's control channel (register → poll →
 * result) and its /v1 command set, but on JCEF: authed cluster calls run as fetch() inside a hidden
 * control browser on the GB origin (same SSO session the user signs into), and commands execute on the
 * visible browser over CDP. The cluster/ring drives this exactly as it drives the Electron node today.
 *
 * S8.2 (here): register + poll + navigate/info/read/click/click_text/type/scroll/screenshot/eval.
 * S8.3 (next): CDP drag, self-saving downloads, upload_file — then CapCut end-to-end, then S9 retires Electron.
 */
class DesktopNode(
    private val main: CefBrowser,
    private val control: CefBrowser,
    private val deviceId: String,
    private val deviceName: String,
    private val gbJs: String,
    private val log: (String) -> Unit,
) {
    @Volatile private var stopped = false
    @Volatile var registered = false; private set

    private val caps = JSONObject()
        .put("platform", "desktop").put("cdp", true).put("model", false).put("realIp", false)
        .put("features", listOf("navigate", "click", "click_text", "type", "scroll", "screenshot", "eval"))
        .toString()

    fun start() { Thread({ runLoop() }, "gb-desktop-node").apply { isDaemon = true }.start() }
    fun stop() { stopped = true }

    /** An authed cluster call as a same-origin fetch inside the control browser (SSO session). */
    private fun authed(method: String, path: String, body: String?): String {
        val opt = StringBuilder("{method:").append(jsonStr(method)).append(",credentials:'include',headers:{'Content-Type':'application/json'}")
        if (body != null) opt.append(",body:").append(jsonStr(body))
        opt.append("}")
        return Cef.evalJs(control, "fetch(${jsonStr(path)},$opt).then(function(r){return r.text()})")
    }

    private fun runLoop() {
        while (!stopped) {                       // register (retries until the user is signed in)
            val reg = authed("POST", "/v1/device/register",
                JSONObject().put("deviceId", deviceId).put("name", deviceName).put("caps", JSONObject(caps)).toString())
            if (reg.contains("\"ok\":true") || reg.contains("\"deviceId\"")) { registered = true; log("● desktop node registered as \"$deviceName\""); break }
            Thread.sleep(4000)
        }
        while (!stopped) {                        // poll → run → result
            val cmd = try { authed("GET", "/v1/device/poll?deviceId=$deviceId", null) } catch (e: Exception) { Thread.sleep(2000); continue }
            if (cmd.isBlank() || cmd == "null") { continue }         // 204 (no command) → poll again
            val o = try { JSONObject(cmd) } catch (e: Exception) { continue }
            val id = o.optString("id"); val path = o.optString("path", "/v1/info"); val bodyO = o.optJSONObject("body") ?: JSONObject()
            val out = try { execPath(path, bodyO) } catch (e: Exception) { "{\"error\":${jsonStr(e.message ?: "error")}}" }
            authed("POST", "/v1/device/result", JSONObject().put("deviceId", deviceId).put("id", id).put("status", 200).put("body", out).toString())
            log("↺ ran $path")
        }
    }

    /** Run one command on the visible browser and return its JSON string result. */
    private fun execPath(path: String, body: JSONObject): String {
        fun gb(expr: String) = Cef.evalJs(main, gbJs + "\n" + expr)
        return when (path) {
            "/v1/navigate" -> { main.loadURL(body.optString("url")); Thread.sleep(2500); waitSettle(6000); "{\"url\":${jsonStr(main.url ?: body.optString("url"))}}" }
            "/v1/info" -> gb("JSON.stringify(window.__gb.info())").ifBlank { "{}" }
            "/v1/read", "/v1/analyze" -> "{\"info\":" + gb("JSON.stringify(window.__gb.info())").ifBlank { "{}" } + ",\"elements\":" + gb("JSON.stringify(window.__gb.mark())").ifBlank { "[]" } + ",\"text\":" + gb("JSON.stringify(window.__gb.text())").ifBlank { "\"\"" } + "}"
            "/v1/content" -> gb("JSON.stringify(window.__gb.text())").ifBlank { "\"\"" }
            "/v1/click_text" -> gb("JSON.stringify(window.__gb.clickText(${jsonStr(body.optString("text"))},${body.optInt("nth", 0)}))").ifBlank { "{}" }
            "/v1/click" -> gb("JSON.stringify(window.__gb.click(${body.optInt("index", -1)}))").ifBlank { "{}" }
            "/v1/type" -> gb("JSON.stringify(window.__gb.type(${body.optInt("index", -1)},${jsonStr(body.optString("text"))}))").ifBlank { "{}" }
            "/v1/scroll" -> gb("JSON.stringify(window.__gb.scroll(${body.optInt("dy", 600)}))").ifBlank { "{}" }
            "/v1/screenshot" -> {
                val shot = Cef.cdp(main, "Page.captureScreenshot", "{\"format\":\"png\"}")
                val data = try { JSONObject(shot).optString("data") } catch (e: Exception) { "" }
                if (data.isBlank()) "{\"error\":\"screenshot failed\"}" else "{\"png_base64\":${jsonStr(data)}}"
            }
            "/v1/eval" -> Cef.evalJs(main, gbJs + "\n(function(){try{return JSON.stringify((" + body.optString("code") + "))}catch(e){return JSON.stringify({error:String(e)})}})()").ifBlank { "{}" }
            "/v1/info_device" -> "{\"platform\":\"desktop\",\"name\":${jsonStr(deviceName)}}"
            // S8.3: the CapCut-critical primitives land next.
            "/v1/drag", "/v1/click_xy", "/v1/upload_file", "/v1/download" -> "{\"error\":\"not yet on the JCEF node (S8.3)\"}"
            else -> "{\"error\":${jsonStr("unknown path $path")}}"
        }
    }

    /** Wait for lazy content to settle (Facebook etc. fire load on a skeleton). Best-effort. */
    private fun waitSettle(maxMs: Int) {
        val end = System.currentTimeMillis() + maxMs
        var last = -1
        while (System.currentTimeMillis() < end) {
            val n = Cef.evalJs(main, "document.body?document.body.innerText.length:0").toIntOrNull() ?: 0
            if (n > 0 && n == last) return
            last = n; Thread.sleep(600)
        }
    }
}
