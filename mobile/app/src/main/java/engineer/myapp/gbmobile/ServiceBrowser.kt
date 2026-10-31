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
    @Volatile private var web: WebView? = null
    @Volatile private var loadLatch: CountDownLatch? = null
    private val gbJs: String by lazy { try { ctx.assets.open("gb.js").bufferedReader().use { it.readText() } } catch (e: Exception) { "" } }

    companion object {
        val PATHS = setOf("/v1/navigate", "/v1/info", "/v1/content", "/v1/analyze", "/v1/perceive", "/v1/click",
            "/v1/click_text", "/v1/type", "/v1/scroll", "/v1/screenshot", "/v1/eval")
    }

    private fun onMain(timeoutS: Long = 10, block: () -> Unit) {
        val l = CountDownLatch(1)
        main.post { try { block() } catch (e: Exception) {} finally { l.countDown() } }
        l.await(timeoutS, TimeUnit.SECONDS)
    }

    /** Create the window once. False when the owner has not granted "Display over other apps". */
    fun ensure(): Boolean {
        if (web != null) return true
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(ctx)) return false
        onMain {
            val w = WebView(ctx)
            w.settings.javaScriptEnabled = true
            w.settings.domStorageEnabled = true
            w.settings.useWideViewPort = true
            w.settings.loadWithOverviewMode = true
            try { CookieManager.getInstance().setAcceptThirdPartyCookies(w, true) } catch (e: Exception) {}
            if (Build.VERSION.SDK_INT >= 26) try { w.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false) } catch (e: Exception) {}
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                try { WebViewCompat.addDocumentStartJavaScript(w, MainActivity.VISIBLE_JS, setOf("*")) } catch (e: Exception) {}
            }
            w.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) { loadLatch?.countDown() }
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
            web = w
        }
        return web != null
    }

    fun close() {
        val w = web ?: return
        web = null
        main.post {
            try { (ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(w) } catch (e: Exception) {}
            try { w.destroy() } catch (e: Exception) {}
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

    private fun navigate(url: String): String {
        var u = url.trim(); if (u.isEmpty()) return currentUrl()
        if (!u.startsWith("http")) u = "https://$u"
        val l = CountDownLatch(1); loadLatch = l
        main.post { web?.loadUrl(u) }
        l.await(25, TimeUnit.SECONDS); Thread.sleep(400)
        waitSettle(6000)
        return currentUrl()
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
            val b = Bitmap.createBitmap(w.width, w.height, Bitmap.Config.ARGB_8888)
            w.draw(Canvas(b))
            val out = java.io.ByteArrayOutputStream()
            b.compress(Bitmap.CompressFormat.PNG, 90, out); b.recycle()
            holder[0] = android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
        }
        return if (holder[0] == null) "{\"error\":\"no screenshot\"}" else "{\"png_base64\":\"${holder[0]}\"}"
    }

    /** One ring command. Same paths, same answers as MainActivity.runDeviceCommand. */
    fun run(path: String, body: JSONObject): String = try {
        when (path) {
            "/v1/navigate" -> "{\"url\":" + JSONObject.quote(navigate(body.optString("url"))) + "}"
            "/v1/info" -> evalGb("window.__gb.info()")
            "/v1/content" -> { waitSettle(4000); evalGb("window.__gb.text()") }
            "/v1/analyze" -> evalGb("window.__gb.mark()")
            "/v1/perceive" -> { waitSettle(6000); "{\"info\":${evalGb("window.__gb.info()")},\"elements\":${evalGb("window.__gb.mark()")},\"text\":${evalGb("window.__gb.text()")}}" }
            "/v1/click" -> tap(evalGb("window.__gb.coords(${body.optInt("index", -1)})"))
            "/v1/click_text" -> tap(evalGb("window.__gb.coordsText(" + JSONObject.quote(body.optString("text")) + "," + body.optInt("nth", 0) + ")"))
            "/v1/type" -> evalGb("window.__gb.type(${body.optInt("index", -1)}," + JSONObject.quote(body.optString("text")) + ")")
            "/v1/scroll" -> evalGb("window.__gb.scroll(${body.optInt("dy", 600)})")
            "/v1/screenshot" -> screenshot()
            "/v1/eval" -> evalJs(gbJs + "\n(function(){try{return JSON.stringify((" + body.optString("code") + "))}catch(e){return JSON.stringify({error:String(e)})}})()")
            else -> "{\"error\":\"unsupported\"}"
        }
    } catch (e: Exception) { "{\"error\":" + JSONObject.quote(e.message ?: "failed") + "}" }
}
