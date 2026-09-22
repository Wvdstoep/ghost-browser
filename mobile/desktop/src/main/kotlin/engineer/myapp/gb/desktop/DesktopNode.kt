package engineer.myapp.gb.desktop

import org.cef.browser.CefBrowser
import org.json.JSONArray
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
    private val active: () -> CefBrowser?,     // drive whichever tab is active
    private val deviceId: String,
    private val deviceName: String,
    private val gbJs: String,
    private val log: (String) -> Unit,
) {
    private val main: CefBrowser get() = active() ?: throw IllegalStateException("no active tab")
    @Volatile private var stopped = false
    @Volatile var registered = false; private set

    /*
     * EXACTLY WHAT THIS FILE'S OWN DISPATCH HANDLES — read off the `when` below, nothing borrowed.
     *
     * The list is the contract the ring believes, so it is kept beside the dispatch it describes.
     * Add a "/v1/x" branch below, add "x" here; never the other way round. An advertisement the ring
     * believes is worse than silence, because it sends work here that cannot be done instead of to a
     * device that can.
     *
     * cdp is FALSE, and that is not modesty. dragXY below is a press → move → release on the
     * compositor, which is the right mechanism for a canvas (a CapCut timeline) and the wrong one for
     * an HTML5-draggable element: those need Input.setInterceptDrags, which only the Electron node
     * has. So cdp stays the flag that distinguishes the two, and a role needing a true HTML5 drop can
     * require it.
     */
    private val caps = JSONObject()
        .put("platform", "desktop").put("cdp", false).put("model", false).put("realIp", true)
        .put("features", listOf(
            "navigate", "info", "analyze", "content", "click_text", "click", "type", "scroll",
            "screenshot", "eval", "click_xy", "drag", "upload_file"))
        .toString()

    fun start() { Thread({ runLoop() }, "gb-desktop-node").apply { isDaemon = true }.start() }
    fun stop() { stopped = true }

    /** An authed cluster call (rides the control browser's session, on the GB origin). */
    private fun authed(method: String, path: String, body: String?): String = Cluster.authed(method, path, body)

    private fun runLoop() {
        var tries = 0
        while (!stopped) {                       // register (retries until the user is signed in + GB opened)
            val reg = authed("POST", "/v1/device/register",
                JSONObject().put("deviceId", deviceId).put("name", deviceName).put("caps", JSONObject(caps)).toString())
            if (reg.contains("\"ok\":true") || reg.contains("\"deviceId\"")) {
                registered = true; Cluster.connected = true
                log("● desktop node registered as \"$deviceName\""); break
            }
            log("node: register reply = " + reg.replace("\n", " ").take(160))
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
            "/v1/click_xy" -> { mouseClick(body.optDouble("x", 0.0), body.optDouble("y", 0.0)); "{\"ok\":true}" }
            "/v1/drag" -> dragXY(body)
            "/v1/upload_file" -> uploadFile(body.optString("path"), body.optInt("nth", 0))
            else -> "{\"error\":${jsonStr("unknown path $path")}}"
        }
    }

    /* ── S8.3 CapCut-critical primitives (CDP Input + DOM) ───────────────────────────────────── */

    private fun mouseEvent(type: String, x: Double, y: Double, buttons: Int = 1) {
        Cef.cdp(main, "Input.dispatchMouseEvent",
            "{\"type\":\"$type\",\"x\":$x,\"y\":$y,\"button\":\"left\",\"buttons\":$buttons,\"clickCount\":1}")
    }

    private fun mouseClick(x: Double, y: Double) {
        Cef.cdp(main, "Input.dispatchMouseEvent", "{\"type\":\"mouseMoved\",\"x\":$x,\"y\":$y}")
        mouseEvent("mousePressed", x, y); Thread.sleep(40); mouseEvent("mouseReleased", x, y, 0)
    }

    /** Press → move (several steps) → release: real drag on a canvas (CapCut timeline/box). */
    private fun dragXY(b: JSONObject): String {
        val fx = b.optDouble("fromX", b.optDouble("x1", 0.0)); val fy = b.optDouble("fromY", b.optDouble("y1", 0.0))
        val tx = b.optDouble("toX", b.optDouble("x2", 0.0)); val ty = b.optDouble("toY", b.optDouble("y2", 0.0))
        mouseEvent("mouseMoved", fx, fy, 0); mouseEvent("mousePressed", fx, fy); Thread.sleep(60)
        val steps = 14
        for (i in 1..steps) { val x = fx + (tx - fx) * i / steps; val y = fy + (ty - fy) * i / steps; mouseEvent("mouseMoved", x, y, 1); Thread.sleep(25) }
        Thread.sleep(60); mouseEvent("mouseReleased", tx, ty, 0)
        return "{\"ok\":true}"
    }

    /** Set a file input's file via CDP DOM (no OS file dialog) — the upload primitive. */
    private fun uploadFile(path: String, nth: Int): String {
        if (path.isBlank()) return "{\"error\":\"path required\"}"
        return try {
            val rootId = JSONObject(Cef.cdp(main, "DOM.getDocument", "{\"depth\":0}")).optJSONObject("root")?.optInt("nodeId") ?: return "{\"error\":\"no document\"}"
            val q = JSONObject(Cef.cdp(main, "DOM.querySelectorAll", "{\"nodeId\":$rootId,\"selector\":\"input[type=file]\"}")).optJSONArray("nodeIds") ?: JSONArray()
            if (q.length() == 0) return "{\"error\":\"no file input found\"}"
            val nid = q.optInt(nth.coerceIn(0, q.length() - 1))
            Cef.cdp(main, "DOM.setFileInputFiles", "{\"files\":[${jsonStr(path)}],\"nodeId\":$nid}")
            "{\"ok\":true,\"input\":$nid}"
        } catch (e: Exception) { "{\"error\":${jsonStr(e.message ?: "upload failed")}}" }
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
