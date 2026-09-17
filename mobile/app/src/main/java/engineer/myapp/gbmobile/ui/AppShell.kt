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
typealias FlowInfo = engineer.myapp.gb.shared.FlowInfo   // S9: one shared model
typealias ChatMsg = engineer.myapp.gb.shared.ChatMsg                 // S9: one shared model
typealias PlatformOpt = engineer.myapp.gb.shared.PlatformOpt
typealias HubDevice = engineer.myapp.gb.shared.HubDevice
typealias LearnItem = engineer.myapp.gb.shared.LearnItem

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
    // the assistant — one chat, one agent on the cluster (state shapes live in :shared)
    val assistant = engineer.myapp.gb.shared.AssistantUi()
    val aiModel = engineer.myapp.gb.shared.AiModelUi()
    val agentBusy = mutableStateOf(false)   // a turn is running (PiP + status)
    val agentTitle = mutableStateOf("Agent")                       // legacy on-device chat (kept for the local flow runner's journal)
    val agentMsgs = mutableStateOf<List<ChatMsg>>(emptyList())
    val pipThumb = mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null)   // live snapshot of the tab the agent is driving
    val clusterOn = mutableStateOf(false)
    // device hub (native, local render)
    val hubDevices = mutableStateOf<List<HubDevice>>(emptyList())
    val hubSummary = mutableStateOf("")
    // new-tab home feed (my-app.engineer /learn pages)
    val homeFeed = mutableStateOf<List<LearnItem>>(emptyList())
    val homeFeedLoading = mutableStateOf(false)
    // approvals — the gate: running watchers + their pending proposals (drafts awaiting yes/no)
    val jobs = mutableStateOf<List<engineer.myapp.gb.shared.JobInfo>>(emptyList())
    val jobsLoading = mutableStateOf(false)
    val leads = mutableStateOf<List<engineer.myapp.gb.shared.PersonInfo>>(emptyList())   // people worth your words
    val downloads = engineer.myapp.gb.shared.DownloadsUi()   // every file the cluster browser captured
    // watchers — scheduled background tasks (own UI, separate from the gate)
    val watchers = mutableStateOf<List<engineer.myapp.gb.shared.Watcher>>(emptyList())
    val watchersLoading = mutableStateOf(false)
    val watcherRoles = mutableStateOf<List<String>>(emptyList())
    val watcherProfiles = mutableStateOf<List<String>>(listOf("facebook"))
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
    val assistant: engineer.myapp.gb.shared.AssistantActions,
    val aiModel: engineer.myapp.gb.shared.AiModelActions,
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
    // approvals gate
    val onOpenApprovals: () -> Unit,
    val onRefreshApprovals: () -> Unit,
    val onApprove: (jobId: String, pid: String, edited: String) -> Unit,
    val onDeny: (jobId: String, pid: String) -> Unit,
    val onStopJob: (jobId: String) -> Unit,
    val onSayJob: (jobId: String, text: String) -> Unit,
    val onStartWatch: () -> Unit,
    // watchers
    val onLoadWatchers: () -> Unit,
    val onSaveWatcher: (id: String?, name: String, mode: String, role: String, goal: String, profile: String, automationId: String, intervalMin: Int, followUpFlowId: String, followUpRepliesOnly: Boolean) -> Unit,
    val onToggleWatcher: (id: String, active: Boolean) -> Unit,
    val onOpenWatcherResults: (id: String) -> Unit,
    // downloads — the files the cluster browser captured
    val onLoadFiles: () -> Unit = {},
    val onDeleteFile: (id: String) -> Unit = {},
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
                    "flows" -> {
                        var sub by remember { mutableStateOf(0) }   // 0 = Automations, 1 = Watchers
                        Column(Modifier.fillMaxSize().background(cs.background)) {
                            Row(Modifier.fillMaxWidth().statusBarsPaddingSafe().padding(horizontal = 12.dp, vertical = 8.dp)
                                .clip(RoundedCornerShape(10.dp)).border(1.dp, cs.outline, RoundedCornerShape(10.dp))) {
                                listOf("Automations", "Watchers").forEachIndexed { i, lbl ->
                                    val on = sub == i
                                    Box(Modifier.weight(1f).clip(RoundedCornerShape(9.dp)).background(if (on) Brand else Color.Transparent)
                                        .clickable { sub = i; if (i == 1) act.onLoadWatchers() }.padding(vertical = 9.dp), contentAlignment = Alignment.Center) {
                                        Text(lbl, color = if (on) BrandOn else cs.onSurface, fontSize = 13.sp)
                                    }
                                }
                            }
                            if (sub == 0) engineer.myapp.gb.shared.FlowsScreen(
                                flows = shell.flows.value, onLoad = act.onLoadFlows,
                                onRun = { id, name -> act.onRunFlow(id, name) }, onCreate = { n, s -> act.onCreateFlow(n, s) },
                                modifier = Modifier.weight(1f).fillMaxWidth(),
                            ) else engineer.myapp.gb.shared.WatchersScreen(
                                watchers = shell.watchers.value, roles = shell.watcherRoles.value, profiles = shell.watcherProfiles.value,
                                automations = shell.flows.value, loading = shell.watchersLoading.value,
                                onSave = { id, n, m, r, g, p, aid, iv, fuF, fuR -> act.onSaveWatcher(id, n, m, r, g, p, aid, iv, fuF, fuR) },
                                onToggle = { id, a -> act.onToggleWatcher(id, a) }, onOpenResults = { act.onOpenWatcherResults(it) },
                                onRefresh = act.onLoadWatchers, modifier = Modifier.weight(1f).fillMaxWidth(),
                            )
                        }
                    }
                    "agent" -> engineer.myapp.gb.shared.AssistantScreen(shell.assistant, act.assistant, topInset = Modifier.statusBarsPaddingSafe())
                    "approvals" -> engineer.myapp.gb.shared.ApprovalsScreen(
                        jobs = shell.jobs.value, loading = shell.jobsLoading.value,
                        onApprove = { j, p, t -> act.onApprove(j, p, t) }, onDeny = { j, p -> act.onDeny(j, p) },
                        onStop = { act.onStopJob(it) }, onSay = { j, t -> act.onSayJob(j, t) },
                        onOpenUrl = { act.onUrlGo(it) }, onRefresh = act.onRefreshApprovals,
                        topInset = Modifier.statusBarsPaddingSafe(), leads = shell.leads.value,
                    )
                    "settings" -> SettingsScreen(true, settingsUi, settingsAct) { act.onNav("browser") }
                    "downloads" -> engineer.myapp.gb.shared.DownloadsScreen(shell.downloads, engineer.myapp.gb.shared.DownloadsActions(onRefresh = act.onLoadFiles, onDelete = act.onDeleteFile, onClose = { act.onNav("settings") }), topInset = Modifier.statusBarsPaddingSafe())
                    "devices" -> engineer.myapp.gb.shared.DeviceHubScreen(
                        shell.hubDevices.value, shell.hubSummary.value, act.onRefreshHub, System.currentTimeMillis(),
                        topInset = Modifier.statusBarsPaddingSafe(),
                    )
                    else -> if (shell.url.value.isBlank()) engineer.myapp.gb.shared.HomeScreen(   // new/blank tab → shared home
                        platforms = shell.platforms.value, feed = shell.homeFeed.value, loading = shell.homeFeedLoading.value,
                        onSearch = { act.onFocusUrl() }, onOpenPlatform = { p -> act.onOpenPlatform(p.profile, p.site) },
                        onOpenLearn = { act.onOpenLearn(it) }, onRefresh = { act.onRefreshHome() },
                    )
                }
            }
            BottomBar(shell, act)
        }

        if (shell.switcherOpen.value) TabGrid(shell, act)
        if (shell.menuOpen.value) OverflowMenu(shell, act)
        if (shell.urlFocused.value) Omnibox(shell, act)
        if (shell.aiSettingsOpen.value) engineer.myapp.gb.shared.AiModelSheet(shell.aiModel, act.aiModel, connected = shell.assistant.connected.value, onConnect = { act.onCloseAiSettings(); act.assistant.onConnect() }, onClose = act.onCloseAiSettings)
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
    val pending = shell.jobs.value.sumOf { it.proposals.size }
    NavigationBar(containerColor = cs.surface, tonalElevation = 0.dp) {
        NavItem(Icons.Default.Public, "Browser", shell.screen.value == "browser") { act.onNav("browser") }
        NavItem(Icons.Default.Bolt, "Agent", shell.screen.value == "agent") { act.onOpenAgent() }
        NavItem(Icons.Default.AccountTree, "Flows", shell.screen.value == "flows") { act.onNav("flows") }
        NavItem(Icons.Default.Verified, "Approvals", shell.screen.value == "approvals", badge = pending) { act.onOpenApprovals() }
        NavItem(Icons.Default.Settings, "Settings", shell.screen.value == "settings") { act.onOpenSettings() }
    }
}

@Composable
private fun RowScope.NavItem(icon: ImageVector, label: String, selected: Boolean, badge: Int = 0, onClick: () -> Unit) {
    NavigationBarItem(
        selected = selected, onClick = onClick,
        icon = {
            if (badge > 0) BadgedBox(badge = { Badge(containerColor = Brand, contentColor = BrandOn) { Text("$badge") } }) { Icon(icon, label) }
            else Icon(icon, label)
        },
        label = { Text(label, fontSize = 11.sp) },
        colors = NavigationBarItemDefaults.colors(
            selectedIconColor = BrandOn, indicatorColor = Brand,
            selectedTextColor = Brand, unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
            unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
        ),
    )
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
                Text(if (ui.useLocal.value) "Runs on this phone — small & weak; only ok for simple steps." else "Uses your cluster's LLM — no key needed on this phone (recommended). Advanced: set a self-hosted endpoint + key below to override.", color = cs.onSurfaceVariant, fontSize = 11.sp)
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
