package engineer.myapp.gbmobile

import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Ghost Browser API, on the device. An embedded HTTP server that turns the SAME calls the hosted
 * backend already speaks (navigate / analyze / click / type / content / screenshot) into actions on
 * the real on-device WebView — so the cluster/master can drive the phone for a hunt exactly like it
 * drives a server GB. Bound to 0.0.0.0 so it is reachable once the device is on the tailnet; every
 * /v1 call requires the device token.
 */
class GbServer(port: Int, private val token: String, private val browser: Browser) :
    NanoHTTPD("0.0.0.0", port) {

    interface Browser {
        fun navigate(url: String): String
        fun evalGb(expr: String): String      // injects gb.js then evaluates expr; returns JSON-encoded result
        fun screenshotPng(): ByteArray
        fun currentUrl(): String
    }

    private fun json(status: Response.Status, obj: String) =
        newFixedLengthResponse(status, "application/json", obj)

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        if (uri == "/healthz") return newFixedLengthResponse(Response.Status.OK, "text/plain", "ok")

        val auth = session.headers["authorization"] ?: ""
        if (auth != "Bearer $token") return json(Response.Status.UNAUTHORIZED, "{\"error\":\"unauthorized\"}")

        var body = JSONObject()
        if (session.method == Method.POST || session.method == Method.PUT) {
            try {
                val files = HashMap<String, String>()
                session.parseBody(files)
                val raw = files["postData"]
                if (!raw.isNullOrBlank()) body = JSONObject(raw)
            } catch (e: Exception) { /* empty / non-JSON body -> defaults */ }
        }

        return try {
            when (uri) {
                "/v1/info" -> json(Response.Status.OK, browser.evalGb("window.__gb.info()"))
                "/v1/content" -> newFixedLengthResponse(
                    Response.Status.OK, "text/plain; charset=utf-8", decodeJsString(browser.evalGb("window.__gb.text()")))
                "/v1/analyze" -> json(Response.Status.OK, browser.evalGb("window.__gb.mark()"))
                "/v1/navigate" -> {
                    val f = browser.navigate(body.optString("url"))
                    json(Response.Status.OK, "{\"ok\":true,\"url\":${JSONObject.quote(f)}}")
                }
                "/v1/click" -> json(Response.Status.OK,
                    "{\"result\":${browser.evalGb("window.__gb.click(${body.optInt("index", -1)})")}}")
                "/v1/type" -> json(Response.Status.OK,
                    "{\"result\":${browser.evalGb("window.__gb.type(${body.optInt("index", -1)}," + JSONObject.quote(body.optString("text")) + ")")}}")
                "/v1/scroll" -> json(Response.Status.OK,
                    "{\"result\":${browser.evalGb("window.__gb.scroll(${body.optInt("dy", 600)})")}}")
                "/v1/screenshot" -> newChunkedResponse(
                    Response.Status.OK, "image/png", browser.screenshotPng().inputStream())
                else -> json(Response.Status.NOT_FOUND, "{\"error\":\"no such route\"}")
            }
        } catch (e: Exception) {
            json(Response.Status.INTERNAL_ERROR, "{\"error\":${JSONObject.quote(e.message ?: "error")}}")
        }
    }

    // WebView.evaluateJavascript hands back JSON-encoded values; a returned JS string arrives wrapped
    // in quotes and escaped. Unwrap it for text/plain responses.
    private fun decodeJsString(v: String): String =
        try { if (v.startsWith("\"")) JSONArray("[$v]").getString(0) else v } catch (e: Exception) { v }
}
