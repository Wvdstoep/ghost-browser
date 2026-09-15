package engineer.myapp.gb.desktop

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
fun main() = application {
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
            withContext(Dispatchers.IO) { Thread.sleep(1500) }
            DesktopNode(mb, deviceId(), hostName(), gbJs) { line -> println(line); state.log(line) }.start()
        } catch (e: Throwable) { error = e.message ?: "failed to start" }
    }

    Window(onCloseRequest = ::exitApplication, title = "Ghost Browser", state = rememberWindowState(width = 1200.dp, height = 820.dp)) {
        GbTheme(dark = true) { DesktopShell(mainBrowser, error, state) }
    }
}

@Composable
private fun DesktopShell(mainBrowser: CefBrowser?, error: String?, state: DesktopState) {
    val cs = MaterialTheme.colorScheme
    var screen by remember { mutableStateOf("browser") }
    val openUrl: (String) -> Unit = { u -> mainBrowser?.loadURL(u); screen = "browser" }
    GbScaffold(
        host = if (screen == "browser") (mainBrowser?.url?.let { hostOf(it) } ?: "my-app.engineer") else "",
        tabCount = 1, selected = if (screen == "devices") "settings" else screen,
        onFocusUrl = {}, onOpenSwitcher = {}, onOpenMenu = {}, onNav = { screen = it },
    ) {
        when (screen) {
            "browser" -> JcefBrowserView(mainBrowser, error, Modifier.fillMaxSize())
            "flows" -> FlowsScreenD(state)
            "devices" -> DeviceHubScreenD(state)
            "settings" -> Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().background(cs.surface).padding(horizontal = 20.dp, vertical = 8.dp)) {
                    TextButton(onClick = { screen = "devices" }) { Text("Open Device Hub") }
                }
                SettingsScreenD(state, openUrl)
            }
            else -> Box(Modifier.fillMaxSize().background(cs.background), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(Modifier.size(56.dp).background(Brand, androidx.compose.foundation.shape.RoundedCornerShape(16.dp)), contentAlignment = Alignment.Center) { Text("G", color = BrandOn, fontSize = 34.sp) }
                    Spacer(Modifier.height(16.dp))
                    Text("Agent chat lands next (LLM tool loop, drives this browser).", color = cs.onSurfaceVariant, fontSize = 15.sp)
                    Spacer(Modifier.height(6.dp))
                    Text(state.nodeStatus.value, color = cs.onSurfaceVariant, fontSize = 12.sp)
                }
            }
        }
    }
}

private fun hostOf(url: String): String = try { java.net.URI(url).host?.removePrefix("www.") ?: url } catch (e: Exception) { url }

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
