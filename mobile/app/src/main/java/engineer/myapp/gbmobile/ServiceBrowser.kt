package engineer.myapp.gbmobile

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * THE CLUSTER'S BROWSER ON THIS PHONE, OWNED BY THE SERVICE — NOT BY THE SCREEN.
 *
 * The ring used the app's own WebView, which lives and dies with the Activity: swiped away there was no
 * browser at all, and reopened in the background it was never laid out (innerWidth 0, measured
 * 2026-10-31), so pages loaded but could not be read or clicked. This WebView sits in its own window,
 * held by GbService through "Display over other apps": fully transparent, never touchable, always the
 * size of the screen. It exists whatever the app is doing — open, in the background, swiped away, locked.
 *
 * It answers the same commands with the same shapes as MainActivity.runDeviceCommand, so the cluster
 * cannot tell which one ran them. Logged-in profiles still run in the app (their cookies live there).
 */
class ServiceBrowser(private val ctx: Context) {
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var web: WebView? = null            // the browser of the profile the current command names
    private val webs = HashMap<String, WebView>()          // one invisible browser per profile, created on first use
    @Volatile private var loadLatch: CountDownLatch? = null
    /** The address the browser last STARTED loading (onPageStarted), so a navigate can tell a new page from the old one. */
    @Volatile private var startedUrl: String = ""
    private val gbJs: String by lazy { try { ctx.assets.open("gb.js").bufferedReader().use { it.readText() } } catch (e: Exception) { "" } }

    /*
     * WHAT THE PAGE SAID. Measured 2026-11-19 (Product Hunt on the SM-F926B): a submit that "did nothing" could
     * only be debugged with a test page that logged its own events, because no tool showed the page's console
     * or its failed requests. WebView hands both to the app natively (no script in the page that a site could
     * notice), so each browser keeps the last ones and /v1/console returns them.
     */
    private val consoleLog = java.util.concurrent.ConcurrentHashMap<WebView, java.util.ArrayDeque<JSONObject>>()
    private fun note(w: WebView, o: JSONObject) {
        val q = consoleLog.getOrPut(w) { java.util.ArrayDeque() }
        synchronized(q) { q.addLast(o.put("t", System.currentTimeMillis())); while (q.size > 300) q.removeFirst() }
    }

    companion object {
        val PATHS = setOf("/v1/navigate", "/v1/info", "/v1/content", "/v1/analyze", "/v1/perceive", "/v1/click",
            "/v1/click_text", "/v1/type", "/v1/key", "/v1/scroll", "/v1/screenshot", "/v1/eval", "/v1/console")
    }

    private fun onMain(timeoutS: Long = 10, block: () -> Unit) {
        val l = CountDownLatch(1)
        main.post { try { block() } catch (e: Exception) {} finally { l.countDown() } }
        l.await(timeoutS, TimeUnit.SECONDS)
    }

    /*
     * THE PROFILE THE CALLER CHOSE, AS THE APP KNOWS IT. A session is opened in a profile ("default" = the
     * owner's main one, signed in with their Google account; "p_linkedin" and so on hold other logins), and
     * every command carries it. Each profile gets its own invisible browser on the app's own ProfileStore
     * profile of that name — the same cookies, logins and trust as that profile in the Ghost Browser app.
     * (A jar of its own made this browser a stranger to every shop: AliExpress answered its product clicks
     * with a human check the owner never saw in the app, measured 2026-10-31.)
     * False when the owner has not granted "Display over other apps".
     */
    fun ensure(profile: String = "default"): Boolean {
        val name = profile.ifBlank { "default" }
        webs[name]?.let { web = it; return true }
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(ctx)) return false
        var made: WebView? = null
        onMain {
            val w = WebView(ctx)
            if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                try {
                    androidx.webkit.ProfileStore.getInstance().getOrCreateProfile(name)
                    WebViewCompat.setProfile(w, name)
                } catch (e: Exception) { /* the built-in jar */ }
            }
            w.settings.javaScriptEnabled = true
            w.settings.databaseEnabled = true
            w.settings.domStorageEnabled = true
            w.settings.useWideViewPort = true
            w.settings.loadWithOverviewMode = true
            try { CookieManager.getInstance().setAcceptThirdPartyCookies(w, true) } catch (e: Exception) {}
            if (Build.VERSION.SDK_INT >= 26) try { w.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false) } catch (e: Exception) {}
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                try { WebViewCompat.addDocumentStartJavaScript(w, MainActivity.VISIBLE_JS, setOf("*")) } catch (e: Exception) {}
            }
            FrameBridge.attach(w, ctx)   // forms in frames of another site (Google's profile editor) — see FrameBridge
            w.webChromeClient = object : android.webkit.WebChromeClient() {
                override fun onConsoleMessage(m: android.webkit.ConsoleMessage?): Boolean {
                    if (m != null) note(w, JSONObject().put("kind", "console").put("level", m.messageLevel().name.lowercase())
                        .put("text", (m.message() ?: "").take(800)).put("source", (m.sourceId() ?: "").takeLast(160)).put("line", m.lineNumber()))
                    return true
                }
            }
            w.webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    startedUrl = url ?: ""
                    note(w, JSONObject().put("kind", "page").put("url", (url ?: "").take(400)))
                }
                override fun onPageFinished(view: WebView?, url: String?) { loadLatch?.countDown() }
                override fun onReceivedHttpError(view: WebView?, request: android.webkit.WebResourceRequest?, response: android.webkit.WebResourceResponse?) {
                    note(w, JSONObject().put("kind", "http").put("status", response?.statusCode ?: 0)
                        .put("url", (request?.url?.toString() ?: "").take(400)).put("main", request?.isForMainFrame == true))
                }
                override fun onReceivedError(view: WebView?, request: android.webkit.WebResourceRequest?, error: android.webkit.WebResourceError?) {
                    val desc = if (Build.VERSION.SDK_INT >= 23) (error?.description?.toString() ?: "") else ""
                    note(w, JSONObject().put("kind", "network").put("status", 0).put("error", desc.take(200))
                        .put("url", (request?.url?.toString() ?: "").take(400)).put("main", request?.isForMainFrame == true))
                }
                // Shops push their own app (aliexpress://…, intent://…) the moment a page loads; following that
                // replaced the page with "Web page not available" (measured 2026-10-31). Only the web is loaded.
                override fun shouldOverrideUrlLoading(view: WebView?, request: android.webkit.WebResourceRequest?): Boolean {
                    val scheme = request?.url?.scheme?.lowercase() ?: return false
                    return scheme != "http" && scheme != "https"
                }
            }
            val dm = ctx.resources.displayMetrics
            val type = if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                       else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
            val lp = WindowManager.LayoutParams(dm.widthPixels, dm.heightPixels, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT)
            lp.gravity = Gravity.TOP or Gravity.START
            lp.alpha = 0f   // invisible: the owner never sees it, the page still has a full-size layout
            (ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager).addView(w, lp)
            made = w
        }
        val w = made ?: return false
        webs[name] = w; web = w
        return true
    }

    fun close() {
        val all = webs.values.toList(); webs.clear(); web = null
        main.post {
            for (w in all) {
                try { (ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(w) } catch (e: Exception) {}
                try { w.destroy() } catch (e: Exception) {}
            }
        }
    }

    private fun evalJs(script: String, timeoutS: Long = 20): String {
        val w = web ?: return "null"
        val l = CountDownLatch(1); val out = arrayOfNulls<String>(1)
        main.post { try { w.evaluateJavascript(script) { v -> out[0] = v; l.countDown() } } catch (e: Exception) { l.countDown() } }
        l.await(timeoutS, TimeUnit.SECONDS)
        return out[0] ?: "null"
    }
    private fun evalGb(expr: String) = evalJs(gbJs + "\n" + expr)
    private val ops = FrameOps({ web }, { evalGb(it) }, { tap(it) })

    private fun waitSettle(maxMs: Long) {
        val deadline = System.currentTimeMillis() + maxMs
        while (System.currentTimeMillis() < deadline) {
            if (evalGb("window.__gb.ready()").contains("true")) { Thread.sleep(250); return }
            Thread.sleep(350)
        }
    }

    private fun currentUrl(): String {
        val h = arrayOfNulls<String>(1); onMain(3) { h[0] = web?.url }
        return h[0] ?: ""
    }

    /*
     * A NAVIGATE THAT ANSWERS WITH THE PAGE IT WAS ASKED FOR. Measured 2026-11-19: the first navigate of a new
     * session answered with the previous session's page (Product Hunt) and the requested app never got a
     * request. A profile's browser lives on between sessions, so its old page counted as loaded (a late
     * onPageFinished, a settled page). Now the load must have STARTED (onPageStarted) before the wait counts,
     * and a load that never starts is asked for once more.
     */
    private fun navigate(url: String): String {
        var u = url.trim(); if (u.isEmpty()) return currentUrl()
        if (!u.startsWith("http")) u = "https://$u"
        for (attempt in 0..1) {
            startedUrl = ""
            val l = CountDownLatch(1); loadLatch = l
            main.post { web?.loadUrl(u) }
            val until = System.currentTimeMillis() + 8000
            while (startedUrl.isEmpty() && System.currentTimeMillis() < until) Thread.sleep(100)
            if (startedUrl.isEmpty() && attempt == 0) continue   // the load never started: ask once more
            l.await(25, TimeUnit.SECONDS); Thread.sleep(400)
            waitSettle(6000)
            break
        }
        return currentUrl()
    }

    /** The page's console lines and failed requests after [since] (ms), oldest first. */
    private fun console(since: Long): String {
        val w = web ?: return "{\"entries\":[]}"
        val q = consoleLog[w] ?: return JSONObject().put("entries", org.json.JSONArray()).put("native", true).toString()
        val out = org.json.JSONArray()
        synchronized(q) { for (o in q) if (o.optLong("t") > since) out.put(o) }
        return JSONObject().put("entries", out).put("native", true).toString()
    }

    /** A real tap (trusted input) at an element's centre, mapped from CSS px to the view's px. */
    private fun tap(coordsJson: String): String {
        val c = try { JSONObject(if (coordsJson.startsWith("\"")) JSONObject("{\"v\":$coordsJson}").getString("v") else coordsJson) } catch (e: Exception) { return "{\"error\":\"badcoords\"}" }
        if (c.has("err")) return "{\"error\":" + JSONObject.quote(c.optString("err")) + "}"
        val w = web ?: return "{\"error\":\"no browser\"}"
        val iw = c.optDouble("iw", 0.0); val ih = c.optDouble("ih", 0.0)
        if (iw <= 0.0 || ih <= 0.0) return "{\"error\":\"nocoords\"}"
        onMain(5) {
            val x = (c.optDouble("x") * w.width / iw).toFloat(); val y = (c.optDouble("y") * w.height / ih).toFloat()
            val t = SystemClock.uptimeMillis()
            val down = MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, x, y, 0)
            val up = MotionEvent.obtain(t, t + 60, MotionEvent.ACTION_UP, x, y, 0)
            w.dispatchTouchEvent(down); w.dispatchTouchEvent(up); down.recycle(); up.recycle()
        }
        Thread.sleep(600)
        return "\"ok\""
    }

    private fun screenshot(): String {
        val holder = arrayOfNulls<String>(1)
        onMain(10) {
            val w = web ?: return@onMain
            if (w.width <= 0 || w.height <= 0) return@onMain
            // A full-resolution PNG of the whole screen was too heavy to send back in time (measured): scale
            // to at most 720 px wide and send a JPEG.
            val scale = minOf(1f, 720f / w.width)
            val b = Bitmap.createBitmap((w.width * scale).toInt().coerceAtLeast(1), (w.height * scale).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
            /* draw() paints the page in page coordinates: without moving the canvas by the scroll offset a
               scrolled page came back blank (measured 2026-11-19, Product Hunt scrolled down: pure white). */
            val canvas = Canvas(b); canvas.scale(scale, scale)
            canvas.translate(-w.scrollX.toFloat(), -w.scrollY.toFloat()); w.draw(canvas)
            val out = java.io.ByteArrayOutputStream()
            b.compress(Bitmap.CompressFormat.JPEG, 72, out); b.recycle()
            holder[0] = android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
        }
        return if (holder[0] == null) "{\"error\":\"no screenshot\"}" else "{\"jpeg_base64\":\"${holder[0]}\"}"
    }

    /** One ring command. Same paths, same answers as MainActivity.runDeviceCommand. */
    fun run(path: String, body: JSONObject): String = try {
        when (path) {
            "/v1/navigate" -> "{\"url\":" + JSONObject.quote(navigate(body.optString("url"))) + "}"
            "/v1/info" -> evalGb("window.__gb.info()")
            "/v1/content" -> { waitSettle(4000); ops.text() }
            "/v1/analyze" -> ops.analyze()
            "/v1/perceive" -> { waitSettle(6000); "{\"info\":${evalGb("window.__gb.info()")},\"elements\":${ops.analyze()},\"text\":${ops.text()}}" }
            "/v1/click" -> ops.click(body.optInt("index", -1))
            "/v1/click_text" -> ops.clickText(body.optString("text"), body.optInt("nth", 0))
            "/v1/type" -> ops.type(body.optInt("index", -1), body.optString("text"))
            "/v1/key" -> ops.key(body.optString("key"))
            "/v1/scroll" -> ops.scroll(body.optInt("dy", 600))
            "/v1/screenshot" -> screenshot()
            "/v1/eval" -> evalJs(gbJs + "\n(function(){try{return JSON.stringify((" + body.optString("code") + "))}catch(e){return JSON.stringify({error:String(e)})}})()")
            "/v1/console" -> console(body.optLong("since", 0L))
            else -> "{\"error\":\"unsupported\"}"
        }
    } catch (e: Exception) { "{\"error\":" + JSONObject.quote(e.message ?: "failed") + "}" }
}
