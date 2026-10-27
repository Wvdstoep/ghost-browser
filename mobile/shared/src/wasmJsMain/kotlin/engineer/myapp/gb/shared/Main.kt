package engineer.myapp.gb.shared

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.CanvasBasedWindow

/* The one expect that lives in commonMain (AssistantScreen) needs a web actual, or the whole
   shared module cannot compile for wasm. On the web it is just the browser clock. */
private fun jsNow(): Double = js("Date.now()")
actual fun currentTimeMillisCompat(): Long = jsNow().toLong()

/*
 * S10 — the Ghost Browser tool's WEB console, rendered by the SAME shared Compose UI as the phone and
 * the desktop. The cluster GB tool serves this bundle, so it runs on the GB origin and reads the live
 * cluster over same-origin fetch (WebRepo) — one account, no key. Same GbScaffold, same screens.
 */
@OptIn(ExperimentalComposeUiApi::class)
fun main() {
    CanvasBasedWindow(canvasElementId = "ComposeTarget") {
        GbTheme(dark = true) { WebConsole() }
    }
}

@Composable
private fun WebConsole() {
    val scope = rememberCoroutineScope()
    val st = remember { WebState() }
    val repo = remember { WebRepo(scope, st) }
    var screen by remember { mutableStateOf("browser") }

    val openUrl: (String) -> Unit = { openTab(it) }

    /*
     * THE GATE. Nothing renders until the cluster has said whether this browser is signed in: a
     * console that drew every screen empty for a signed-out visitor looked broken, and it was the
     * page a laptop whose platform hand-off had failed was left staring at. Signed out, the shared
     * sign-in page is the whole console; the password it takes is the one set in Settings.
     */
    val settings = remember { SettingsState() }
    var signedIn by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(Unit) {
        repo.authState { s, hp, u ->
            signedIn = s; settings.hasPassword.value = hp; settings.accountEmail.value = u; settings.connected.value = s
        }
    }
    when (signedIn) {
        null -> { Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) { Text("connecting…", color = MaterialTheme.colorScheme.onSurfaceVariant) }; return }
        false -> {
            SignInGate(settings, onSignIn = { e, p ->
                repo.login(e, p) { ok, msg -> settings.authMessage.value = msg; if (ok) { settings.accountEmail.value = e; settings.hasPassword.value = true; settings.connected.value = true; signedIn = true; repo.loadHome() } }
            }, appLabel = "Ghost Browser")
            return
        }
        true -> {}
    }

    // Load each tab's data when it is first opened (mirrors the desktop's per-screen LaunchedEffect).
    LaunchedEffect(screen) {
        when (screen) {
            "browser" -> if (st.platforms.value.isEmpty()) repo.loadHome()
            "flows" -> if (st.flows.value.isEmpty()) repo.loadFlows()
            "approvals" -> repo.loadApprovals()
            "agent" -> repo.openAssistant()
            "settings" -> { if (st.platforms.value.isEmpty()) repo.loadHome() }
        }
    }

    GbScaffold(
        host = "",
        tabCount = 1,
        selected = screen,
        onFocusUrl = {},
        onOpenSwitcher = {},
        onOpenMenu = {},
        onNav = { screen = it },
        showTopBar = false,   // the Browser tab renders its own address bar (live session)
        approvalsBadge = st.jobs.value.sumOf { it.proposals.size },
    ) {
        when (screen) {
            "browser" -> BrowserTab(st, repo, openExternal = openUrl)
            "agent" -> AssistantScreen(
                st.assistant,
                repo.assistantActions(openUrl = openUrl, openApprovals = { screen = "approvals" }, openSettings = { screen = "settings" }),
            )
            "flows" -> FlowsTab(st, repo, openExternal = openUrl)
            "approvals" -> ApprovalsScreen(
                jobs = st.jobs.value, loading = st.jobsLoading.value,
                onApprove = { j, p, t -> repo.approve(j, p, t) }, onDeny = { j, p -> repo.deny(j, p) },
                onStop = { repo.stopJob(it) }, onSay = { j, t -> repo.sayJob(j, t) },
                onOpenUrl = openUrl, onRefresh = { repo.loadApprovals() }, leads = st.leads.value,
            )
            "settings" -> WebSettingsShared(st, repo, settings, openUrl)
            else -> HomeScreen(st.platforms.value, st.feed.value, false, {}, {}, {}, {})
        }
    }
}

/**
 * THE ONE SETTINGS PAGE, on the web too. The console had its own hand-written page, so the
 * password fallback, the training line and every later section existed on the phone and the
 * desktop and not here. This feeds the shared page from the web state; the downloads screen and
 * the API tokens sheet open over it exactly as before.
 */
@Composable
private fun WebSettingsShared(st: WebState, repo: WebRepo, s: SettingsState, openUrl: (String) -> Unit) {
    var showDownloads by remember { mutableStateOf(false) }
    var showApiTokens by remember { mutableStateOf(false) }
    val modelActs = remember { repo.aiModelActions() }
    val tokenActs = remember { repo.apiTokenActions() }
    if (showDownloads) {
        LaunchedEffect(Unit) { repo.loadDownloads() }
        DownloadsScreen(st.downloads, DownloadsActions(
            onRefresh = { repo.loadDownloads() }, onDelete = { repo.deleteFile(it) }, onClose = { showDownloads = false },
        ))
        return
    }
    s.connected.value = st.connected.value || s.connected.value
    s.clusterStatus.value = if (s.connected.value) "Cluster: connected ✓" else "Cluster: sign in on this origin"
    s.clusterUrl.value = ""
    s.deviceKind.value = "web"
    s.deviceLine.value = "web console · served by the cluster Ghost Browser tool"
    s.platforms.value = st.platforms.value
    s.networkLine.value = "The cluster's Ghost Browser keeps its own in-image exit node; this console only reads and drives it."
    s.appLabel.value = "Ghost Browser Web"
    val handlers = remember(repo) {
        SettingsHandlers(
            onResync = { repo.loadHome(); repo.loadFlows(); repo.loadApprovals() },
            onOpenDownloads = { showDownloads = true },
            onLoadPlatforms = { repo.loadHome() }, onOpenPlatform = { _, site -> openUrl("https://" + site) },
            onSetTheme = {},
            aiModel = modelActs,
            onSetPassword = { pw -> repo.setPassword(pw) { ok, msg -> s.authMessage.value = msg; if (ok) s.hasPassword.value = true } },
            onOpenApiTokens = { showApiTokens = true },
            onOpenMcpSetup = { openTab("/mcp-setup.html") },
        )
    }
    Box(Modifier.fillMaxSize()) {
        SettingsScreenShared(s, st.aiModel, handlers, onClose = null)
        if (showApiTokens) ApiTokensSheet(st.apiTokens, tokenActs, connected = st.connected.value, onConnect = { showApiTokens = false }, onClose = { showApiTokens = false })
    }
}

/** Open a URL in a new browser tab — the web console hands pages off to a real tab. */
private fun openTab(url: String) { if (url.isNotBlank()) jsOpen(url) }
private fun jsOpen(url: String): Unit = js("window.open(url, '_blank')")

@Composable
private fun WebSettings(st: WebState, repo: WebRepo, openUrl: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var showDownloads by remember { mutableStateOf(false) }
    var showAiModel by remember { mutableStateOf(false) }
    var showApiTokens by remember { mutableStateOf(false) }
    val modelActs = remember { repo.aiModelActions() }
    val tokenActs = remember { repo.apiTokenActions() }
    if (showDownloads) {
        LaunchedEffect(Unit) { repo.loadDownloads() }
        DownloadsScreen(st.downloads, DownloadsActions(
            onRefresh = { repo.loadDownloads() }, onDelete = { repo.deleteFile(it) }, onClose = { showDownloads = false },
        ))
        return
    }
    Box(Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize().background(cs.background).verticalScroll(rememberScrollState()).padding(20.dp)) {
        Text("Settings", style = MaterialTheme.typography.headlineSmall)
        Text("The GB tool's web console — one account, same data as your apps", color = cs.onSurfaceVariant, fontSize = 12.sp)
        Spacer(Modifier.height(16.dp))

        Section("☁  Account & sync") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Spacer(Modifier.size(9.dp).clip(CircleShape).background(if (st.connected.value) Brand else cs.onSurfaceVariant))
                Spacer(Modifier.width(8.dp))
                Text(if (st.connected.value) "Cluster: connected ✓" else "Cluster: sign in on this origin", color = cs.onSurface, fontSize = 13.sp)
            }
            Spacer(Modifier.height(6.dp))
            Text("served by the cluster Ghost Browser tool", color = cs.onSurfaceVariant, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
            Spacer(Modifier.height(10.dp))
            OutlinedButton(onClick = { repo.loadHome(); repo.loadFlows(); repo.loadApprovals() }, shape = RoundedCornerShape(12.dp)) { Text("Re-sync now") }
        }

        Section("⬇  Downloads") {
            Text("Every file your Ghost Browser captured. Play, save, or delete.", color = cs.onSurfaceVariant, fontSize = 12.sp)
            Spacer(Modifier.height(8.dp))
            Button(onClick = { showDownloads = true }, shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Open downloads") }
        }

        Section("👤  Platforms") {
            if (st.platforms.value.isEmpty()) Text("Load your platforms from the cluster.", color = cs.onSurfaceVariant, fontSize = 12.sp)
            else st.platforms.value.forEach { p ->
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp).clip(RoundedCornerShape(10.dp)).background(cs.surfaceVariant)
                    .clickable { openUrl("https://" + p.site) }.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(p.label, fontSize = 14.sp, modifier = Modifier.weight(1f)); Text("open", color = Brand, fontSize = 12.sp)
                }
            }
            TextButton(onClick = { repo.loadHome() }) { Text("Load platforms from cluster") }
        }

        Section("⚡  AI model & keys") {
            Text(
                "The model + API keys the agent runs on — stored on the GB server, used by web, phone and desktop alike. Now: " +
                (st.aiModel.info.value?.model?.ifBlank { null } ?: st.assistant.model.value.ifBlank { "—" }),
                color = cs.onSurfaceVariant, fontSize = 12.sp,
            )
            Spacer(Modifier.height(10.dp))
            Button(onClick = { showAiModel = true }, shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Set model & keys") }
        }

        Section("🔑  API tokens") {
            Text("Bearer keys you can hand to a script or another machine to drive your Ghost Browser. Generate one, copy it once, revoke it when it is done.", color = cs.onSurfaceVariant, fontSize = 12.sp)
            Spacer(Modifier.height(10.dp))
            Button(onClick = { showApiTokens = true }, shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Manage API tokens") }
        }

        Spacer(Modifier.height(24.dp))
    }
    if (showAiModel) AiModelSheet(st.aiModel, modelActs, connected = st.connected.value, onConnect = { showAiModel = false }, onClose = { showAiModel = false })
    if (showApiTokens) ApiTokensSheet(st.apiTokens, tokenActs, connected = st.connected.value, onConnect = { showApiTokens = false }, onClose = { showApiTokens = false })
    }
}

@Composable
private fun Section(title: String, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(16.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, cs.outline),
        modifier = Modifier.fillMaxWidth().padding(bottom = 14.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(12.dp))
            content()
        }
    }
}
