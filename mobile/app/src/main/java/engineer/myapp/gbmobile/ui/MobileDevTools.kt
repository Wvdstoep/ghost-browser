package engineer.myapp.gbmobile.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val toolTabs = listOf("Elements", "Console", "Sources", "Network", "Performance", "Memory")

/** Page-visible diagnostics for the active WebView; Chrome internals still require remote DevTools. */
@Composable
fun MobileDevTools(shell: ShellUi, act: ShellActions) {
    val cs = MaterialTheme.colorScheme
    val context = LocalContext.current
    val compactHeight = LocalConfiguration.current.screenHeightDp < 620
    var expanded by remember(compactHeight) { mutableStateOf(compactHeight) }
    var filter by remember { mutableStateOf("") }
    var command by remember { mutableStateOf("") }
    val tab = shell.devToolsTab.value
    val rawLines = if (tab == "Console") shell.devToolsLines.value else shell.devToolsOutput.value.lines()
    val visibleLines = rawLines.withIndex().filter { filter.isBlank() || it.value.contains(filter, ignoreCase = true) }
    val lines = visibleLines.map { it.value }

    fun runCommand() {
        if (command.isNotBlank()) { act.onDevToolsEvaluate(command); command = "" }
    }

    fun copyOutput() {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Ghost Browser $tab", rawLines.joinToString("\n")))
        Toast.makeText(context, "$tab copied", Toast.LENGTH_SHORT).show()
    }

    Box(Modifier.fillMaxSize().background(Color(0xB8000000)), contentAlignment = Alignment.BottomCenter) {
        Surface(
            color = cs.surface, contentColor = cs.onSurface,
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
            border = BorderStroke(1.dp, cs.outline), shadowElevation = 18.dp,
            modifier = Modifier.fillMaxWidth().fillMaxHeight(if (expanded) 0.97f else 0.78f).imePadding(),
        ) {
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxWidth().padding(top = 8.dp), contentAlignment = Alignment.Center) {
                    Box(Modifier.size(width = 38.dp, height = 4.dp).clip(RoundedCornerShape(4.dp))
                        .background(cs.onSurfaceVariant.copy(alpha = 0.5f)))
                }
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 6.dp, top = 8.dp, bottom = 10.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Surface(color = cs.primary, shape = RoundedCornerShape(12.dp), modifier = Modifier.size(40.dp)) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(Icons.Outlined.Code, null, tint = cs.onPrimary, modifier = Modifier.size(22.dp))
                        }
                    }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Developer tools", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
                        Text("ACTIVE TAB  ·  ON-DEVICE", fontSize = 10.sp, fontWeight = FontWeight.Medium,
                            letterSpacing = 0.9.sp, color = cs.onSurfaceVariant)
                    }
                    ToolButton(if (expanded) Icons.Outlined.FullscreenExit else Icons.Outlined.Fullscreen,
                        if (expanded) "Restore panel" else "Expand panel") { expanded = !expanded }
                    ToolButton(Icons.Outlined.Close, "Close developer tools") { shell.devToolsOpen.value = false }
                }
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    toolTabs.forEach { item ->
                        val selected = tab == item
                        Surface(color = if (selected) cs.primary else cs.surfaceVariant,
                            contentColor = if (selected) cs.onPrimary else cs.onSurfaceVariant,
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.height(48.dp).clickable {
                                filter = ""; shell.devToolsTab.value = item; act.onDevToolsSelect(item)
                            }) {
                            Box(Modifier.padding(horizontal = 13.dp), contentAlignment = Alignment.Center) {
                                Text(item, fontSize = 12.sp,
                                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium)
                            }
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                HorizontalDivider(color = cs.outline)
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(tab, color = cs.onSurface, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                        Text(when (tab) {
                            "Console" -> "${shell.devToolsLines.value.size} events · live page messages"
                            "Elements" -> "Read-only document tree"
                            "Sources" -> "Current page HTML snapshot"
                            "Network" -> "Resource timing from this page"
                            "Performance" -> "Navigation and load timing"
                            else -> "JavaScript heap, when available"
                        }, color = cs.onSurfaceVariant, fontSize = 11.sp, maxLines = 1,
                            overflow = TextOverflow.Ellipsis)
                    }
                    if (tab == "Console") ToolButton(Icons.Outlined.DeleteOutline, "Clear console") {
                        shell.devToolsLines.value = emptyList()
                    } else ToolButton(Icons.Outlined.Refresh, "Refresh $tab") { act.onDevToolsSelect(tab) }
                    ToolButton(Icons.Outlined.ContentCopy, "Copy $tab") { copyOutput() }
                }
                OutlinedTextField(
                    value = filter, onValueChange = { filter = it }, singleLine = true,
                    placeholder = { Text("Filter ${tab.lowercase()}…", fontSize = 12.sp) },
                    leadingIcon = { Icon(Icons.Outlined.Search, null, modifier = Modifier.size(18.dp)) },
                    trailingIcon = { if (filter.isNotBlank()) IconButton(onClick = { filter = "" }) {
                        Icon(Icons.Outlined.Close, "Clear filter", modifier = Modifier.size(18.dp))
                    } },
                    shape = RoundedCornerShape(12.dp), textStyle = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).height(56.dp),
                )
                Spacer(Modifier.height(10.dp))
                Surface(color = cs.background, shape = RoundedCornerShape(14.dp),
                    border = BorderStroke(1.dp, cs.outline),
                    modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp)) {
                    when {
                        tab != "Console" && shell.devToolsOutput.value == "Loading…" ->
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(color = cs.secondary, modifier = Modifier.size(30.dp))
                            }
                        lines.isEmpty() || (tab != "Console" && lines.size == 1 && lines.first().isBlank()) ->
                            EmptyToolsState(tab, filter.isNotBlank(), cs.secondary, cs.onSurfaceVariant)
                        tab == "Console" -> ConsoleLines(lines, cs.onSurface, cs.onSurfaceVariant, cs.outline,
                            cs.secondary, cs.error)
                        else -> SourceLines(visibleLines, cs.onSurface, cs.onSurfaceVariant, cs.outline)
                    }
                }
                if (tab == "Console") {
                    Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("›", color = cs.secondary, fontSize = 25.sp, fontFamily = FontFamily.Monospace,
                            modifier = Modifier.padding(end = 8.dp))
                        OutlinedTextField(value = command, onValueChange = { command = it }, singleLine = true,
                            placeholder = { Text("Evaluate JavaScript", fontSize = 12.sp) },
                            shape = RoundedCornerShape(12.dp), modifier = Modifier.weight(1f).height(56.dp),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                            keyboardActions = KeyboardActions(onSend = { runCommand() }),
                            textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
                        Spacer(Modifier.width(8.dp))
                        Button(onClick = { runCommand() },
                            enabled = command.isNotBlank(), shape = RoundedCornerShape(12.dp),
                            contentPadding = PaddingValues(horizontal = 16.dp), modifier = Modifier.height(52.dp)) {
                            Text("Run")
                        }
                    }
                } else {
                    Text(if (tab == "Network") "Timing only · response bodies and headers need remote inspection"
                        else if (tab == "Memory") "Heap values depend on WebView support"
                        else "Snapshot from the active page",
                        color = cs.onSurfaceVariant, fontSize = 10.sp,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp))
                }
            }
        }
    }
}

@Composable
private fun ToolButton(icon: ImageVector, label: String, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(48.dp)) {
        Icon(icon, label, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun EmptyToolsState(tab: String, filtered: Boolean, accent: Color, muted: Color) {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(if (filtered) Icons.Outlined.Search else Icons.Outlined.Code, null,
            tint = accent, modifier = Modifier.size(32.dp))
        Spacer(Modifier.height(12.dp))
        Text(if (filtered) "No matching lines" else if (tab == "Console") "Console is ready" else "No data from this page",
            color = MaterialTheme.colorScheme.onSurface, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(4.dp))
        Text(if (filtered) "Try another filter." else if (tab == "Console") "Page messages and JavaScript results appear here."
            else "Reload the page or tap Refresh to try again.", color = muted, fontSize = 12.sp)
    }
}

@Composable
private fun ConsoleLines(lines: List<String>, text: Color, muted: Color, divider: Color, accent: Color, error: Color) {
    LazyColumn(contentPadding = PaddingValues(vertical = 4.dp)) {
        itemsIndexed(lines) { _, line ->
            val kind = when {
                line.startsWith("> ") -> "INPUT"
                line.startsWith("ERROR ") -> "ERROR"
                line.startsWith("WARNING ") -> "WARN"
                line.startsWith("DEBUG ") -> "DEBUG"
                line.startsWith("LOG ") -> "LOG"
                else -> "RESULT"
            }
            val detail = if (kind == "INPUT") line.drop(2) else if (kind == "RESULT") line else line.substringAfter(' ')
            val color = when (kind) {
                "ERROR" -> error
                "WARN" -> if (text.luminance() > 0.5f) Color(0xFFFFBD69) else Color(0xFF8B4700)
                "INPUT", "RESULT" -> accent
                else -> muted
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 9.dp), verticalAlignment = Alignment.Top) {
                Text(kind, color = color, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace, modifier = Modifier.width(58.dp).padding(top = 2.dp))
                Text(detail, color = text, fontSize = 11.sp, lineHeight = 17.sp,
                    fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
            }
            HorizontalDivider(color = divider.copy(alpha = 0.6f))
        }
    }
}

@Composable
private fun SourceLines(lines: List<IndexedValue<String>>, text: Color, muted: Color, divider: Color) {
    LazyColumn(contentPadding = PaddingValues(vertical = 5.dp)) {
        itemsIndexed(lines) { _, item ->
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(vertical = 3.dp)) {
                Text("${item.index + 1}", color = muted, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                    modifier = Modifier.width(46.dp).padding(start = 10.dp))
                Box(Modifier.width(1.dp).heightIn(min = 16.dp).background(divider))
                Text(item.value.ifEmpty { " " }, color = text, fontSize = 11.sp, lineHeight = 16.sp,
                    fontFamily = FontFamily.Monospace, softWrap = false, modifier = Modifier.padding(start = 10.dp, end = 12.dp))
            }
        }
    }
}
