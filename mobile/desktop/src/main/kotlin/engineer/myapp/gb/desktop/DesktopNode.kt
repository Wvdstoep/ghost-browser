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
 * S8.2: register + poll + navigate/info/read/click/click_text/type/scroll/screenshot/eval.
 * S8.3: CDP drag, upload_file — done below. S8.4 (here): fetch a URL to disk, and run a goal on this
 * node, which is what lets the ring hand a whole job (a CapCut edit) over instead of driving every
 * click from the cluster. S9 retires Electron.
 */
class DesktopNode(
    private val active: () -> CefBrowser?,     // drive whichever tab is active
    private val deviceId: String,
    private val deviceName: String,
    private val gbJs: String,
    /*
     * RUN A GOAL ON THIS NODE. The ring's way of saying "this job is yours": the cluster sends the
     * goal, already filled in, and the on-device agent works it with THIS browser's own tools —
     * click_xy, drag, upload_file. Without it the cluster would have to drive every click over the
     * wire, and a CapCut edit is hundreds of them.
     */
    private val runGoal: (String) -> Unit = {},
    private val log: (String) -> Unit,
) {
    private val main: CefBrowser get() = active() ?: throw IllegalStateException("no active tab")
    @Volatile private var stopped = false
    @Volatile var registered = false; private set

    /*
     * WHAT THIS NODE CAN DO — read off execPath below, and kept beside it.
     *
     * The ring believes this list (see missesFor in the cluster's device-hub): it picks a device for a
     * run by matching a role's stated requirements against these names. So a name here that execPath
     * does not handle sends work to a machine that cannot do it, instead of to one that can — worse
     * than saying nothing. Add a branch below, add its name here; never the other way round.
     *
     * "download" was listed and has never existed; it is gone. cdp stays true and is accurate: input
     * goes through Input.dispatchMouseEvent and uploads through DOM.setFileInputFiles. What this node
     * does NOT have is drag INTERCEPTION (Input.setInterceptDrags), so a true HTML5-draggable element
     * cannot be dropped here — dragXY is a compositor press/move/release, which is exactly right for a
     * canvas like the CapCut timeline and wrong for a library card that sets a dataTransfer.
     */
    private val caps = JSONObject()
        .put("platform", "desktop").put("cdp", true).put("model", false).put("realIp", false)
        .put("features", listOf(
            "navigate", "info", "analyze", "content", "click_text", "click", "type", "scroll",
            "screenshot", "eval", "info_device", "click_xy", "drag", "upload_file",
            "download_url", "run_goal"))
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
            "/v1/screenshot" -> Hands.screenshot(main)
            "/v1/eval" -> Cef.evalJs(main, gbJs + "\n(function(){try{return JSON.stringify((" + body.optString("code") + "))}catch(e){return JSON.stringify({error:String(e)})}})()").ifBlank { "{}" }
            "/v1/info_device" -> "{\"platform\":\"desktop\",\"name\":${jsonStr(deviceName)}}"
            /*
             * These four live in Hands, shared with the on-device agent. They used to be private
             * here, which meant only the ring could use them: the agent in front of this very
             * browser was never offered a drag or an upload, so a CapCut edit handed to this machine
             * could not be carried out by the thing standing closest to it.
             */
            "/v1/click_xy" -> Hands.clickXy(main, body.optDouble("x", 0.0), body.optDouble("y", 0.0))
            "/v1/drag" -> Hands.drag(
                main,
                body.optDouble("fromX", body.optDouble("x1", 0.0)), body.optDouble("fromY", body.optDouble("y1", 0.0)),
                body.optDouble("toX", body.optDouble("x2", 0.0)), body.optDouble("toY", body.optDouble("y2", 0.0)),
                body.optInt("steps", 14), body.optLong("holdMs", 60L),
            )
            "/v1/upload_file" -> Hands.uploadFile(main, body.optString("path"), body.optInt("nth", 0))
            "/v1/download_url" -> Hands.downloadUrl(body.optString("url"), body.optString("name"), log)
            "/v1/run_goal" -> {
                /*
                 * Acknowledged at once, deliberately. A CapCut edit is minutes of work and the poll
                 * that delivered this command must not be held open for it — the node would stop
                 * answering the ring while it worked. The agent reports its own progress.
                 */
                val goal = body.optString("goal")
                if (goal.isBlank()) "{\"error\":\"goal required\"}"
                else { log("▶ ring handed us a goal (${goal.length} chars)"); runGoal(goal); "{\"started\":true}" }
            }
            else -> "{\"error\":${jsonStr("unknown path $path")}}"
        }
    }

    /*
     * The CapCut-critical primitives moved to Hands.kt, so the on-device agent can use the same ones
     * this node does. They were private here, and that is precisely why the agent's tool list stopped
     * at click/type/scroll while the machine underneath could drag and upload.
     */

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
