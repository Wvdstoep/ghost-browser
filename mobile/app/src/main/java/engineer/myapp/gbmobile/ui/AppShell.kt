package engineer.myapp.gbmobile.ui

import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The whole phone app in Compose — Chrome-tight. A minimal top bar (site pill · tab count · overflow),
 * a focused omnibox (tap the pill), a Chrome-style overflow sheet, and a thumbnail tab grid. The real
 * WebView(s) are hosted via AndroidView so the browser/agent/cluster engine underneath is untouched.
 */

data class TabInfo(val index: Int, val title: String, val host: String, val profile: String, val active: Boolean, val thumb: ImageBitmap? = null)
data class FlowInfo(val id: String, val name: String, val steps: Int, val sub: String,
                    val profile: String = "", val role: String = "", val goals: List<String> = emptyList(),
                    val runs: Int = 0, val lastStatus: String = "", val verified: Boolean = false)
data class ChatMsg(val role: String, val content: String, val tool: String? = null)   // user | assistant | tool
data class PlatformOpt(val label: String, val site: String, val profile: String, val signedIn: Boolean)
data class HubDevice(val name: String, val owner: String, val type: String, val online: Boolean, val lastSeenMs: Long, val queued: Int)
data class LearnItem(val slug: String, val title: String, val description: String)

/** Reactive shell state the Activity keeps in sync. */
class ShellUi {
    val screen = mutableStateOf("browser")      // browser | flows | agent | settings | devices
    val url = mutableStateOf("")
    val tabCount = mutableStateOf(1)
    val switcherOpen = mutableStateOf(false)
    val menuOpen = mutableStateOf(false)
    val urlFocused = mutableStateOf(false)
    val aiSettingsOpen = mutableStateOf(false)
    val desktopMode = mutableStateOf(false)
    val tabs = mutableStateOf<List<TabInfo>>(emptyList())
    val flows = mutableStateOf<List<FlowInfo>>(emptyList())
    val flowsHint = mutableStateOf("")
    val platforms = mutableStateOf<List<PlatformOpt>>(emptyList())
    // agent chat
    val agentTitle = mutableStateOf("Agent")
    val agentMsgs = mutableStateOf<List<ChatMsg>>(emptyList())
    val agentBusy = mutableStateOf(false)
    val pipThumb = mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null)   // live snapshot of the tab the agent is driving
    val clusterOn = mutableStateOf(false)
    // device hub (native, local render)
    val hubDevices = mutableStateOf<List<HubDevice>>(emptyList())
    val hubSummary = mutableStateOf("")
    // new-tab home feed (my-app.engineer /learn pages)
    val homeFeed = mutableStateOf<List<LearnItem>>(emptyList())
    val homeFeedLoading = mutableStateOf(false)
}

class ShellActions(
    val onUrlGo: (String) -> Unit,
    val onFocusUrl: () -> Unit,
    val onCloseUrlFocus: () -> Unit,
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
    val onOpenLearn: (String) -> Unit,
    val onRefreshHome: () -> Unit,
    // overflow menu / browser actions
    val onOpenMenu: () -> Unit,
    val onCloseMenu: () -> Unit,
    val onBack: () -> Unit,
    val onForward: () -> Unit,
    val onReload: () -> Unit,
    val onShare: () -> Unit,
    val onToggleDesktop: () -> Unit,
    val onFindInPage: () -> Unit,
    val onOpenHub: () -> Unit,
    val onRefreshHub: () -> Unit,
    val onOpenAiSettings: () -> Unit,
    val onCloseAiSettings: () -> Unit,
)

private fun hostOf(url: String): String {
    if (url.isBlank()) return ""
    return try {
        val u = if (url.startsWith("http")) url else "https://$url"
        android.net.Uri.parse(u).host?.removePrefix("www.") ?: url
    } catch (e: Exception) { url }
}

@Composable
fun AppShell(shell: ShellUi, act: ShellActions, webHolder: FrameLayout, settingsUi: SettingsUi, settingsAct: SettingsActions) {
    val cs = MaterialTheme.colorScheme
    val screen = shell.screen.value
    Box(Modifier.fillMaxSize().background(cs.background)) {
        Column(Modifier.fillMaxSize()) {
            if (screen == "browser" || screen == "flows") TopBar(shell, act)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                // The real browser is always mounted so tab state/JS is never torn down; other screens
                // draw over it (opaque) rather than unmounting it.
                AndroidView(
                    factory = { (webHolder.parent as? ViewGroup)?.removeView(webHolder); webHolder },
                    modifier = Modifier.fillMaxSize(),
                )
                when (screen) {
                    "flows" -> FlowsPane(shell, act, Modifier.fillMaxSize().background(cs.background))
                    "agent" -> AgentChat(shell, act)
                    "settings" -> SettingsScreen(true, settingsUi, settingsAct) { act.onNav("browser") }
                    "devices" -> DeviceHubScreen(shell, act)
                    else -> if (shell.url.value.isBlank()) HomePage(shell, act)   // new/blank tab → native home
                }
            }
            BottomBar(shell, act)
        }

        if (shell.switcherOpen.value) TabGrid(shell, act)
        if (shell.menuOpen.value) OverflowMenu(shell, act)
        if (shell.urlFocused.value) Omnibox(shell, act)
        if (shell.aiSettingsOpen.value) AiSettingsDialog(settingsUi, settingsAct, act.onCloseAiSettings)
    }
}

/* AndroidView import kept local to avoid a wildcard clash */
@Composable
private fun AndroidView(factory: (android.content.Context) -> android.view.View, modifier: Modifier) =
    androidx.compose.ui.viewinterop.AndroidView(factory = factory, modifier = modifier)

/* ── Top bar ───────────────────────────────────────────────────────────────────────────────── */

@Composable
private fun TopBar(shell: ShellUi, act: ShellActions) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, contentColor = cs.onSurface) {
        Row(
            Modifier.fillMaxWidth().statusBarsPaddingSafe().padding(horizontal = 8.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val host = hostOf(shell.url.value)
            Surface(
                color = cs.surfaceVariant, shape = RoundedCornerShape(22.dp),
                modifier = Modifier.weight(1f).height(44.dp).clickable { act.onFocusUrl() },
            ) {
                Row(Modifier.padding(start = 14.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Lock, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(15.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(
                        if (host.isBlank()) "Search or type a URL" else host,
                        color = if (host.isBlank()) cs.onSurfaceVariant else cs.onSurface,
                        fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                }
            }
            Spacer(Modifier.width(6.dp))
            TabCountButton(shell.tabCount.value, act.onOpenSwitcher)
            IconButton(onClick = act.onOpenMenu) { Icon(Icons.Default.MoreVert, "Menu", tint = cs.onSurface) }
        }
    }
}

@Composable
private fun TabCountButton(count: Int, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Box(
        Modifier.size(30.dp).clip(RoundedCornerShape(8.dp))
            .border(2.dp, cs.onSurface, RoundedCornerShape(8.dp)).clickable { onClick() },
        contentAlignment = Alignment.Center,
    ) { Text(if (count > 99) "99" else "$count", color = cs.onSurface, fontSize = 12.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold) }
}

@Composable
private fun BottomBar(shell: ShellUi, act: ShellActions) {
    val cs = MaterialTheme.colorScheme
    NavigationBar(containerColor = cs.surface, tonalElevation = 0.dp) {
        NavItem(Icons.Default.Public, "Browser", shell.screen.value == "browser") { act.onNav("browser") }
        NavItem(Icons.Default.Bolt, "Agent", shell.screen.value == "agent") { act.onOpenAgent() }
        NavItem(Icons.Default.AccountTree, "Flows", shell.screen.value == "flows") { act.onNav("flows") }
        NavItem(Icons.Default.Settings, "Settings", shell.screen.value == "settings") { act.onOpenSettings() }
    }
}

@Composable
private fun RowScope.NavItem(icon: ImageVector, label: String, selected: Boolean, onClick: () -> Unit) {
    NavigationBarItem(
        selected = selected, onClick = onClick,
        icon = { Icon(icon, label) }, label = { Text(label, fontSize = 11.sp) },
        colors = NavigationBarItemDefaults.colors(
            selectedIconColor = BrandOn, indicatorColor = Brand,
            selectedTextColor = Brand, unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
            unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
        ),
    )
}

/* ── New-tab home (Google-style; feed = my-app /learn) ───────────────────────────────────────── */

@Composable
private fun HomePage(shell: ShellUi, act: ShellActions) {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.fillMaxSize().background(cs.background).verticalScroll(rememberScrollState())) {
        Spacer(Modifier.height(48.dp))
        // brand wordmark
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(38.dp).clip(RoundedCornerShape(11.dp)).background(Brand), contentAlignment = Alignment.Center) {
                Text("G", color = BrandOn, fontSize = 24.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold)
            }
            Spacer(Modifier.width(12.dp))
            Row {
                Text("Ghost", color = cs.onBackground, fontSize = 30.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
                Text("Browser", color = Brand, fontSize = 30.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
            }
        }
        Spacer(Modifier.height(26.dp))
        // search pill (opens the omnibox)
        Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(26.dp),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).height(52.dp).clickable { act.onFocusUrl() }) {
            Row(Modifier.padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Search, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(22.dp))
                Spacer(Modifier.width(14.dp))
                Text("Search or type a URL", color = cs.onSurfaceVariant, fontSize = 16.sp)
            }
        }
        Spacer(Modifier.height(22.dp))
        // platform shortcuts
        if (shell.platforms.value.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
                shell.platforms.value.take(12).forEach { p ->
                    Column(Modifier.width(76.dp).clickable { act.onOpenPlatform(p.profile, p.site) }.padding(vertical = 6.dp),
                        horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(Modifier.size(50.dp).clip(CircleShape).background(cs.surfaceVariant), contentAlignment = Alignment.Center) {
                            Text(p.label.take(1).uppercase(), color = Brand, fontSize = 20.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold)
                        }
                        Spacer(Modifier.height(6.dp))
                        Text(p.label, color = cs.onSurface, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            Spacer(Modifier.height(20.dp))
        }
        // Learn feed
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("From my-app.engineer", color = cs.onSurfaceVariant, fontSize = 13.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, modifier = Modifier.weight(1f))
            if (shell.homeFeedLoading.value) CircularProgressIndicator(Modifier.size(16.dp), color = Brand, strokeWidth = 2.dp)
            else IconButton(onClick = act.onRefreshHome) { Icon(Icons.Default.Refresh, "Refresh", tint = cs.onSurfaceVariant, modifier = Modifier.size(18.dp)) }
        }
        Spacer(Modifier.height(6.dp))
        if (shell.homeFeed.value.isEmpty() && !shell.homeFeedLoading.value) {
            Text("No articles yet.", color = cs.onSurfaceVariant, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp))
        } else Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            shell.homeFeed.value.forEach { it2 -> LearnCard(it2) { act.onOpenLearn(it2.slug) } }
        }
        Spacer(Modifier.height(28.dp))
    }
}

@Composable
private fun LearnCard(item: LearnItem, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(16.dp), border = androidx.compose.foundation.BorderStroke(1.dp, cs.outline),
        modifier = Modifier.fillMaxWidth().clickable { onClick() }) {
        Column(Modifier.padding(16.dp)) {
            Text(item.title, color = cs.onSurface, fontSize = 16.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, lineHeight = 21.sp)
            if (item.description.isNotBlank()) {
                Spacer(Modifier.height(6.dp))
                Text(item.description, color = cs.onSurfaceVariant, fontSize = 13.sp, maxLines = 3, overflow = TextOverflow.Ellipsis, lineHeight = 18.sp)
            }
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(16.dp).clip(CircleShape).background(Brand), contentAlignment = Alignment.Center) { Text("G", color = BrandOn, fontSize = 9.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold) }
                Spacer(Modifier.width(8.dp))
                Text("my-app.engineer · Learn", color = cs.onSurfaceVariant, fontSize = 11.sp)
            }
        }
    }
}

/* ── Omnibox (focused URL, Chrome-style) ─────────────────────────────────────────────────────── */

@Composable
private fun Omnibox(shell: ShellUi, act: ShellActions) {
    val cs = MaterialTheme.colorScheme
    var q by remember { mutableStateOf(shell.url.value) }
    val fr = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { fr.requestFocus() } }
    val looksUrl = q.contains(".") && !q.trimStart().contains(" ")
    Surface(color = cs.background, contentColor = cs.onBackground, modifier = Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().statusBarsPaddingSafe()) {
            // search pill
            Row(Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = act.onCloseUrlFocus) { Icon(Icons.Default.ArrowBack, "Back", tint = cs.onSurfaceVariant) }
                Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(24.dp), modifier = Modifier.weight(1f).height(48.dp)) {
                    Row(Modifier.padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Search, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(10.dp))
                        androidx.compose.foundation.text.BasicTextField(
                            value = q, onValueChange = { q = it }, singleLine = true,
                            modifier = Modifier.weight(1f).focusRequester(fr),
                            textStyle = androidx.compose.ui.text.TextStyle(color = cs.onSurface, fontSize = 16.sp),
                            cursorBrush = androidx.compose.ui.graphics.SolidColor(Brand),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                            keyboardActions = KeyboardActions(onGo = { if (q.isNotBlank()) act.onUrlGo(q.trim()) }),
                            decorationBox = { inner -> if (q.isEmpty()) Text("Search or type a URL", color = cs.onSurfaceVariant, fontSize = 16.sp); inner() },
                        )
                        if (q.isNotEmpty()) IconButton(onClick = { q = "" }) { Icon(Icons.Default.Close, "Clear", tint = cs.onSurfaceVariant, modifier = Modifier.size(20.dp)) }
                    }
                }
            }
            HorizontalDivider(color = cs.outline)
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                if (q.isNotBlank()) {
                    SuggestRow(Icons.Default.Search, if (looksUrl) "Go to $q" else "Search Google for “$q”", null) { act.onUrlGo(q.trim()) }
                    HorizontalDivider(color = cs.outline)
                }
                // shortcuts (platforms)
                if (shell.platforms.value.isNotEmpty()) {
                    Text("Shortcuts", color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.padding(start = 16.dp, top = 14.dp, bottom = 8.dp))
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp)) {
                        shell.platforms.value.take(10).forEach { p ->
                            Column(
                                Modifier.width(80.dp).clickable { act.onOpenPlatform(p.profile, p.site) }.padding(vertical = 6.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                Box(Modifier.size(48.dp).clip(CircleShape).background(cs.surfaceVariant), contentAlignment = Alignment.Center) {
                                    Text(p.label.take(1).uppercase(), color = Brand, fontSize = 18.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold)
                                }
                                Spacer(Modifier.height(6.dp))
                                Text(p.label, color = cs.onSurface, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                    HorizontalDivider(color = cs.outline, modifier = Modifier.padding(top = 12.dp))
                }
                // open tabs (filtered)
                val tabs = shell.tabs.value.filter { q.isBlank() || it.title.contains(q, true) || it.host.contains(q, true) }
                if (tabs.isNotEmpty()) {
                    Text("Open tabs", color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.padding(start = 16.dp, top = 14.dp, bottom = 4.dp))
                    tabs.forEach { t -> SuggestRow(Icons.Default.Language, t.title.ifBlank { "New tab" }, t.host) { act.onSelectTab(t.index) } }
                }
            }
        }
    }
}

@Composable
private fun SuggestRow(icon: ImageVector, title: String, sub: String?, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().clickable { onClick() }.padding(horizontal = 16.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = cs.onSurface, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (sub != null) Text(sub, color = cs.onSurfaceVariant, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/* ── Overflow menu (Chrome-style sheet) ──────────────────────────────────────────────────────── */

@Composable
private fun OverflowMenu(shell: ShellUi, act: ShellActions) {
    val cs = MaterialTheme.colorScheme
    Box(Modifier.fillMaxSize().background(Color(0x80000000)).clickable { act.onCloseMenu() }, contentAlignment = Alignment.TopEnd) {
        Surface(
            color = cs.surface, contentColor = cs.onSurface, shape = RoundedCornerShape(20.dp),
            tonalElevation = 4.dp,
            modifier = Modifier.statusBarsPaddingSafe().padding(8.dp).width(300.dp).clickable(enabled = false) {},
        ) {
            Column(Modifier.padding(vertical = 8.dp).verticalScroll(rememberScrollState())) {
                // top icon row
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    RoundIcon(Icons.Default.ArrowBack, "Back") { act.onCloseMenu(); act.onBack() }
                    RoundIcon(Icons.Default.ArrowForward, "Forward") { act.onCloseMenu(); act.onForward() }
                    RoundIcon(Icons.Default.Share, "Share") { act.onCloseMenu(); act.onShare() }
                    RoundIcon(Icons.Default.Refresh, "Reload") { act.onCloseMenu(); act.onReload() }
                }
                Spacer(Modifier.height(4.dp))
                MenuRow(Icons.Default.Add, "New tab") { act.onCloseMenu(); act.onNewTab() }
                MenuRow(Icons.Default.Layers, "Tabs") { act.onCloseMenu(); act.onOpenSwitcher() }
                MenuDivider()
                MenuRow(Icons.Default.Search, "Find in page") { act.onCloseMenu(); act.onFindInPage() }
                MenuRowToggle(Icons.Default.DesktopWindows, "Desktop site", shell.desktopMode.value) { act.onCloseMenu(); act.onToggleDesktop() }
                MenuDivider()
                MenuRow(Icons.Default.Bolt, "Agent") { act.onCloseMenu(); act.onOpenAgent() }
                MenuRow(Icons.Default.AccountTree, "Flows") { act.onCloseMenu(); act.onNav("flows") }
                MenuRow(Icons.Default.DevicesOther, "Device Hub") { act.onCloseMenu(); act.onOpenHub() }
                MenuDivider()
                MenuRow(Icons.Default.Settings, "Settings") { act.onCloseMenu(); act.onOpenSettings() }
            }
        }
    }
}

@Composable
private fun RoundIcon(icon: ImageVector, cd: String, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Box(Modifier.size(44.dp).clip(CircleShape).background(cs.surfaceVariant).clickable { onClick() }, contentAlignment = Alignment.Center) {
        Icon(icon, cd, tint = cs.onSurface, modifier = Modifier.size(21.dp))
    }
}

@Composable
private fun MenuRow(icon: ImageVector, label: String, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().clickable { onClick() }.padding(horizontal = 18.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(20.dp))
        Text(label, color = cs.onSurface, fontSize = 15.sp)
    }
}

@Composable
private fun MenuRowToggle(icon: ImageVector, label: String, on: Boolean, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().clickable { onClick() }.padding(horizontal = 18.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(20.dp))
        Text(label, color = cs.onSurface, fontSize = 15.sp, modifier = Modifier.weight(1f))
        Box(Modifier.size(20.dp).clip(RoundedCornerShape(5.dp)).border(2.dp, if (on) Brand else cs.outline, RoundedCornerShape(5.dp)).background(if (on) Brand else Color.Transparent), contentAlignment = Alignment.Center) {
            if (on) Icon(Icons.Default.Check, null, tint = BrandOn, modifier = Modifier.size(14.dp))
        }
    }
}

@Composable
private fun MenuDivider() = HorizontalDivider(color = MaterialTheme.colorScheme.outline, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))

/* ── Flows ─────────────────────────────────────────────────────────────────────────────────── */

@Composable
private fun groupOf(f: FlowInfo): String {
    val p = f.profile.lowercase(); val n = (f.name + " " + f.role).lowercase()
    return when {
        p.contains("facebook") || n.contains("facebook") -> "Facebook"
        p.contains("linkedin") || n.contains("linkedin") -> "LinkedIn"
        p.contains("google") || n.contains("google") -> "Google"
        p.contains("capcut") || n.contains("capcut") -> "CapCut"
        p.contains("reddit") || n.contains("reddit") -> "Reddit"
        p.contains("useme") || n.contains("useme") -> "Useme"
        p.contains("herald") || n.contains("herald") -> "Herald"
        p.contains("probe") || n.contains("probe") -> "Probe"
        f.profile.isNotBlank() -> f.profile.replaceFirstChar { it.uppercase() }
        else -> "Other"
    }
}

@Composable
private fun FlowsPane(shell: ShellUi, act: ShellActions, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    var q by remember { mutableStateOf("") }
    var showBuild by remember { mutableStateOf(false) }
    val all = shell.flows.value.filter { q.isBlank() || it.name.contains(q, true) || it.profile.contains(q, true) || it.role.contains(q, true) }
    val groups = all.groupBy { groupOf(it) }.toList().sortedByDescending { it.second.size }
    Column(modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Automations", style = MaterialTheme.typography.headlineSmall)
                Text("${shell.flows.value.size} flows · ${groups.size} groups", color = cs.onSurfaceVariant, fontSize = 12.sp)
            }
            TextButton(onClick = act.onLoadFlows) { Text("Reload") }
        }
        Spacer(Modifier.height(10.dp))
        Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
            Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Search, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(18.dp)); Spacer(Modifier.width(10.dp))
                androidx.compose.foundation.text.BasicTextField(q, { q = it }, singleLine = true, modifier = Modifier.weight(1f),
                    textStyle = androidx.compose.ui.text.TextStyle(color = cs.onSurface, fontSize = 15.sp), cursorBrush = androidx.compose.ui.graphics.SolidColor(Brand),
                    decorationBox = { inner -> if (q.isEmpty()) Text("Search automations", color = cs.onSurfaceVariant, fontSize = 15.sp); inner() })
            }
        }
        Spacer(Modifier.height(12.dp))
        if (shell.flows.value.isEmpty()) Text("No automations yet — Reload, or build one below.", color = cs.onSurfaceVariant, fontSize = 13.sp)
        groups.forEach { (group, flows) -> FlowGroup(group, flows) { id, name -> act.onRunFlow(id, name) } }

        Spacer(Modifier.height(20.dp)); HorizontalDivider(color = cs.outline); Spacer(Modifier.height(12.dp))
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { showBuild = !showBuild }) {
            Text("Build a new automation", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            Icon(if (showBuild) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null, tint = cs.onSurfaceVariant)
        }
        if (showBuild) {
            Spacer(Modifier.height(8.dp))
            var name by remember { mutableStateOf("") }
            var steps by remember { mutableStateOf("") }
            Text("A manual trigger + one agent step per line, chained for you.", color = cs.onSurfaceVariant, fontSize = 11.sp)
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(steps, { steps = it }, label = { Text("Steps — one goal per line") }, modifier = Modifier.fillMaxWidth().height(140.dp))
            Spacer(Modifier.height(10.dp))
            Button(onClick = { if (name.isNotBlank() && steps.isNotBlank()) { act.onCreateFlow(name, steps); name = ""; steps = "" } },
                shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Create on cluster") }
        }
        Spacer(Modifier.height(28.dp))
    }
}

@Composable
private fun FlowGroup(group: String, flows: List<FlowInfo>, onRun: (String, String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var open by remember { mutableStateOf(false) }
    Column(Modifier.padding(bottom = 10.dp)) {
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(cs.surfaceVariant).clickable { open = !open }.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(group, color = cs.onSurface, fontSize = 15.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text("${flows.size}", color = cs.onSurfaceVariant, fontSize = 13.sp); Spacer(Modifier.width(8.dp))
            Icon(if (open) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null, tint = cs.onSurfaceVariant)
        }
        if (open) Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            flows.forEach { f -> FlowCard(f) { onRun(f.id, f.name) } }
        }
    }
}

@Composable
private fun FlowCard(f: FlowInfo, onRun: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    var open by remember { mutableStateOf(false) }
    Surface(color = cs.surface, shape = RoundedCornerShape(14.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, if (f.verified) Brand else cs.outline), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).clickable { open = !open }) {
                    Text(f.name, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${f.steps} step(s) · ${f.sub}", color = cs.onSurfaceVariant, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Spacer(Modifier.width(10.dp))
                Icon(if (open) Icons.Default.ExpandLess else Icons.Default.ExpandMore, "Details", tint = cs.onSurfaceVariant, modifier = Modifier.clickable { open = !open })
                Spacer(Modifier.width(6.dp))
                Button(onClick = onRun, shape = RoundedCornerShape(10.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Run") }
            }
            if (open) {
                Spacer(Modifier.height(10.dp)); HorizontalDivider(color = cs.outline); Spacer(Modifier.height(10.dp))
                if (f.profile.isNotBlank()) DetailRow("Profile", f.profile)
                if (f.role.isNotBlank()) DetailRow("Role", f.role)
                DetailRow("Runs", if (f.runs > 0) "${f.runs} · last ${f.lastStatus.ifBlank { "?" }}" else "never run")
                if (f.verified) DetailRow("Verified", "✓ last run verified")
                if (f.goals.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp)); Text("Steps", color = cs.onSurfaceVariant, fontSize = 11.sp); Spacer(Modifier.height(4.dp))
                    f.goals.forEachIndexed { i, g -> Text("${i + 1}. $g", color = cs.onSurface, fontSize = 12.sp, lineHeight = 17.sp, modifier = Modifier.padding(bottom = 3.dp)) }
                }
            }
        }
    }
}

@Composable
private fun DetailRow(k: String, v: String) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.padding(bottom = 4.dp)) {
        Text(k, color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.width(64.dp))
        Text(v, color = cs.onSurface, fontSize = 12.sp, modifier = Modifier.weight(1f))
    }
}

/* ── Tab grid (Chrome-style) ─────────────────────────────────────────────────────────────────── */

@Composable
private fun TabGrid(shell: ShellUi, act: ShellActions) {
    val cs = MaterialTheme.colorScheme
    var q by remember { mutableStateOf("") }
    Surface(color = cs.background, contentColor = cs.onBackground, modifier = Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().statusBarsPaddingSafe()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(44.dp).clip(RoundedCornerShape(14.dp)).background(Brand).clickable { act.onNewTab() }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Add, "New tab", tint = BrandOn)
                }
                Spacer(Modifier.weight(1f))
                Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(10.dp)) {
                    Text("${shell.tabCount.value} tabs", Modifier.padding(horizontal = 14.dp, vertical = 8.dp), color = cs.onSurface, fontSize = 13.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
                }
                Spacer(Modifier.weight(1f))
                IconButton(onClick = act.onCloseSwitcher) { Icon(Icons.Default.Close, "Done", tint = cs.onSurface) }
            }
            // search
            Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
                Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Search, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(10.dp))
                    androidx.compose.foundation.text.BasicTextField(
                        value = q, onValueChange = { q = it }, singleLine = true, modifier = Modifier.weight(1f),
                        textStyle = androidx.compose.ui.text.TextStyle(color = cs.onSurface, fontSize = 15.sp),
                        cursorBrush = androidx.compose.ui.graphics.SolidColor(Brand),
                        decorationBox = { inner -> if (q.isEmpty()) Text("Search your tabs", color = cs.onSurfaceVariant, fontSize = 15.sp); inner() },
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
            val tabs = shell.tabs.value.filter { q.isBlank() || it.title.contains(q, true) || it.host.contains(q, true) }
            LazyVerticalGrid(
                columns = GridCells.Fixed(2), modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(tabs, key = { it.index }) { t -> TabCard(t, { act.onSelectTab(t.index) }, { act.onCloseTab(t.index) }) }
            }
        }
    }
}

@Composable
private fun TabCard(t: TabInfo, onOpen: () -> Unit, onClose: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(
        color = cs.surface, shape = RoundedCornerShape(14.dp),
        border = androidx.compose.foundation.BorderStroke(if (t.active) 2.dp else 1.dp, if (t.active) Brand else cs.outline),
        modifier = Modifier.fillMaxWidth().clickable { onOpen() },
    ) {
        Column {
            Row(Modifier.padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(16.dp).clip(CircleShape).background(cs.surfaceVariant), contentAlignment = Alignment.Center) {
                    Text(t.host.take(1).uppercase().ifBlank { "•" }, color = cs.onSurfaceVariant, fontSize = 9.sp)
                }
                Spacer(Modifier.width(8.dp))
                Text(t.title.ifBlank { "New tab" }, color = cs.onSurface, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Box(Modifier.size(28.dp).clip(CircleShape).clickable { onClose() }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Close, "Close tab", tint = cs.onSurfaceVariant, modifier = Modifier.size(15.dp))
                }
            }
            Box(Modifier.fillMaxWidth().height(150.dp).background(cs.surfaceVariant), contentAlignment = Alignment.Center) {
                if (t.thumb != null) androidx.compose.foundation.Image(bitmap = t.thumb, contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop, alignment = Alignment.TopCenter)
                else Text(t.host.ifBlank { "New tab" }, color = cs.onSurfaceVariant, fontSize = 13.sp)
            }
        }
    }
}

/* ── Agent chat ────────────────────────────────────────────────────────────────────────────── */

@Composable
private fun AgentChat(shell: ShellUi, act: ShellActions) {
    val cs = MaterialTheme.colorScheme
    var toolView by remember { mutableStateOf<ChatMsg?>(null) }
    Box(Modifier.fillMaxSize()) {
    Surface(color = cs.background, contentColor = cs.onBackground, modifier = Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().statusBarsPaddingSafe()) {
            Row(Modifier.fillMaxWidth().background(cs.surface).padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(shell.agentTitle.value, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                IconButton(onClick = act.onNewAgentChat) { Icon(Icons.Default.Add, "New chat", tint = cs.onSurfaceVariant) }
                IconButton(onClick = act.onOpenAiSettings) { Icon(Icons.Default.Tune, "AI settings", tint = cs.onSurfaceVariant) }
                IconButton(onClick = act.onCloseAgent) { Icon(Icons.Default.Close, "Close", tint = cs.onSurfaceVariant) }
            }
            val scroll = rememberScrollState()
            val msgs = shell.agentMsgs.value
            LaunchedEffect(msgs.size, shell.agentBusy.value) { scroll.animateScrollTo(scroll.maxValue) }
            Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll).padding(horizontal = 14.dp, vertical = 16.dp)) {
                if (msgs.isEmpty()) Text("What can I do for you?\n\nI can browse for you, build & run automations, inspect your platforms, or drive your other devices — just ask.",
                    color = cs.onSurfaceVariant, fontSize = 15.sp, modifier = Modifier.padding(top = 24.dp))
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
        // Picture-in-picture: a live snapshot of the tab the agent is driving. Tap to expand to Browser.
        val pip = shell.pipThumb.value
        if (pip != null) {
            Surface(
                color = cs.surface, shape = RoundedCornerShape(12.dp),
                border = androidx.compose.foundation.BorderStroke(2.dp, Brand), tonalElevation = 8.dp,
                modifier = Modifier.align(Alignment.BottomEnd).padding(end = 12.dp, bottom = 88.dp).width(132.dp).clickable { act.onNav("browser") },
            ) {
                Column {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(7.dp).clip(CircleShape).background(Brand))
                        Spacer(Modifier.width(6.dp))
                        Text("live", color = cs.onSurface, fontSize = 11.sp, modifier = Modifier.weight(1f))
                        Icon(Icons.Default.OpenInFull, "Expand", tint = cs.onSurfaceVariant, modifier = Modifier.size(13.dp))
                    }
                    androidx.compose.foundation.Image(bitmap = pip, contentDescription = "what the agent is doing", modifier = Modifier.width(132.dp).height(188.dp), contentScale = ContentScale.Crop, alignment = Alignment.TopCenter)
                }
            }
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
            color = if (user) Brand else cs.surface, contentColor = if (user) BrandOn else cs.onSurface,
            shape = RoundedCornerShape(16.dp),
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
    Row(Modifier.fillMaxWidth().background(cs.surface).padding(10.dp).navigationBarsPaddingSafe(), verticalAlignment = Alignment.Bottom) {
        Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(20.dp), modifier = Modifier.weight(1f)) {
            androidx.compose.foundation.text.BasicTextField(
                value = text, onValueChange = { text = it },
                textStyle = androidx.compose.ui.text.TextStyle(color = cs.onSurface, fontSize = 15.sp),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(Brand),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 11.dp),
                decorationBox = { inner -> if (text.isEmpty()) Text("Message the agent…", color = cs.onSurfaceVariant, fontSize = 15.sp); inner() },
            )
        }
        Spacer(Modifier.width(8.dp))
        FilledIconButton(
            onClick = { if (!busy && text.isNotBlank()) { onSend(text.trim()); text = "" } }, enabled = !busy,
            colors = IconButtonDefaults.filledIconButtonColors(containerColor = Brand, contentColor = BrandOn),
        ) { Icon(Icons.Default.Send, "Send") }
    }
}

/* ── Device Hub (native, renders locally) ────────────────────────────────────────────────────── */

@Composable
private fun DeviceHubScreen(shell: ShellUi, act: ShellActions) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.background, contentColor = cs.onBackground, modifier = Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().statusBarsPaddingSafe()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Device Hub", style = MaterialTheme.typography.headlineSmall)
                    Text(shell.hubSummary.value.ifBlank { "Every node on your account" }, color = cs.onSurfaceVariant, fontSize = 12.sp)
                }
                IconButton(onClick = act.onRefreshHub) { Icon(Icons.Default.Refresh, "Refresh", tint = cs.onSurface) }
            }
            HorizontalDivider(color = cs.outline)
            if (shell.hubDevices.value.isEmpty()) {
                Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    Icon(Icons.Default.DevicesOther, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(40.dp))
                    Spacer(Modifier.height(10.dp))
                    Text("No devices yet — sign in and connect.", color = cs.onSurfaceVariant, fontSize = 13.sp)
                }
            } else Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                shell.hubDevices.value.forEach { d -> HubCard(d) }
                Spacer(Modifier.height(16.dp))
            }
        }
    }
}

@Composable
private fun HubCard(d: HubDevice) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(16.dp), border = androidx.compose.foundation.BorderStroke(1.dp, cs.outline), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(10.dp).clip(CircleShape).background(if (d.online) Brand else cs.onSurfaceVariant))
                Spacer(Modifier.width(10.dp))
                Text(d.name, color = cs.onSurface, fontSize = 17.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(8.dp)) {
                    Text(d.type, Modifier.padding(horizontal = 10.dp, vertical = 4.dp), color = cs.onSurfaceVariant, fontSize = 10.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
                }
            }
            if (d.owner.isNotBlank()) { Spacer(Modifier.height(2.dp)); Text(d.owner, color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.padding(start = 20.dp)) }
            Spacer(Modifier.height(12.dp)); HorizontalDivider(color = cs.outline); Spacer(Modifier.height(12.dp))
            Row {
                HubStat("STATUS", if (d.online) "online" else "offline", if (d.online) Brand else cs.onSurfaceVariant, Modifier.weight(1f))
                HubStat("LAST SEEN", relTime(d.lastSeenMs), cs.onSurface, Modifier.weight(1f))
                HubStat("QUEUED", "${d.queued}", cs.onSurface, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun HubStat(label: String, value: String, valueColor: Color, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    Column(modifier) {
        Text(label, color = cs.onSurfaceVariant, fontSize = 10.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
        Spacer(Modifier.height(3.dp))
        Text(value, color = valueColor, fontFamily = FontFamily.Monospace, fontSize = 14.sp)
    }
}

private fun relTime(ms: Long): String {
    if (ms <= 0) return "—"
    val s = ((System.currentTimeMillis() - ms) / 1000).coerceAtLeast(0)
    return when {
        s < 60 -> "${s}s ago"
        s < 3600 -> "${s / 60}m ago"
        s < 86400 -> "${s / 3600}h ago"
        else -> "${s / 86400}d ago"
    }
}

/* ── AI settings (small modal inside the Agent view) ─────────────────────────────────────────── */

@Composable
private fun AiSettingsDialog(ui: SettingsUi, act: SettingsActions, onClose: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Box(Modifier.fillMaxSize().background(Color(0x99000000)).clickable { onClose() }, contentAlignment = Alignment.Center) {
        Surface(color = cs.surface, contentColor = cs.onSurface, shape = RoundedCornerShape(20.dp), tonalElevation = 6.dp,
            modifier = Modifier.padding(20.dp).fillMaxWidth().clickable(enabled = false) {}) {
            Column(Modifier.padding(20.dp).verticalScroll(rememberScrollState())) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("AI model", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Close", tint = cs.onSurfaceVariant) }
                }
                Text("The brain the agent uses on this phone.", color = cs.onSurfaceVariant, fontSize = 12.sp)
                Spacer(Modifier.height(14.dp))
                // Cloud vs on-device — explicit, so it's obvious what the agent will use.
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).border(1.dp, cs.outline, RoundedCornerShape(12.dp))) {
                    listOf("Cloud model", "On-device").forEachIndexed { i, lbl ->
                        val on = (if (ui.useLocal.value) 1 else 0) == i
                        Box(Modifier.weight(1f).background(if (on) Brand else Color.Transparent).clickable { act.onSetUseLocal(i == 1) }.padding(vertical = 11.dp), contentAlignment = Alignment.Center) {
                            Text(lbl, color = if (on) BrandOn else cs.onSurface, fontSize = 13.sp)
                        }
                    }
                }
                Spacer(Modifier.height(6.dp))
                Text(if (ui.useLocal.value) "Runs on this phone — small & weak; only ok for simple steps." else "A hosted model — far stronger for real flows (recommended).", color = cs.onSurfaceVariant, fontSize = 11.sp)
                Spacer(Modifier.height(14.dp))
                if (ui.useLocal.value) {
                    AiDropdown(ui.modelLabels.value, ui.modelIndex.value) { act.onSelectModelIndex(it) }
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(ui.modelStatus.value, color = if (ui.modelStatus.value.contains("✓")) Brand else cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.weight(1f))
                        Button(onClick = act.onDownloadModel, shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text(if (ui.modelStatus.value.contains("✓")) "Re-download" else "Download") }
                    }
                    if (ui.modelProgress.value in 0..100) { Spacer(Modifier.height(8.dp)); LinearProgressIndicator(progress = { ui.modelProgress.value / 100f }, modifier = Modifier.fillMaxWidth(), color = Brand) }
                } else {
                    if (ui.endpoint.value.isBlank()) ui.endpoint.value = "https://ollama.com/v1"
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { ui.endpoint.value = "https://ollama.com/v1"; act.onFetchModels(ui.endpoint.value, ui.apiKey.value) }, modifier = Modifier.weight(1f), shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Use Ollama Cloud") }
                        OutlinedButton(onClick = { act.onPullClusterConfig() }, modifier = Modifier.weight(1f), shape = RoundedCornerShape(12.dp)) { Text("Self-hosted") }
                    }
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(ui.endpoint.value, { ui.endpoint.value = it }, label = { Text("Endpoint") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(ui.apiKey.value, { ui.apiKey.value = it }, label = { Text("API key") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                        visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation())
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Model", color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.weight(1f))
                        if (ui.ollamaBusy.value) CircularProgressIndicator(Modifier.size(15.dp), color = Brand, strokeWidth = 2.dp)
                        else TextButton(onClick = { act.onFetchModels(ui.endpoint.value, ui.apiKey.value) }) { Text("Fetch models") }
                    }
                    if (ui.ollamaModels.value.isNotEmpty())
                        AiDropdown(ui.ollamaModels.value, ui.ollamaModels.value.indexOf(ui.ollamaModel.value).coerceAtLeast(0)) { i -> ui.ollamaModel.value = ui.ollamaModels.value.getOrElse(i) { ui.ollamaModel.value } }
                    else OutlinedTextField(ui.ollamaModel.value, { ui.ollamaModel.value = it }, label = { Text("Model name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    if (ui.ollamaNote.value.isNotBlank()) { Spacer(Modifier.height(4.dp)); Text(ui.ollamaNote.value, color = cs.onSurfaceVariant, fontSize = 11.sp) }
                }
                Spacer(Modifier.height(12.dp))
                Button(onClick = { act.onSaveOllama(ui.endpoint.value, ui.apiKey.value, ui.ollamaModel.value, ui.hfToken); onClose() }, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Save") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AiDropdown(options: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val label = options.getOrElse(selectedIndex) { options.firstOrNull() ?: "" }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(value = label, onValueChange = {}, readOnly = true,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor())
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEachIndexed { i, opt -> DropdownMenuItem(text = { Text(opt) }, onClick = { expanded = false; onSelect(i) }) }
        }
    }
}

/* ── insets helpers (safe if window insets APIs vary) ─────────────────────────────────────────── */
@Composable private fun Modifier.statusBarsPaddingSafe(): Modifier = this.then(Modifier.windowInsetsPadding(WindowInsets.statusBars))
@Composable private fun Modifier.navigationBarsPaddingSafe(): Modifier = this.then(Modifier.windowInsetsPadding(WindowInsets.ime))
