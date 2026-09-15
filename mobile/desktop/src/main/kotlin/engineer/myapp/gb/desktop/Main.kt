package engineer.myapp.gb.desktop

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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

/**
 * The Ghost Browser desktop app — the SAME design system + scaffold as the phone, built from :shared.
 * Today it proves one codebase renders on desktop; in S8 the placeholder browser area becomes a real
 * JCEF Chromium view with the drag/download/upload capabilities the Electron node has now.
 */
fun main() = application {
    var dark by remember { mutableStateOf(true) }
    Window(onCloseRequest = ::exitApplication, title = "Ghost Browser", state = rememberWindowState(width = 1200.dp, height = 820.dp)) {
        GbTheme(dark = dark) { DesktopShell() }
    }
}

@Composable
private fun DesktopShell() {
    val cs = MaterialTheme.colorScheme
    var screen by remember { mutableStateOf("browser") }
    val homeUrl = "https://my-app.engineer"
    GbScaffold(
        host = if (screen == "browser") "my-app.engineer" else "",
        tabCount = 1,
        selected = screen,
        onFocusUrl = {},
        onOpenSwitcher = {},
        onOpenMenu = {},
        onNav = { screen = it },
    ) {
        if (screen == "browser") {
            JcefBrowser(homeUrl, Modifier.fillMaxSize())   // real Chromium (S8)
        } else Box(Modifier.fillMaxSize().background(cs.background), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.size(56.dp).background(Brand, androidx.compose.foundation.shape.RoundedCornerShape(16.dp)), contentAlignment = Alignment.Center) {
                    Text("G", color = BrandOn, fontSize = 34.sp)
                }
                Spacer(Modifier.height(16.dp))
                Text(
                    when (screen) {
                        "agent" -> "Agent — shared with the phone (wires up next)"
                        "flows" -> "Flows — shared with the phone (wires up next)"
                        else -> "Settings — shared with the phone (wires up next)"
                    },
                    color = cs.onSurfaceVariant, fontSize = 15.sp,
                )
                Spacer(Modifier.height(6.dp))
                Text("One codebase · phone + desktop", color = cs.onSurfaceVariant, fontSize = 12.sp)
            }
        }
    }
}
