package engineer.myapp.gbmobile.ui

import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView

/**
 * S6 — the whole phone app in Compose. The browser chrome (top bar, tabs), the flows list, the agent
 * chat and the tab switcher are all Compose; the real WebView(s) are hosted via [AndroidView] so the
 * proven browser/agent/cluster engine underneath is untouched. The old view-based panel is retired.
 */

data class TabInfo(val index: Int, val title: String, val host: String, val profile: String, val active: Boolean)
data class FlowInfo(val id: String, val name: String, val steps: Int, val sub: String)
data class ChatMsg(val role: String, val content: String, val tool: String? = null)   // user | assistant | tool
data class PlatformOpt(val label: String, val site: String, val profile: String, val signedIn: Boolean)

/** Reactive shell state the Activity keeps in sync. */
class ShellUi {
    val screen = mutableStateOf("browser")      // browser | flows
    val url = mutableStateOf("")
    val tabCount = mutableStateOf(1)
    val switcherOpen = mutableStateOf(false)
    val tabs = mutableStateOf<List<TabInfo>>(emptyList())
    val flows = mutableStateOf<List<FlowInfo>>(emptyList())
    val flowsHint = mutableStateOf("")
    val platforms = mutableStateOf<List<PlatformOpt>>(emptyList())
    // agent chat
    val agentOpen = mutableStateOf(false)
    val agentTitle = mutableStateOf("Agent")
    val agentMsgs = mutableStateOf<List<ChatMsg>>(emptyList())
    val agentBusy = mutableStateOf(false)
    val clusterOn = mutableStateOf(false)
}

class ShellActions(
    val onUrlGo: (String) -> Unit,
    val onHome: () -> Unit,
    val onNewTab: () -> Unit,
    val onOpenSwitcher: () -> Unit,
    val onCloseSwitcher: () -> Unit,
    val onSelectTab: (Int) -> Unit,
    val onCloseTab: (Int) -> Unit,
    val onNav: (String) -> Unit,                 // "browser" | "flows"
    val onOpenSettings: () -> Unit,
    val onOpenAgent: () -> Unit,
    val onCloseAgent: () -> Unit,
    val onNewAgentChat: () -> Unit,
    val onSendAgent: (String) -> Unit,
    val onLoadFlows: () -> Unit,
    val onRunFlow: (String, String) -> Unit,
    val onCreateFlow: (String, String) -> Unit,
    val onLoadPlatforms: () -> Unit,
    val onOpenPlatform: (String, String) -> Unit,
)

@Composable
fun AppShell(shell: ShellUi, act: ShellActions, webHolder: FrameLayout) {
    val cs = MaterialTheme.colorScheme
    Box(Modifier.fillMaxSize().background(cs.background)) {
        Column(Modifier.fillMaxSize()) {
            TopBar(shell, act)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                // The real browser — always mounted so tab state/JS is never torn down; hidden behind
                // other screens rather than removed.
                AndroidView(
                    factory = { (webHolder.parent as? ViewGroup)?.removeView(webHolder); webHolder },
                    modifier = Modifier.fillMaxSize(),
                )
                if (shell.screen.value == "flows") FlowsPane(shell, act, Modifier.fillMaxSize().background(cs.background))
            }
            BottomBar(shell, act)
        }

        if (shell.switcherOpen.value) TabSwitcher(shell, act)
        if (shell.agentOpen.value) AgentChat(shell, act)
    }
}

@Composable
private fun TopBar(shell: ShellUi, act: ShellActions) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, contentColor = cs.onSurface, tonalElevation = 2.dp) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = act.onHome) { Icon(Icons.Default.Home, "Home", tint = cs.onSurfaceVariant) }
            var text by remember(shell.url.value) { mutableStateOf(shell.url.value) }
            Surface(
                color = cs.surfaceVariant, shape = RoundedCornerShape(21.dp),
                modifier = Modifier.weight(1f).height(42.dp).padding(horizontal = 4.dp),
            ) {
                Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Language, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(15.dp))
                    Spacer(Modifier.width(8.dp))
                    BasicUrlField(text, { text = it }, { act.onUrlGo(text) }, Modifier.weight(1f))
                }
            }
            IconButton(onClick = act.onNewTab) { Icon(Icons.Default.Add, "New tab", tint = cs.onSurfaceVariant) }
            TabCountButton(shell.tabCount.value, act.onOpenSwitcher)
            IconButton(onClick = act.onOpenAgent) { Icon(Icons.Default.Bolt, "Agent", tint = GbGreen) }
        }
    }
}

@Composable
private fun BasicUrlField(value: String, onChange: (String) -> Unit, onGo: () -> Unit, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    androidx.compose.foundation.text.BasicTextField(
        value = value, onValueChange = onChange, singleLine = true, modifier = modifier,
        textStyle = androidx.compose.ui.text.TextStyle(color = cs.onSurface, fontSize = 14.sp),
        cursorBrush = androidx.compose.ui.graphics.SolidColor(GbGreen),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
        keyboardActions = KeyboardActions(onGo = { onGo() }),
        decorationBox = { inner ->
            if (value.isEmpty()) Text("Search or type a URL", color = cs.onSurfaceVariant, fontSize = 14.sp)
            inner()
        },
    )
}

@Composable
private fun TabCountButton(count: Int, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Box(
        Modifier.size(30.dp).clip(RoundedCornerShape(7.dp))
            .border(2.dp, cs.onSurfaceVariant, RoundedCornerShape(7.dp)).clickable { onClick() },
        contentAlignment = Alignment.Center,
    ) { Text("$count", color = cs.onSurfaceVariant, fontSize = 12.sp) }
}

@Composable
private fun BottomBar(shell: ShellUi, act: ShellActions) {
    val cs = MaterialTheme.colorScheme
    NavigationBar(containerColor = cs.surface, tonalElevation = 3.dp) {
        NavItem(Icons.Default.Public, "Browser", shell.screen.value == "browser") { act.onNav("browser") }
        NavItem(Icons.Default.Bolt, "Agent", false) { act.onOpenAgent() }
        NavItem(Icons.Default.AccountTree, "Flows", shell.screen.value == "flows") { act.onNav("flows") }
        NavItem(Icons.Default.Settings, "Settings", false) { act.onOpenSettings() }
    }
}

@Composable
private fun RowScope.NavItem(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, selected: Boolean, onClick: () -> Unit) {
    NavigationBarItem(
        selected = selected, onClick = onClick,
        icon = { Icon(icon, label) }, label = { Text(label, fontSize = 11.sp) },
        colors = NavigationBarItemDefaults.colors(
            selectedIconColor = Color(0xFF04140A), indicatorColor = GbGreen,
            selectedTextColor = GbGreen, unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
            unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
        ),
    )
}

/* ── Flows ─────────────────────────────────────────────────────────────────────────────────── */

@Composable
private fun FlowsPane(shell: ShellUi, act: ShellActions, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text("Automations", style = MaterialTheme.typography.headlineSmall)
        Text(shell.flowsHint.value.ifBlank { "The same flows your Ghost Browser runs — tap Run to fire one." },
            color = cs.onSurfaceVariant, fontSize = 12.sp)
        Spacer(Modifier.height(12.dp))
        OutlinedButton(onClick = act.onLoadFlows, shape = RoundedCornerShape(12.dp)) { Text("Load from cluster") }
        Spacer(Modifier.height(12.dp))
        if (shell.flows.value.isEmpty()) Text("No automations yet — build one below.", color = cs.onSurfaceVariant, fontSize = 13.sp)
        else Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            shell.flows.value.forEach { f -> FlowCard(f) { act.onRunFlow(f.id, f.name) } }
        }

        Spacer(Modifier.height(20.dp)); HorizontalDivider(color = cs.outline); Spacer(Modifier.height(16.dp))

        Text("New automation", style = MaterialTheme.typography.titleMedium)
        Text("One plain-language goal per line.", color = cs.onSurfaceVariant, fontSize = 12.sp)
        Spacer(Modifier.height(10.dp))
        var name by remember { mutableStateOf("") }
        var steps by remember { mutableStateOf("") }
        OutlinedTextField(name, { name = it }, label = { Text("Automation name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(steps, { steps = it }, label = { Text("Steps — one goal per line") }, modifier = Modifier.fillMaxWidth().height(120.dp))
        Spacer(Modifier.height(10.dp))
        Button(onClick = { if (name.isNotBlank() && steps.isNotBlank()) { act.onCreateFlow(name, steps); name = ""; steps = "" } },
            shape = RoundedCornerShape(12.dp),
            colors = ButtonDefaults.buttonColors(containerColor = GbGreen, contentColor = Color(0xFF04140A))) { Text("Create on cluster") }
        Spacer(Modifier.height(28.dp))
    }
}

@Composable
private fun FlowCard(f: FlowInfo, onRun: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(14.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, cs.outline), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(f.name, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${f.steps} step(s) · ${f.sub}", color = cs.onSurfaceVariant, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.width(10.dp))
            Button(onClick = onRun, shape = RoundedCornerShape(10.dp),
                colors = ButtonDefaults.buttonColors(containerColor = GbGreen, contentColor = Color(0xFF04140A))) { Text("Run") }
        }
    }
}

/* ── Tab switcher ──────────────────────────────────────────────────────────────────────────── */

@Composable
private fun TabSwitcher(shell: ShellUi, act: ShellActions) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.background, contentColor = cs.onBackground, modifier = Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().background(cs.surface).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Tabs", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                IconButton(onClick = act.onNewTab) { Icon(Icons.Default.Add, "New tab", tint = GbGreen) }
                IconButton(onClick = act.onCloseSwitcher) { Icon(Icons.Default.Close, "Close", tint = cs.onSurfaceVariant) }
            }
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                shell.tabs.value.forEach { t ->
                    Surface(
                        color = if (t.active) GbGreenGhost else cs.surface, shape = RoundedCornerShape(12.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, if (t.active) GbGreen else cs.outline),
                        modifier = Modifier.fillMaxWidth().clickable { act.onSelectTab(t.index) },
                    ) {
                        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(t.title.ifBlank { "New tab" }, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(t.host + (if (t.profile != "default") "  ·  ${t.profile}" else ""), color = cs.onSurfaceVariant, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            IconButton(onClick = { act.onCloseTab(t.index) }) { Icon(Icons.Default.Close, "Close tab", tint = cs.onSurfaceVariant) }
                        }
                    }
                }
            }
        }
    }
}

/* ── Agent chat ────────────────────────────────────────────────────────────────────────────── */

@Composable
private fun AgentChat(shell: ShellUi, act: ShellActions) {
    val cs = MaterialTheme.colorScheme
    var toolView by remember { mutableStateOf<ChatMsg?>(null) }
    Surface(color = cs.background, contentColor = cs.onBackground, modifier = Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().background(cs.surface).padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(shell.agentTitle.value, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                IconButton(onClick = act.onNewAgentChat) { Icon(Icons.Default.Add, "New chat", tint = cs.onSurfaceVariant) }
                IconButton(onClick = act.onOpenSettings) { Icon(Icons.Default.Tune, "Settings", tint = cs.onSurfaceVariant) }
                IconButton(onClick = act.onCloseAgent) { Icon(Icons.Default.Close, "Close", tint = cs.onSurfaceVariant) }
            }
            val scroll = rememberScrollState()
            val msgs = shell.agentMsgs.value
            LaunchedEffect(msgs.size, shell.agentBusy.value) { scroll.animateScrollTo(scroll.maxValue) }
            Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll).padding(horizontal = 14.dp, vertical = 16.dp)) {
                if (msgs.isEmpty()) {
                    Text("What can I do for you?\n\nI can browse for you, build & run automations, inspect your platforms, or drive your other devices — just ask.",
                        color = cs.onSurfaceVariant, fontSize = 15.sp, modifier = Modifier.padding(top = 24.dp))
                }
                msgs.forEach { m ->
                    when (m.role) {
                        "user" -> Bubble(m.content, true)
                        "assistant" -> Bubble(m.content, false)
                        "tool" -> ToolChip(m.tool ?: "tool") { toolView = m }
                    }
                }
                if (shell.agentBusy.value) Text("…thinking", color = cs.onSurfaceVariant, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
            }
            AgentInput(shell.agentBusy.value) { act.onSendAgent(it) }
        }
    }
    toolView?.let { tv ->
        AlertDialog(onDismissRequest = { toolView = null },
            confirmButton = { TextButton(onClick = { toolView = null }) { Text("Close") } },
            title = { Text("⚙ ${tv.tool}") },
            text = { Column(Modifier.verticalScroll(rememberScrollState())) { Text(tv.content.ifBlank { "(empty)" }, fontFamily = FontFamily.Monospace, fontSize = 12.sp) } })
    }
}

@Composable
private fun Bubble(text: String, user: Boolean) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = if (user) Arrangement.End else Arrangement.Start) {
        Surface(
            color = if (user) GbGreen else cs.surface,
            contentColor = if (user) Color(0xFF04140A) else cs.onSurface,
            shape = RoundedCornerShape(14.dp),
            border = if (user) null else androidx.compose.foundation.BorderStroke(1.dp, cs.outline),
            modifier = Modifier.fillMaxWidth(0.85f),
        ) { Text(text, Modifier.padding(horizontal = 13.dp, vertical = 10.dp), fontSize = 15.sp) }
    }
}

@Composable
private fun ToolChip(name: String, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(9.dp), modifier = Modifier.padding(bottom = 8.dp).clickable { onClick() }) {
        Text("⚙ $name", Modifier.padding(horizontal = 11.dp, vertical = 7.dp), color = cs.onSurfaceVariant, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
    }
}

@Composable
private fun AgentInput(busy: Boolean, onSend: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var text by remember { mutableStateOf("") }
    Row(Modifier.fillMaxWidth().background(cs.surface).padding(10.dp), verticalAlignment = Alignment.Bottom) {
        Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(18.dp), modifier = Modifier.weight(1f)) {
            androidx.compose.foundation.text.BasicTextField(
                value = text, onValueChange = { text = it },
                textStyle = androidx.compose.ui.text.TextStyle(color = cs.onSurface, fontSize = 15.sp),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(GbGreen),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 11.dp),
                decorationBox = { inner -> if (text.isEmpty()) Text("Message the agent…", color = cs.onSurfaceVariant, fontSize = 15.sp); inner() },
            )
        }
        Spacer(Modifier.width(8.dp))
        FilledIconButton(
            onClick = { if (!busy && text.isNotBlank()) { onSend(text.trim()); text = "" } },
            enabled = !busy,
            colors = IconButtonDefaults.filledIconButtonColors(containerColor = GbGreen, contentColor = Color(0xFF04140A)),
        ) { Icon(Icons.Default.Send, "Send") }
    }
}
