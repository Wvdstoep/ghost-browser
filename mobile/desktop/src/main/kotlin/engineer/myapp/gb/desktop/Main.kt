package engineer.myapp.gb.desktop

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.ArrowForward
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import engineer.myapp.gb.shared.Brand
import engineer.myapp.gb.shared.BrandOn
import engineer.myapp.gb.shared.GbScaffold
import engineer.myapp.gb.shared.GbTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.cef.browser.CefBrowser
import java.io.File
import java.net.InetAddress
import java.util.UUID
import javax.swing.JFrame
import javax.swing.SwingUtilities

/**
 * The Ghost Browser desktop app — SAME design system + scaffold as the phone (from :shared), now with
 * real Chromium (JCEF) AND a control channel that lets the cluster/ring drive it as a node (S8).
 */
fun main() {
    // Any startup crash (esp. in a packaged app with no console) lands here so we can read the reason.
    Thread.setDefaultUncaughtExceptionHandler { _, e -> writeCrash(e) }
    try { runApp() } catch (e: Throwable) { writeCrash(e); throw e }
}

private fun writeCrash(e: Throwable) {
    try {
        val f = File(System.getProperty("user.home"), ".ghostbrowser/error.log")
        f.parentFile?.mkdirs()
        f.appendText("[" + java.util.Date() + "] " + e.toString() + "\n" + e.stackTraceToString() + "\n\n")
    } catch (_: Throwable) {}
}

private fun runApp() = application {
    var mainBrowser by remember { mutableStateOf<CefBrowser?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val state = remember { DesktopState() }

    LaunchedEffect(Unit) {
        try {
            withContext(Dispatchers.IO) { Cef.ensureApp() }               // first run downloads Chromium
            val client = Cef.client()
            val mb = client.createBrowser("https://my-app.engineer", false, false)
            mainBrowser = mb
            val clusterUrl = "https://ghost-browser.mavicpro-fan.my-app.engineer"
            val control = client.createBrowser(clusterUrl, false, false)
            // Realize the control browser off-screen so it actually loads the GB origin (shares the SSO
            // cookie the user signs in with on the visible browser).
            SwingUtilities.invokeLater {
                JFrame("gb-control").apply {
                    isUndecorated = true; setSize(1, 1); setLocation(-4000, -4000)
                    add(control.uiComponent); isVisible = true
                }
                try { control.createImmediately() } catch (e: Throwable) {}   // ensure the native browser (+ devtools) comes up
            }
            Cluster.control = control
            Cluster.clusterUrl = clusterUrl
            val gbJs = readResourceText("/gb.js")
            state.gbJs = gbJs
            val (ep, key, model) = Agent.load()
            state.endpoint.value = ep; state.apiKey.value = key; state.model.value = model
            withContext(Dispatchers.IO) { Thread.sleep(1500) }
            DesktopNode(mb, deviceId(), hostName(), gbJs) { line -> println(line); state.log(line) }.start()
        } catch (e: Throwable) { error = e.message ?: "failed to start" }
    }

    Window(onCloseRequest = ::exitApplication, title = "Ghost Browser", state = rememberWindowState(width = 1200.dp, height = 820.dp)) {
        GbTheme(dark = state.dark.value) { DesktopShell(mainBrowser, error, state) }
    }
}

@Composable
private fun DesktopShell(mainBrowser: CefBrowser?, error: String?, state: DesktopState) {
    val cs = MaterialTheme.colorScheme
    var screen by remember { mutableStateOf("browser") }
    var atHome by remember { mutableStateOf(false) }
    val openUrl: (String) -> Unit = { u -> atHome = false; mainBrowser?.loadURL(u); screen = "browser" }
    GbScaffold(
        host = if (screen == "browser") (mainBrowser?.url?.let { hostOf(it) } ?: "my-app.engineer") else "",
        tabCount = 1, selected = if (screen == "devices") "settings" else screen,
        onFocusUrl = {}, onOpenSwitcher = {}, onOpenMenu = {}, onNav = { screen = it },
        showTopBar = false,     // desktop uses its own BrowserBar
    ) {
        when (screen) {
            "browser" -> Column(Modifier.fillMaxSize()) {
                BrowserBar(mainBrowser, onHome = { atHome = true }, onNavigated = { atHome = false })
                if (atHome) HomePageD(state, onOpenUrl = { u -> atHome = false; mainBrowser?.loadURL(u) }, onSearch = { atHome = false })
                else JcefBrowserView(mainBrowser, error, Modifier.weight(1f).fillMaxWidth())
            }
            "flows" -> FlowsScreenD(state)
            "devices" -> DeviceHubScreenD(state)
            "settings" -> SettingsScreenD(state, openUrl) { screen = "devices" }
            "agent" -> AgentChatD(state, mainBrowser)
            else -> JcefBrowserView(mainBrowser, error, Modifier.fillMaxSize())
        }
    }
}

private fun hostOf(url: String): String = try { java.net.URI(url).host?.removePrefix("www.") ?: url } catch (e: Exception) { url }

/** Desktop browser navigation: home / back / forward / reload + an editable address bar (Enter to go). */
@Composable
private fun BrowserBar(browser: CefBrowser?, onHome: () -> Unit, onNavigated: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    var text by remember(browser?.url) { mutableStateOf(browser?.url ?: "") }
    fun go() {
        var u = text.trim(); if (u.isEmpty()) return
        if (!u.startsWith("http") && !u.startsWith("file:")) u = if (u.contains(".") && !u.contains(" ")) "https://$u" else "https://www.google.com/search?q=" + java.net.URLEncoder.encode(u, "UTF-8")
        onNavigated(); browser?.loadURL(u)
    }
    Surface(color = cs.surface, contentColor = cs.onSurface) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onHome) { Icon(Icons.Default.Home, "Home", tint = cs.onSurfaceVariant) }
            IconButton(onClick = { onNavigated(); browser?.goBack() }) { Icon(Icons.Default.ArrowBack, "Back", tint = cs.onSurfaceVariant) }
            IconButton(onClick = { onNavigated(); browser?.goForward() }) { Icon(Icons.Default.ArrowForward, "Forward", tint = cs.onSurfaceVariant) }
            IconButton(onClick = { browser?.reload() }) { Icon(Icons.Default.Refresh, "Reload", tint = cs.onSurfaceVariant) }
            Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(20.dp), modifier = Modifier.weight(1f).height(40.dp)) {
                Row(Modifier.padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    androidx.compose.foundation.text.BasicTextField(
                        value = text, onValueChange = { text = it }, singleLine = true, modifier = Modifier.weight(1f),
                        textStyle = androidx.compose.ui.text.TextStyle(color = cs.onSurface, fontSize = 14.sp),
                        cursorBrush = androidx.compose.ui.graphics.SolidColor(Brand),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                        keyboardActions = KeyboardActions(onGo = { go() }, onDone = { go() }),
                        decorationBox = { inner -> if (text.isEmpty()) Text("Search or type a URL", color = cs.onSurfaceVariant, fontSize = 14.sp); inner() },
                    )
                }
            }
        }
    }
}

private fun readResourceText(path: String): String =
    object {}.javaClass.getResourceAsStream(path)?.bufferedReader()?.use { it.readText() } ?: ""

private fun hostName(): String = try { InetAddress.getLocalHost().hostName } catch (e: Exception) { "Desktop" }

/** A stable per-install device id, persisted so the hub sees the same node across restarts. */
private fun deviceId(): String {
    val f = File(System.getProperty("user.home"), ".ghostbrowser/deviceId")
    return try {
        if (f.exists()) f.readText().trim().ifBlank { newId(f) } else newId(f)
    } catch (e: Exception) { UUID.randomUUID().toString().replace("-", "").take(24) }
}
private fun newId(f: File): String {
    val id = UUID.randomUUID().toString().replace("-", "").take(24)
    try { f.parentFile?.mkdirs(); f.writeText(id) } catch (e: Exception) {}
    return id
}
