package engineer.myapp.gbmobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Lightweight, on-device inspection of the active WebView. Network bodies and Chrome internals
 * are not exposed by Android WebView, so those panels show only page-visible diagnostics. */
@Composable
fun MobileDevTools(shell: ShellUi, act: ShellActions) {
    val cs = MaterialTheme.colorScheme
    var command by remember { mutableStateOf("") }
    val tabs = listOf("Elements", "Console", "Sources", "Network", "Performance", "Memory")
    Box(Modifier.fillMaxSize().background(Color(0x99000000)), contentAlignment = Alignment.BottomCenter) {
        Surface(color = cs.surface, contentColor = cs.onSurface, modifier = Modifier.fillMaxWidth().fillMaxHeight(0.72f)) {
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Developer tools", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    IconButton(onClick = { shell.devToolsOpen.value = false }) { Icon(Icons.Default.Close, "Close developer tools") }
                }
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                    tabs.forEach { tab ->
                        val selected = shell.devToolsTab.value == tab
                        Text(tab, color = if (selected) cs.primary else cs.onSurfaceVariant,
                            modifier = Modifier.clickable { shell.devToolsTab.value = tab; act.onDevToolsSelect(tab) }
                                .padding(horizontal = 14.dp, vertical = 10.dp), fontSize = 13.sp)
                    }
                }
                HorizontalDivider()
                if (shell.devToolsTab.value == "Console") {
                    Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(12.dp)) {
                        shell.devToolsLines.value.forEach { Text(it, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = cs.onSurface) }
                    }
                    Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(value = command, onValueChange = { command = it }, singleLine = true,
                            label = { Text("Run JavaScript in this tab") }, modifier = Modifier.weight(1f))
                        TextButton(onClick = { if (command.isNotBlank()) { act.onDevToolsEvaluate(command); command = "" } }) { Text("Run") }
                    }
                } else {
                    Text(when (shell.devToolsTab.value) {
                        "Network" -> "Page resource timings. Response bodies and headers are unavailable inside Android WebView."
                        "Memory" -> "Memory figures appear only when this WebView exposes them to the page."
                        else -> "Read-only snapshot of the active page."
                    }, color = cs.onSurfaceVariant, fontSize = 11.sp, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
                    Text(shell.devToolsOutput.value, fontFamily = FontFamily.Monospace, fontSize = 11.sp,
                        color = cs.onSurface, modifier = Modifier.weight(1f).fillMaxWidth()
                            .verticalScroll(rememberScrollState()).padding(12.dp))
                }
            }
        }
    }
}
