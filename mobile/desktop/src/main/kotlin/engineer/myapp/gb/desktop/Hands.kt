package engineer.myapp.gb.desktop

import org.cef.browser.CefBrowser
import org.json.JSONArray
import org.json.JSONObject

/**
 * THE HANDS OF THIS MACHINE — real mouse input, a file into a page, a file onto the disk.
 *
 * These lived inside DesktopNode, which meant only the RING could use them. The agent standing in
 * front of the same browser was never offered them: its tool list stopped at click/type/scroll, so a
 * CapCut edit handed to this machine could not be performed by the agent on it. One copy, two
 * callers — the node (driven by the cluster) and the on-device agent.
 *
 * All of it goes through CDP (`Cef.cdp`): Input.dispatchMouseEvent for the pointer and
 * DOM.setFileInputFiles for an upload, so no operating-system dialog is ever involved — there is
 * nobody to answer one.
 *
 * WHAT THESE HANDS CANNOT DO: drag INTERCEPTION (Input.setInterceptDrags). `drag` below is a
 * press → move → release on the compositor, which is the right mechanism for a canvas (a CapCut
 * timeline, a crop box) and the wrong one for a true HTML5-draggable element that sets a
 * dataTransfer. That distinction is why the capability record keeps `cdp` as a separate flag.
 */
object Hands {

    private fun mouseEvent(b: CefBrowser, type: String, x: Double, y: Double, buttons: Int = 1) {
        Cef.cdp(b, "Input.dispatchMouseEvent",
            "{\"type\":\"$type\",\"x\":$x,\"y\":$y,\"button\":\"left\",\"buttons\":$buttons,\"clickCount\":1}")
    }

    /** Click at a point in device pixels — the coordinates a screenshot shows. */
    fun clickXy(b: CefBrowser, x: Double, y: Double): String {
        Cef.cdp(b, "Input.dispatchMouseEvent", "{\"type\":\"mouseMoved\",\"x\":$x,\"y\":$y}")
        mouseEvent(b, "mousePressed", x, y); Thread.sleep(40); mouseEvent(b, "mouseReleased", x, y, 0)
        return "{\"ok\":true}"
    }

    /**
     * Press → move in steps → release.
     *
     * The dwell after the press is not padding: a React drag handler usually waits for a small
     * movement threshold or a long-press before it accepts a drag at all, and a single jump from
     * start to end looks like neither.
     */
    fun drag(b: CefBrowser, fromX: Double, fromY: Double, toX: Double, toY: Double,
             steps: Int = 14, holdMs: Long = 60): String {
        mouseEvent(b, "mouseMoved", fromX, fromY, 0)
        mouseEvent(b, "mousePressed", fromX, fromY)
        Thread.sleep(holdMs)
        val n = steps.coerceIn(2, 80)
        for (i in 1..n) {
            val x = fromX + (toX - fromX) * i / n
            val y = fromY + (toY - fromY) * i / n
            mouseEvent(b, "mouseMoved", x, y, 1)
            Thread.sleep(25)
        }
        Thread.sleep(holdMs)
        mouseEvent(b, "mouseReleased", toX, toY, 0)
        return "{\"ok\":true}"
    }

    /** Set a file input's file by CDP — no OS dialog, which nothing here could answer. */
    fun uploadFile(b: CefBrowser, path: String, nth: Int = 0): String {
        if (path.isBlank()) return "{\"error\":\"path required\"}"
        if (!java.io.File(path).isFile) return "{\"error\":${jsonStr("no file at $path")}}"
        return try {
            val rootId = JSONObject(Cef.cdp(b, "DOM.getDocument", "{\"depth\":0}"))
                .optJSONObject("root")?.optInt("nodeId") ?: return "{\"error\":\"no document\"}"
            val q = JSONObject(Cef.cdp(b, "DOM.querySelectorAll",
                "{\"nodeId\":$rootId,\"selector\":\"input[type=file]\"}")).optJSONArray("nodeIds") ?: JSONArray()
            if (q.length() == 0) return "{\"error\":\"no file input found — open the page's upload control first\"}"
            val nid = q.optInt(nth.coerceIn(0, q.length() - 1))
            Cef.cdp(b, "DOM.setFileInputFiles", "{\"files\":[${jsonStr(path)}],\"nodeId\":$nid}")
            "{\"ok\":true,\"input\":$nid}"
        } catch (e: Exception) { "{\"error\":${jsonStr(e.message ?: "upload failed")}}" }
    }

    /**
     * A URL onto this machine, returning the local path — the step that lets footage the cluster
     * holds be edited here.
     *
     * uploadFile needs a real filename, and a platform recording lives on the cluster's volume. A
     * relative path is resolved against the cluster origin the control channel already talks to, so
     * the cluster never has to know its own public address. Streamed, not buffered: these are videos,
     * and holding 120 MB in memory only to write it out again is how an import dies halfway.
     */
    fun downloadUrl(rawUrl: String, name: String, log: (String) -> Unit = {}): String {
        val raw = rawUrl.trim()
        if (raw.isBlank()) return "{\"error\":\"url required\"}"
        val url = if (raw.startsWith("http://") || raw.startsWith("https://")) raw
                  else Cluster.clusterUrl.trimEnd('/') + (if (raw.startsWith("/")) raw else "/$raw")
        val safe = name.ifBlank { "gb-" + System.currentTimeMillis() + ".bin" }
            .replace(Regex("[^\\w .-]+"), "_").take(80)
        return try {
            val dir = java.io.File(System.getProperty("user.home"), "Downloads/gb").apply { mkdirs() }
            val file = java.io.File(dir, safe)
            val conn = java.net.URI(url).toURL().openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 30_000
            conn.readTimeout = 20 * 60_000
            conn.inputStream.use { input -> java.io.FileOutputStream(file).use { out -> input.copyTo(out, 1 shl 16) } }
            if (file.length() == 0L) "{\"error\":\"saved nothing\"}"
            else {
                log("⬇ saved ${file.name} (${file.length() / 1_048_576} MB)")
                "{\"path\":${jsonStr(file.absolutePath)},\"bytes\":${file.length()}}"
            }
        } catch (e: Exception) { "{\"error\":${jsonStr(e.message ?: "download failed")}}" }
    }

    /** A screenshot as base64 PNG — the only way to see a canvas, and what click_xy aims at. */
    fun screenshot(b: CefBrowser): String {
        val shot = Cef.cdp(b, "Page.captureScreenshot", "{\"format\":\"png\"}")
        val data = try { JSONObject(shot).optString("data") } catch (e: Exception) { "" }
        return if (data.isBlank()) "{\"error\":\"screenshot failed\"}" else "{\"png_base64\":${jsonStr(data)}}"
    }
}
