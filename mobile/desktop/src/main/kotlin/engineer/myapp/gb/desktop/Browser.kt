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
                "--disable-features=CalculateNativeWinOcclusion",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-background-timer-throttling",
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
            sharedClient = c
            return c
        }
    }

    fun newBrowser(url: String): CefBrowser = client().createBrowser(url, false, false)

    /** One DevTools call → JSON result (blocking; call off the UI thread). Waits for the native browser
     *  + its DevTools client to come up (getDevToolsClient() is null until the browser is created). */
    fun cdp(browser: CefBrowser, method: String, paramsJson: String = "{}"): String {
        return try {
            var dt = browser.devToolsClient
            var n = 0
            while (dt == null && n < 40) { try { browser.createImmediately() } catch (_: Throwable) {}; Thread.sleep(300); dt = browser.devToolsClient; n++ }
            if (dt == null) return "{\"error\":\"devtools not ready\"}"
            dt.executeDevToolsMethod(method, paramsJson).get(30, TimeUnit.SECONDS) ?: "{}"
        } catch (e: Throwable) { "{\"error\":${jsonStr(e.message ?: "cdp error")}}" }
    }

    /** Evaluate JS in the page and get the string result back (Runtime.evaluate, awaits promises). */
    fun evalJs(browser: CefBrowser, expression: String): String {
        val params = "{\"expression\":${jsonStr(expression)},\"returnByValue\":true,\"awaitPromise\":true}"
        val raw = cdp(browser, "Runtime.evaluate", params)
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
                when (raw[j + 1]) { 'n' -> sb.append('\n'); 'r' -> sb.append('\r'); 't' -> sb.append('\t'); '"' -> sb.append('"'); '\\' -> sb.append('\\'); else -> sb.append(raw[j + 1]) }
                j += 2
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
