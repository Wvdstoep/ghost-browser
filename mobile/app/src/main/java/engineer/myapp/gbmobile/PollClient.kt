package engineer.myapp.gbmobile

import android.util.Base64
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * The reverse (poll) channel client. The phone can't be reached inbound, so it DIALS the cluster:
 * register -> long-poll for a command -> run it on the real WebView -> post the result. Authenticated
 * with the WebView's own SSO cookies, so it rides the session the user already established.
 */
class PollClient(
    private val base: String,
    private val deviceId: String,
    private val deviceName: String,
    private val cookie: () -> String,
    private val browser: Agent.DeviceBrowser,
    private val screenshot: () -> ByteArray,
    private val log: (String) -> Unit,
    private val isStopped: () -> Boolean
) {
    private val root = base.trim().trimEnd('/')

    fun run() {
        try {
            if (!register()) { log("! register failed — sign in first (Sign in SSO)"); return }
            log("● registered as \"$deviceName\" — waiting for commands from the cluster")
            var misses = 0
            while (!isStopped()) {
                val cmd = poll()
                if (cmd == null) { misses++; if (misses % 4 == 0) log("· idle (polling)"); continue }
                misses = 0
                handle(cmd)
            }
            log("■ disconnected from cluster")
        } catch (e: Exception) { log("! poll loop error: ${e.message}") }
    }

    private fun conn(path: String, method: String): HttpURLConnection {
        val c = URL(root + path).openConnection() as HttpURLConnection
        c.instanceFollowRedirects = false   // an SSO redirect should surface as 3xx, not a masked 200
        c.requestMethod = method
        c.connectTimeout = 15000
        c.setRequestProperty("Content-Type", "application/json")
        c.setRequestProperty("Accept", "application/json")
        // Mimic the in-WebView fetch that already works (the SSO proxy may check these).
        c.setRequestProperty("X-Requested-With", "XMLHttpRequest")
        c.setRequestProperty("Origin", root)
        c.setRequestProperty("Referer", "$root/")
        val ck = cookie(); if (ck.isNotBlank()) c.setRequestProperty("Cookie", ck)
        return c
    }

    private fun register(): Boolean {
        return try {
            val c = conn("/v1/device/register", "POST"); c.doOutput = true; c.readTimeout = 15000
            c.outputStream.use { it.write(JSONObject().put("deviceId", deviceId).put("name", deviceName).toString().toByteArray()) }
            val code = c.responseCode
            if (code in 200..299) return true
            val err = try { BufferedReader(InputStreamReader(c.errorStream ?: c.inputStream)).use { it.readText() } } catch (e: Exception) { "" }
            log("! register HTTP $code (cookieLen=${cookie().length}): ${err.replace(Regex("\\s+"), " ").take(160)}")
            false
        } catch (e: Exception) { log("! register threw: ${e.message}"); false }
    }

    private fun poll(): JSONObject? {
        return try {
            val c = conn("/v1/device/poll?deviceId=" + deviceId, "GET"); c.readTimeout = 30000
            val code = c.responseCode
            if (code == 204) return null
            if (code !in 200..299) { Thread.sleep(2000); return null }
            val t = BufferedReader(InputStreamReader(c.inputStream)).use { it.readText() }
            if (t.isBlank()) null else JSONObject(t)
        } catch (e: Exception) { Thread.sleep(1500); null }
    }

    private fun postResult(id: String, status: Int, body: String) {
        try {
            val c = conn("/v1/device/result", "POST"); c.doOutput = true; c.readTimeout = 15000
            val payload = JSONObject().put("deviceId", deviceId).put("id", id).put("status", status).put("body", body)
            c.outputStream.use { it.write(payload.toString().toByteArray()) }
            c.responseCode
        } catch (e: Exception) { log("! result post failed: ${e.message}") }
    }

    private fun handle(cmd: JSONObject) {
        val id = cmd.optString("id")
        val path = cmd.optString("path", "/v1/info")
        val body = cmd.optJSONObject("body") ?: JSONObject()
        try {
            val out: String = when (path) {
                "/v1/navigate" -> "{\"url\":" + JSONObject.quote(browser.navigate(body.optString("url"))) + "}"
                "/v1/analyze" -> browser.evalGb("window.__gb.mark()")
                "/v1/info" -> browser.evalGb("window.__gb.info()")
                "/v1/content" -> browser.evalGb("window.__gb.text()")
                "/v1/click" -> browser.evalGb("window.__gb.click(${body.optInt("index", -1)})")
                "/v1/type" -> browser.evalGb("window.__gb.type(${body.optInt("index", -1)}," + JSONObject.quote(body.optString("text")) + ")")
                "/v1/scroll" -> browser.evalGb("window.__gb.scroll(${body.optInt("dy", 600)})")
                "/v1/screenshot" -> "{\"png_base64\":\"" + Base64.encodeToString(screenshot(), Base64.NO_WRAP) + "\"}"
                else -> "{\"error\":\"unknown path\"}"
            }
            log("↺ ran ${path}")
            postResult(id, 200, out)
        } catch (e: Exception) { postResult(id, 500, "{\"error\":" + JSONObject.quote(e.message ?: "error") + "}") }
    }
}
