package engineer.myapp.gb.desktop

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.awt.SwingPanel
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import engineer.myapp.gb.shared.Brand
import me.friwi.jcefmaven.CefAppBuilder
import me.friwi.jcefmaven.impl.progress.ConsoleProgressHandler
import org.cef.CefApp
import org.cef.CefClient
import org.cef.browser.CefBrowser
import java.awt.BorderLayout
import java.io.File
import java.util.concurrent.TimeUnit
import javax.swing.JPanel

/**
 * Real Chromium (JCEF) for the desktop app. Besides rendering, this exposes the primitives the desktop
 * NODE needs to be driven by the cluster/ring: [cdp] (DevTools) and [evalJs] (JS with a return value),
 * so navigate / read / click / type / screenshot all run the same way the Electron node runs them.
 */
object Cef {
    @Volatile private var app: CefApp? = null
    @Volatile private var sharedClient: CefClient? = null
    private val installDir = File(System.getProperty("user.home"), ".ghostbrowser/jcef")

    /**
     * THE PAGE'S SCROLL, REPORTED BACK — so the chrome can get out of the way while reading.
     *
     * JCEF gives no JS-to-Kotlin channel on a plain CefClient: no message router is wired up here,
     * and DevTools is request/response, so nothing can PUSH an event to us. The console is the one
     * channel that already flows in the right direction, so the injected listener writes a line
     * with a prefix nothing else uses and the display handler below reads it and swallows it.
     */
    const val SCROLL_TAG = "__gbscroll:"

    /** (dy, atTop) from whichever page reported it. Set by the app; ignored until then. */
    @Volatile var onScroll: ((Int, Boolean) -> Unit)? = null

    /* Bumped whenever a tab's main frame changes address, so the address bar and the tab label
       show where the page really is after a redirect or a click (a sign-in lands on /feed/ while the
       bar still said my-app.engineer). Read in composition, so a bump redraws them. */
    val addressTick = androidx.compose.runtime.mutableStateOf(0)

    /**
     * Injected on every page. The throttling is in the JS deliberately: a scroll fires dozens of
     * times a second and each of those would otherwise cross the process boundary. Only movement
     * that has added up to something worth acting on is reported, and `capture` is on so a scroller
     * inside the page counts too.
     */
    val SCROLL_JS = """
        (function(){
          if (window.__gbScrollHooked) return; window.__gbScrollHooked = 1;
          var last = -1, acc = 0, t = 0;
          function pos(e){
            var n = (e && e.target && e.target !== document && e.target.scrollTop != null) ? e.target.scrollTop : null;
            if (n != null) return n;
            return window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
          }
          function report(e){
            var y = pos(e);
            if (last < 0) { last = y; return; }
            acc += (y - last); last = y;
            var now = Date.now();
            if (Math.abs(acc) < 12 && now - t < 80) return;
            t = now;
            console.log('$SCROLL_TAG' + Math.round(acc) + ',' + (y <= 2 ? 1 : 0));
            acc = 0;
          }
          document.addEventListener('scroll', report, true);
        })();
    """.trimIndent()

    fun ensureApp(): CefApp {
        app?.let { return it }
        synchronized(this) {
            app?.let { return it }
            val builder = CefAppBuilder()
            builder.setInstallDir(installDir)
            builder.setProgressHandler(ConsoleProgressHandler())
            builder.cefSettings.apply {
                windowless_rendering_enabled = false
                cache_path = File(System.getProperty("user.home"), ".ghostbrowser/cache").absolutePath
                persist_session_cookies = true
            }
            // Keep compositing alive when the window is unfocused/occluded/minimized — otherwise
            // Page.captureScreenshot returns 0 bytes on a background node (the CapCut e2e trap). These
            // flags let the node be driven headlessly-in-the-background while another app is on top.
            builder.addJcefArgs(
                /*
                 * ONE --disable-features, because Chromium honours only the last one it is given.
                 * site-per-process / IsolateOrigins: a login POST (LinkedIn's Sign in) moved the page
                 * into a NEW renderer process, and the windowed view inside Compose kept showing the
                 * old, dead surface: white, while the page underneath had loaded and could be read.
                 * One renderer per tab keeps the picture attached.
                 */
                "--disable-features=CalculateNativeWinOcclusion,site-per-process,IsolateOrigins",
                "--disable-site-isolation-trials",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-background-timer-throttling",
                /* NOT --disable-gpu: tried in 1.0.59 against a white window, and with it the browsers
                   were never created at all (no DevTools client), so the ring could not drive them. */
            )
            val built = builder.build()
            app = built
            return built
        }
    }

    fun client(): CefClient {
        sharedClient?.let { return it }
        synchronized(this) {
            sharedClient?.let { return it }
            val c = ensureApp().createClient()
            // Self-saving downloads: auto-continue to ~/Downloads with no Save-As dialog (like the
            // Electron node) — this is what lets the agent export CapCut videos unattended.
            c.addDownloadHandler(object : org.cef.handler.CefDownloadHandlerAdapter() {
                override fun onBeforeDownload(browser: CefBrowser?, item: org.cef.callback.CefDownloadItem?, suggestedName: String?, callback: org.cef.callback.CefBeforeDownloadCallback?): Boolean {
                    try {
                        val dir = File(System.getProperty("user.home"), "Downloads"); dir.mkdirs()
                        callback?.Continue(File(dir, suggestedName ?: ("download-" + System.currentTimeMillis())).absolutePath, false)
                    } catch (e: Throwable) {}
                    return true
                }
            })
            /* The scroll channel (see SCROLL_TAG): read the line, swallow it. Swallowing matters —
               it is our channel, not the page's output, and it would otherwise flood the console. */
            c.addDisplayHandler(object : org.cef.handler.CefDisplayHandlerAdapter() {
                override fun onAddressChange(browser: CefBrowser?, frame: org.cef.browser.CefFrame?, url: String?) {
                    if (frame?.isMain == true) addressTick.value = addressTick.value + 1
                }
                override fun onConsoleMessage(browser: CefBrowser?, level: org.cef.CefSettings.LogSeverity?,
                                              message: String?, source: String?, line: Int): Boolean {
                    val m = message ?: return false
                    if (!m.startsWith(SCROLL_TAG)) return false
                    try {
                        val parts = m.removePrefix(SCROLL_TAG).split(',')
                        onScroll?.invoke(parts[0].trim().toInt(), parts.getOrNull(1)?.trim() == "1")
                    } catch (e: Throwable) { /* a malformed report is not worth a crash */ }
                    return true
                }
            })
            /* Re-inject on every page: the listener lives in the page, so it is gone on navigation.
               onLoadEnd rather than onLoadStart, because the document has to exist to listen on. */
            c.addLoadHandler(object : org.cef.handler.CefLoadHandlerAdapter() {
                override fun onLoadEnd(browser: CefBrowser?, frame: org.cef.browser.CefFrame?, httpStatusCode: Int) {
                    /*
                     * WHICH GHOST BROWSER THIS MACHINE BELONGS TO is learned from where the person
                     * opens it, not hard-wired. The platform gives every account its own instance
                     * (ghost-browser.<tenant>.my-app.engineer); the app used to point at one of them
                     * for everybody, so a second account signed in fine, saw its own empty console,
                     * and the node registered nowhere. The console loads inside the platform's page
                     * (an iframe), so every frame is read, not only the main one.
                     */
                    try { Cluster.noticeOrigin(frame?.url ?: "") } catch (e: Throwable) {}
                    if (frame?.isMain != true) return
                    try { browser?.executeJavaScript(SCROLL_JS, browser.url ?: "", 0) } catch (e: Throwable) {}
                    /* A one-pixel resize and back: the windowed view re-attaches its native surface
                       on a resize, so a page that loaded behind a stale picture shows itself. */
                    val ui = try { browser?.uiComponent } catch (e: Throwable) { null }
                    if (ui != null) javax.swing.SwingUtilities.invokeLater {
                        try {
                            val w = ui.width; val h = ui.height
                            if (w > 1 && h > 1) { ui.setSize(w, h - 1); ui.setSize(w, h); ui.revalidate(); ui.repaint() }
                        } catch (e: Throwable) {}
                    }
                }
            })
            sharedClient = c
            return c
        }
    }

    fun newBrowser(url: String): CefBrowser = client().createBrowser(url, false, false)

    /** One DevTools call → JSON result (blocking; call off the UI thread). Waits for the native browser
     *  + its DevTools client to come up (getDevToolsClient() is null until the browser is created). */
    /*
     * A WAIT THAT FITS THE CALL. Every DevTools call waited 30 seconds, and the model's answer for a
     * device walk travels through one of them (Cluster.authed: a fetch in the console page). A slower
     * model (glm-5.2) on a long LinkedIn step answers after 30 s, so the walk died on its first turn,
     * twice, as "model error: cdp error": a timeout carries no message, and "cdp error" was the
     * fallback. A caller that waits on a model now says how long it may take, and a timeout says so.
     */
    fun cdp(browser: CefBrowser, method: String, paramsJson: String = "{}", timeoutSec: Long = 30): String {
        return try {
            var dt = browser.devToolsClient
            var n = 0
            while (dt == null && n < 40) { try { browser.createImmediately() } catch (_: Throwable) {}; Thread.sleep(300); dt = browser.devToolsClient; n++ }
            if (dt == null) return "{\"error\":\"devtools not ready\"}"
            dt.executeDevToolsMethod(method, paramsJson).get(timeoutSec, TimeUnit.SECONDS) ?: "{}"
        } catch (e: java.util.concurrent.TimeoutException) {
            "{\"error\":${jsonStr("$method took longer than ${timeoutSec}s")}}"
        } catch (e: Throwable) { "{\"error\":${jsonStr(e.message ?: "cdp error (${e.javaClass.simpleName})")}}" }
    }

    /** Evaluate JS in the page and get the string result back (Runtime.evaluate, awaits promises). */
    fun evalJs(browser: CefBrowser, expression: String, timeoutSec: Long = 30): String {
        val params = "{\"expression\":${jsonStr(expression)},\"returnByValue\":true,\"awaitPromise\":true}"
        val raw = cdp(browser, "Runtime.evaluate", params, timeoutSec)
        // raw = {"result":{"type":"string","value":"..."}} — pull out .result.value as a string
        return extractResultValue(raw)
    }
}

/** Minimal JSON string-escape (avoids a JSON lib in the desktop primitive layer). */
internal fun jsonStr(s: String): String {
    val sb = StringBuilder("\"")
    for (c in s) when (c) {
        '\\' -> sb.append("\\\\"); '"' -> sb.append("\\\"")
        '\n' -> sb.append("\\n"); '\r' -> sb.append("\\r"); '\t' -> sb.append("\\t")
        else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
    }
    return sb.append("\"").toString()
}

/** Pull result.value out of a Runtime.evaluate response, returning it as a plain string. */
private fun extractResultValue(raw: String): String {
    val key = "\"value\":"
    val i = raw.indexOf(key); if (i < 0) return raw
    var j = i + key.length
    while (j < raw.length && raw[j].isWhitespace()) j++
    if (j >= raw.length) return raw
    return if (raw[j] == '"') {                       // quoted string → unescape
        val sb = StringBuilder(); j++
        while (j < raw.length) {
            val c = raw[j]
            if (c == '\\' && j + 1 < raw.length) {
                /*
                 * \uXXXX MUST BE DECODED HERE. CDP escapes every non-ASCII character this way, and
                 * this used to fall through to "append whatever follows the backslash", which ate
                 * the backslash, appended the 'u', and left the four hex digits as text: a Polish
                 * gig read "rozwu00f3j" instead of "rozwój" and a watcher was called
                 * "Facebook u00b7 Post watcher". Display was the visible half; the dangerous half is
                 * that an offer edited in this UI would be saved back mangled.
                 *
                 * Appending each escape as its own UTF-16 unit is what makes surrogate pairs work:
                 * 😀 arrives as two escapes and reassembles into one emoji.
                 */
                if (raw[j + 1] == 'u' && j + 5 < raw.length) {
                    val hex = raw.substring(j + 2, j + 6)
                    val code = hex.toIntOrNull(16)
                    if (code != null) { sb.append(Char(code)); j += 6 }
                    else { sb.append(raw[j + 1]); j += 2 }     // malformed: keep it visible, do not guess
                } else {
                    when (raw[j + 1]) {
                        'n' -> sb.append('\n'); 'r' -> sb.append('\r'); 't' -> sb.append('\t')
                        'b' -> sb.append('\b'); 'f' -> sb.append('\u000C')
                        '"' -> sb.append('"'); '\\' -> sb.append('\\'); '/' -> sb.append('/')
                        else -> sb.append(raw[j + 1])
                    }
                    j += 2
                }
            } else if (c == '"') break else { sb.append(c); j++ }
        }
        sb.toString()
    } else {                                          // number/bool/object → take until the matching close
        val end = raw.indexOf(",\"", j).let { if (it < 0) raw.lastIndexOf('}') else it }
        raw.substring(j, end.coerceAtLeast(j)).trim().trimEnd('}').trim()
    }
}

/** The visible Chromium view. */
@Composable
fun JcefBrowserView(browser: CefBrowser?, error: String?, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        when {
            error != null -> Text("Chromium error: $error", color = cs.error, fontSize = 13.sp)
            browser == null -> {
                CircularProgressIndicator(color = Brand)
                Text("Starting Chromium… (first run downloads the engine)", color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.padding(top = 60.dp))
            }
            else -> SwingPanel(
                background = cs.background, modifier = Modifier.fillMaxSize(),
                factory = { JPanel(BorderLayout()).apply { add(browser.uiComponent, BorderLayout.CENTER) } },
            )
        }
    }
}
