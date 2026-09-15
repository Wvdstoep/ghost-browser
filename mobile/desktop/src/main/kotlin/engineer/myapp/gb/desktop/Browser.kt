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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import me.friwi.jcefmaven.CefAppBuilder
import me.friwi.jcefmaven.impl.progress.ConsoleProgressHandler
import org.cef.CefApp
import org.cef.CefClient
import org.cef.browser.CefBrowser
import java.awt.BorderLayout
import java.io.File
import javax.swing.JPanel

/**
 * S8 — real Chromium on the desktop via JCEF, embedded in Compose through a SwingPanel. This is the
 * engine that replaces Electron's Chromium; the drag / self-saving download / upload_file capabilities
 * migrate onto it next, each verified before Electron is retired (S9). JCEF's native binaries download
 * once on first launch into ~/.ghostbrowser/jcef.
 */
object Cef {
    @Volatile private var app: CefApp? = null

    /** Build (once) the CefApp — downloads the platform natives on first call. Runs off the UI thread. */
    fun ensureApp(): CefApp {
        app?.let { return it }
        synchronized(this) {
            app?.let { return it }
            val builder = CefAppBuilder()
            builder.setInstallDir(File(System.getProperty("user.home"), ".ghostbrowser/jcef"))
            builder.setProgressHandler(ConsoleProgressHandler())
            builder.cefSettings.apply {
                windowless_rendering_enabled = false
                cache_path = File(System.getProperty("user.home"), ".ghostbrowser/cache").absolutePath
                persist_session_cookies = true
            }
            val built = builder.build()
            app = built
            return built
        }
    }
}

/** A real Chromium view showing [url]. Shows a loading state while the natives download the first time. */
@Composable
fun JcefBrowser(url: String, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    var client by remember { mutableStateOf<CefClient?>(null) }
    var browser by remember { mutableStateOf<CefBrowser?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            val c = withContext(Dispatchers.IO) { Cef.ensureApp().createClient() }
            val b = c.createBrowser(url, false, false)
            client = c; browser = b
        } catch (e: Throwable) { error = e.message ?: "failed to start Chromium" }
    }
    DisposableEffect(Unit) {
        onDispose { runCatching { browser?.close(true) }; runCatching { client?.dispose() } }
    }

    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val b = browser
        when {
            error != null -> Text("Chromium error: $error", color = cs.error, fontSize = 13.sp)
            b == null -> {
                CircularProgressIndicator(color = Brand)
                Text("Starting Chromium… (first run downloads the engine)", color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.padding(top = 60.dp))
            }
            else -> SwingPanel(
                background = cs.background,
                modifier = Modifier.fillMaxSize(),
                factory = { JPanel(BorderLayout()).apply { add(b.uiComponent, BorderLayout.CENTER) } },
            )
        }
    }
}
