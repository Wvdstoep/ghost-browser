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
    val devToolsOpen = mutableStateOf(false)
    val devToolsTab = mutableStateOf("Console")
    val devToolsOutput = mutableStateOf("")
    val devToolsLines = mutableStateOf<List<String>>(emptyList())
    val urlFocused = mutableStateOf(false)
    val searchFromWidget = mutableStateOf(false)
    val aiSettingsOpen = mutableStateOf(false)
    val desktopMode = mutableStateOf(false)
    val tabs = mutableStateOf<List<TabInfo>>(emptyList())
    val visitedPages = mutableStateOf<List<VisitedPage>>(emptyList())
    val clearHistoryConfirm = mutableStateOf(false)
    val flows = mutableStateOf<List<FlowInfo>>(emptyList())
    val flowsHint = mutableStateOf("")
    val openWatchersTab = mutableStateOf(false)
    val platforms = mutableStateOf<List<PlatformOpt>>(emptyList())
    val reconUi = engineer.myapp.gb.shared.ReconUi()
    // the assistant — one chat, one agent on the cluster (state shapes live in :shared)
    val assistant = engineer.myapp.gb.shared.AssistantUi()
    val aiModel = engineer.myapp.gb.shared.AiModelUi()
    val agentBusy = mutableStateOf(false)   // a turn is running (PiP + status)
    val agentTitle = mutableStateOf("Agent")                       // legacy on-device chat (kept for the local flow runner's journal)
    val agentMsgs = mutableStateOf<List<ChatMsg>>(emptyList())
    val pipThumb = mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null)   // live snapshot of the tab the agent is driving
    val clusterOn = mutableStateOf(false)
    val signInNeeded = mutableStateOf(false)
    // device hub (native, local render)
    val hubDevices = mutableStateOf<List<HubDevice>>(emptyList())
    val hubSummary = mutableStateOf("")
    /* The nightly training loop. One object feeds both the Training screen and each device's row in
       the hub, so the phone cannot say "idle" about a machine the desktop shows mid-round. */
    val training = mutableStateOf(engineer.myapp.gb.shared.TrainingWatch.View())
    /* The runs browser: the rows, and the one run open over the page. */
    val trainingRuns = mutableStateOf<List<engineer.myapp.gb.shared.TrainingWatch.RunRow>>(emptyList())
    /* The scoreboard: every measured round, whatever model trained it. Null until the tab asks. */
    val trainingResults = mutableStateOf<engineer.myapp.gb.shared.TrainingWatch.Results?>(null)
    /* Side by side: what may be compared, and the run being watched. */
    val compareOffer = mutableStateOf<engineer.myapp.gb.shared.TrainingWatch.CompareOffer?>(null)
    val compareRun = mutableStateOf<engineer.myapp.gb.shared.TrainingWatch.CompareRun?>(null)
    val trainingRun = mutableStateOf<engineer.myapp.gb.shared.TrainingWatch.RunDetail?>(null)
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
    /*
     * PROFILES — its own destination now, not a chip row inside Settings.
     *
     * The role a profile uses lived in this phone's own preferences (`profileRolesJson`), so the
     * cluster never knew about it, the desktop never knew about it, and reinstalling the app lost
     * it. It is a field on the profile on the server now; this is only what the screen renders.
     */
    val profileCards = mutableStateOf<List<engineer.myapp.gb.shared.ProfileCard>>(emptyList())
    val profileRoleNames = mutableStateOf<List<String>>(emptyList())
    val profileRoleDetail = mutableStateOf<engineer.myapp.gb.shared.RoleChoice?>(null)
    val profileStatus = mutableStateOf("")
    /* The address bar slides away while a page is scrolled down. Fed by the WebView's
       own scroll reports; see ChromeScroll for why it is direction-with-a-threshold and not position. */
    val chrome = engineer.myapp.gb.shared.ChromeScroll()
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
    val onNav: (String) -> Unit,                 // "browser" | "flows" | "profiles"
    val onOpenSettings: () -> Unit,
    val onOpenAgent: () -> Unit,
    val onCloseAgent: () -> Unit,
    val assistant: engineer.myapp.gb.shared.AssistantActions,
    val aiModel: engineer.myapp.gb.shared.AiModelActions,
    val onLoadFlows: () -> Unit,
    val onRunFlow: (String, String) -> Unit,
    val onCreateFlow: (String, String) -> Unit,
    val onCreateSecurityFlow: (String, String, String, String) -> Unit,
    val securitySync: Boolean,
    val onSecuritySync: (Boolean) -> Unit,
    val onOpenAllReconResults: () -> Unit,
    val onOpenRangeResults: () -> Unit,
    val rangeScanner: engineer.myapp.gbmobile.LocalRangeScanner,
    val clusterForResearch: Boolean = false,
    val onResearchRangeEvidence: (engineer.myapp.gbmobile.RangeEvidence, String?) -> Unit = { _, _ -> },
    val onOpenRangeApp: (engineer.myapp.gbmobile.RangeEvidence) -> Unit = {},
    val onLoadPlatforms: () -> Unit,
    val onOpenPlatform: (String, String) -> Unit,
    val onOpenLearn: (String) -> Unit,
    val onRefreshHome: () -> Unit,
    // overflow menu / browser actions
    val onOpenRecon: () -> Unit = {},
    val onRunReconScan: (String, Boolean) -> Unit = { _, _ -> },
    val onCopyReconSnippet: (String) -> Unit = {},
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
    /* Defaulted, so adding the pipeline page did not force every construction site to be touched. */
    val onRefreshTraining: () -> Unit = {},
    val onPromoteRound: (String) -> Unit = {},
    val onSetTrainingAuto: (Boolean) -> Unit = {},
    val onSetHarvest: (Boolean) -> Unit = {},
    val onSetResight: (Boolean) -> Unit = {},
    val onSetServing: (String?, String?) -> Unit = { _, _ -> },
    val onSetGpu: (Map<String, String>) -> Unit = {},
    val onDestroyGpu: () -> Unit = {},
    val onSetJudge: (Boolean) -> Unit = {},
    /* The practice collector and autopilot serving - the two switches phase 5 added. */
    val onSetPractice: (Boolean) -> Unit = {},
    val onSetAutopilot: (Boolean) -> Unit = {},
    val onStopRound: (String) -> Unit = {},
    val onNodeJoin: (String) -> Unit = {},
    val onNodeRevoke: (String) -> Unit = {},
    val onSetModal: (Map<String, String>) -> Unit = {},
    val onModalStart: () -> Unit = {},
    val onTrialStudents: (List<String>) -> Unit = {},
    val onLoadResults: () -> Unit = {},
    val onLoadCompare: () -> Unit = {},
    val onCompareRecorded: (String, String) -> Unit = { _, _ -> },
    val onCompareLive: (String, String) -> Unit = { _, _ -> },
    val onCompareStop: () -> Unit = {},
    val onModalStop: () -> Unit = {},
    val onLoadRuns: () -> Unit = {},
    val onOpenRun: (String) -> Unit = {},
    val onLabelStep: (String, Int, String) -> Unit = { _, _, _ -> },
    val onRunRoundNow: () -> Unit = {},
    val onAllowTrainer: (String, Boolean) -> Unit = { _, _ -> },
    val onSetUpTrainer: (String) -> Unit = {},
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
    val onDeleteRecording: (id: String) -> Unit = {},
    // profiles — the logged-in identities and the role each one uses
    val onLoadProfiles: () -> Unit = {},
    val onOpenProfile: (engineer.myapp.gb.shared.ProfileCard) -> Unit = {},
    val onReadRole: (String) -> Unit = {},
    val onSetProfileRole: (profile: String, role: String) -> Unit = { _, _ -> },
    val onCreateProfile: (name: String, site: String) -> Unit = { _, _ -> },
    val onRenameProfile: (profile: String, to: String) -> Unit = { _, _ -> },
    val onDuplicateProfile: (profile: String, to: String) -> Unit = { _, _ -> },
    val onClearProfileLogin: (engineer.myapp.gb.shared.ProfileCard) -> Unit = {},
    val onDeleteProfile: (engineer.myapp.gb.shared.ProfileCard) -> Unit = {},
    val onOpenDevTools: () -> Unit = {},
    val onDevToolsSelect: (String) -> Unit = {},
    val onDevToolsEvaluate: (String) -> Unit = {},
    val onClearHistory: () -> Unit = {},
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
    if (shell.signInNeeded.value) {
        Column(Modifier.fillMaxSize().background(cs.background).padding(28.dp), verticalArrangement = Arrangement.Center) {
            Text("Ghost Browser Mobile", color = cs.primary, fontSize = 15.sp)
            Spacer(Modifier.height(18.dp))
            Text("One account. Your browser.", color = cs.onBackground, fontSize = 30.sp)
            Spacer(Modifier.height(12.dp))
            Text("Sign in with your MyApp.Engineer email and password, or Google. This phone connects to your hosted browser automatically.", color = cs.onSurfaceVariant)
            Spacer(Modifier.height(24.dp))
            Button(onClick = settingsAct.onSignIn, modifier = Modifier.fillMaxWidth()) { Text("Sign in with MyApp.Engineer") }
            Spacer(Modifier.height(12.dp))
            Text(settingsUi.clusterStatus.value, color = cs.onSurfaceVariant, fontSize = 13.sp)
            TextButton(onClick = { shell.signInNeeded.value = false }, modifier = Modifier.fillMaxWidth()) { Text("Browse on this phone without connecting") }
        }
        return
    }
    val screen = shell.screen.value
    /*
     * CHROME THAT GETS OUT OF THE WAY WHILE YOU READ.
     *
     * Scrolling down a browser page hides the address bar; scrolling up brings it back.
     * Other pages keep the header visible so their menu always provides navigation.
     */
    val collapsible = screen == "browser"
    if (!collapsible) shell.chrome.reset()
    val chromeF = engineer.myapp.gb.shared.rememberChromeFraction(collapsible && shell.chrome.hidden.value)

    Box(Modifier.fillMaxSize().background(cs.background)) {
        Column(Modifier.fillMaxSize()) {
            if (screen == "browser") {
                engineer.myapp.gb.shared.CollapsingSlot(chromeF, fromTop = true) { TopBar(shell, act) }
            } else TopBar(shell, act)
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
                        LaunchedEffect(shell.openWatchersTab.value) {
                            if (shell.openWatchersTab.value) {
                                sub = 1
                                shell.openWatchersTab.value = false
                            }
                        }
                        Column(Modifier.fillMaxSize().background(cs.background)) {
                            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)
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
                                onCreateSecurity = { n, t, s, p -> act.onCreateSecurityFlow(n, t, s, p) },
                                securitySync = act.securitySync, onSecuritySync = act.onSecuritySync, showSecuritySync = true,
                                modifier = Modifier.weight(1f).fillMaxWidth(),
                            ) else engineer.myapp.gb.shared.WatchersScreen(
                                watchers = shell.watchers.value, roles = shell.watcherRoles.value, profiles = shell.watcherProfiles.value,
                                automations = shell.flows.value, loading = shell.watchersLoading.value,
                                onSave = { id, n, m, r, g, p, aid, iv, fuF, fuR -> act.onSaveWatcher(id, n, m, r, g, p, aid, iv, fuF, fuR) },
                                onToggle = { id, a -> act.onToggleWatcher(id, a) }, onOpenResults = { act.onOpenWatcherResults(it) },
                                onRefresh = act.onLoadWatchers, securitySync = act.securitySync,
                                onSecuritySync = act.onSecuritySync, showSecuritySync = true,
                                onOpenAllResults = act.onOpenAllReconResults,
                                onOpenRangeScan = { act.rangeScanner.focusEvidenceId.value = -1L; act.rangeScanner.open.value = true },
                                modifier = Modifier.weight(1f).fillMaxWidth(),
                            )
                        }
                    }
                    "agent" -> engineer.myapp.gb.shared.AssistantScreen(shell.assistant, act.assistant)
                    "approvals" -> engineer.myapp.gb.shared.ApprovalsScreen(
                        jobs = shell.jobs.value, loading = shell.jobsLoading.value,
                        onApprove = { j, p, t -> act.onApprove(j, p, t) }, onDeny = { j, p -> act.onDeny(j, p) },
                        onStop = { act.onStopJob(it) }, onSay = { j, t -> act.onSayJob(j, t) },
                        onOpenUrl = { act.onUrlGo(it) }, onRefresh = act.onRefreshApprovals,
                        leads = shell.leads.value,
                    )
                    /*
                     * PROFILES. Pressing one still opens it in a NEW TAB in that profile's own
                     * cookie jar — the part of the old UI that was right, kept exactly.
                     */
                    "profiles" -> engineer.myapp.gb.shared.ProfilesScreen(
                        profiles = shell.profileCards.value,
                        onOpen = { p -> act.onOpenProfile(p) },
                        onRefresh = { act.onLoadProfiles(); act.onLoadPlatforms() },
                        phonePlatforms = settingsUi.platforms.value,
                        onOpenPhonePlatform = { p -> act.onOpenPlatform(p.profile, p.site) },
                        onSetPhoneCookieSync = settingsAct.onSetCookieSync,
                        roleNames = shell.profileRoleNames.value,
                        roleDetail = shell.profileRoleDetail.value,
                        onReadRole = { r -> act.onReadRole(r) },
                        onSetRole = { p, r -> act.onSetProfileRole(p, r) },
                        onCreate = { n, s -> act.onCreateProfile(n, s) },
                        onRename = { p, to -> act.onRenameProfile(p, to) },
                        onDuplicate = { p, to -> act.onDuplicateProfile(p, to) },
                        onClearLogin = { p -> act.onClearProfileLogin(p) },
                        onDelete = { p -> act.onDeleteProfile(p) },
                        status = shell.profileStatus.value,
                    )
                    "settings" -> PhoneSettings(settingsUi, settingsAct, shell, act) { act.onNav("browser") }
                    "downloads" -> engineer.myapp.gb.shared.DownloadsScreen(shell.downloads, engineer.myapp.gb.shared.DownloadsActions(onRefresh = act.onLoadFiles, onDelete = act.onDeleteFile, onClose = { act.onNav("settings") }, onDeleteRecording = act.onDeleteRecording))
                    "devices" -> engineer.myapp.gb.shared.DeviceHubScreen(
                        shell.hubDevices.value, shell.hubSummary.value, act.onRefreshHub, System.currentTimeMillis(),
                    )
                    /* The same pipeline page the desktop shows. Ask anywhere, see it everywhere. */
                    "training" -> engineer.myapp.gb.shared.TrainingScreen(
                        shell.training.value,
                        onRefresh = act.onRefreshTraining,
                        onPromote = act.onPromoteRound,
                        onSetAuto = act.onSetTrainingAuto,
                        onRunNow = act.onRunRoundNow,
                        onAllowTrainer = act.onAllowTrainer,
                        onSetUpTrainer = act.onSetUpTrainer,
                        onSetHarvest = act.onSetHarvest,
                        onSetResight = act.onSetResight,
                        onSetServing = act.onSetServing,
                        onSetGpu = act.onSetGpu,
                        onDestroyGpu = act.onDestroyGpu,
                        onSetJudge = act.onSetJudge,
                        onSetPractice = act.onSetPractice,
                        onSetAutopilot = act.onSetAutopilot,
                        onStopRound = act.onStopRound,
                        onNodeJoin = act.onNodeJoin,
                        onNodeRevoke = act.onNodeRevoke,
                        onSetModal = act.onSetModal,
                        onModalStart = act.onModalStart,
                        onTrialStudents = act.onTrialStudents,
                        results = shell.trainingResults.value,
                        onLoadResults = act.onLoadResults,
                        compareOffer = shell.compareOffer.value,
                        compareRun = shell.compareRun.value,
                        onLoadCompare = act.onLoadCompare,
                        onCompareRecorded = act.onCompareRecorded,
                        onCompareLive = act.onCompareLive,
                        onCompareStop = act.onCompareStop,
                        onModalStop = act.onModalStop,
                        runs = shell.trainingRuns.value,
                        runDetail = shell.trainingRun.value,
                        onLoadRuns = act.onLoadRuns,
                        onOpenRun = act.onOpenRun,
                        onCloseRun = { shell.trainingRun.value = null },
                        onLabelStep = act.onLabelStep,
                    )
                    else -> if (shell.url.value.isBlank()) engineer.myapp.gb.shared.HomeScreen(   // new/blank tab → shared home
                        platforms = shell.platforms.value, feed = shell.homeFeed.value, loading = shell.homeFeedLoading.value,
                        onSearch = { act.onFocusUrl() }, onOpenPlatform = { p -> act.onOpenPlatform(p.profile, p.site) },
                        onOpenLearn = { act.onOpenLearn(it) }, onRefresh = { act.onRefreshHome() },
                    )
                }
            }
            /*
             * WHAT THE RING IS DOING, WHEREVER IT IS DOING IT.
             *
             * The owner asks here and the job may run on the desktop, so this is read from the
             * cluster, not from this phone. One UI across two devices means the surface the question
             * was asked on is the surface that has to answer it.
             */
            engineer.myapp.gb.shared.RingWorkStrip()
        }

        if (shell.switcherOpen.value) TabGrid(shell, act)
        if (shell.menuOpen.value) OverflowMenu(shell, act)
        if (shell.devToolsOpen.value) MobileDevTools(shell, act)
        if (shell.clearHistoryConfirm.value) AlertDialog(
            onDismissRequest = { shell.clearHistoryConfirm.value = false },
            title = { Text("Clear visited links?") },
            text = { Text("This removes saved address suggestions for the current profile only.") },
            confirmButton = { TextButton(onClick = { shell.clearHistoryConfirm.value = false; act.onClearHistory() }) { Text("Clear") } },
            dismissButton = { TextButton(onClick = { shell.clearHistoryConfirm.value = false }) { Text("Cancel") } },
        )
        if (shell.urlFocused.value) Omnibox(shell, act)
        if (shell.aiSettingsOpen.value) engineer.myapp.gb.shared.AiModelSheet(shell.aiModel, act.aiModel, connected = shell.assistant.connected.value, onConnect = { act.onCloseAiSettings(); act.assistant.onConnect() }, onClose = act.onCloseAiSettings)
        if (shell.reconUi.isOpen.value) engineer.myapp.gb.shared.ReconSheet(shell.reconUi, engineer.myapp.gb.shared.ReconActions(onScan = { target, comp -> act.onRunReconScan(target, comp) }, onRunSessionProbe = { target -> act.onRunReconScan(target, true) }, onClose = { shell.reconUi.isOpen.value = false }, onCopySnippet = { act.onCopyReconSnippet(it) }))
        RangeScanDialog(act.rangeScanner, act.onOpenRangeResults, act.clusterForResearch,
            act.onResearchRangeEvidence, act.onOpenRangeApp)
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
                    engineer.myapp.gb.shared.ReconAddressBarIcon(ui = shell.reconUi, currentUrl = shell.url.value, onClick = act.onOpenRecon)
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

/* ── Omnibox (focused URL, Chrome-style) ─────────────────────────────────────────────────────── */

@Composable
private fun Omnibox(shell: ShellUi, act: ShellActions) {
    val cs = MaterialTheme.colorScheme
    var q by remember { mutableStateOf(if (shell.searchFromWidget.value) "" else shell.url.value) }
    val fr = remember { FocusRequester() }
    LaunchedEffect(Unit) { shell.searchFromWidget.value = false; runCatching { fr.requestFocus() } }
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
                val visited = VisitedHistory.match(shell.visitedPages.value, q)
                if (visited.isNotEmpty()) {
                    Text("Visited", color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.padding(start = 16.dp, top = 14.dp, bottom = 4.dp))
                    visited.forEach { page -> SuggestRow(Icons.Default.History, page.title.ifBlank { page.url }, page.url) { act.onUrlGo(page.url) } }
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
                MenuRow(Icons.Default.Public, "Browser") { act.onCloseMenu(); act.onNav("browser") }
                MenuRow(Icons.Default.Bolt, "Agent") { act.onCloseMenu(); act.onOpenAgent() }
                MenuRow(Icons.Default.AccountTree, "Flows") { act.onCloseMenu(); act.onNav("flows") }
                MenuRow(Icons.Default.SwitchAccount, "Profiles") { act.onCloseMenu(); act.onNav("profiles") }
                MenuRow(Icons.Default.Verified, "Approvals", badge = shell.jobs.value.sumOf { it.proposals.size }) { act.onCloseMenu(); act.onOpenApprovals() }
                MenuRow(Icons.Default.DevicesOther, "Device Hub") { act.onCloseMenu(); act.onOpenHub() }
                MenuRow(Icons.Default.Radar, "Range discovery") { act.onCloseMenu(); act.rangeScanner.focusEvidenceId.value = -1L; act.rangeScanner.open.value = true }
                MenuDivider()
                MenuRow(Icons.Default.Code, "Developer tools") { act.onCloseMenu(); act.onOpenDevTools() }
                MenuRow(Icons.Default.DeleteSweep, "Clear visited links") { act.onCloseMenu(); shell.clearHistoryConfirm.value = true }
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
private fun MenuRow(icon: ImageVector, label: String, badge: Int = 0, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().clickable { onClick() }.padding(horizontal = 18.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(20.dp))
        Text(label, color = cs.onSurface, fontSize = 15.sp, modifier = Modifier.weight(1f))
        if (badge > 0) Badge(containerColor = Brand, contentColor = BrandOn) { Text("$badge") }
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
            Text("Profile: ${t.profile}", color = cs.onSurfaceVariant, fontSize = 11.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
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

/**
 * THE ONE SETTINGS PAGE, fed from the phone's own state. The phone keeps its SettingsUi (the
 * activity, the on-device model, the connection) and the shared page reads it through a
 * SettingsState it fills on every pass; the handlers are the phone's own actions, and the model
 * section is the same AiModelUi/AiModelActions the model sheet uses - one key ring everywhere.
 */
@androidx.compose.runtime.Composable
private fun PhoneSettings(ui: SettingsUi, sa: SettingsActions, shell: ShellUi, act: ShellActions, onClose: () -> Unit) {
    val st = androidx.compose.runtime.remember { engineer.myapp.gb.shared.SettingsState() }
    val local = androidx.compose.runtime.remember { engineer.myapp.gb.shared.LocalModelUi() }
    st.clusterUrl.value = ui.clusterUrl
    st.clusterStatus.value = ui.clusterStatus.value
    st.connected.value = ui.connected.value
    st.deviceKind.value = "phone"
    st.trainingLine.value = sa.trainingLine()
    st.networkLine.value = "This phone operates on its own real mobile IP — the strongest fingerprint for Cloudflare-gated sites. The cluster's Ghost Browser keeps its own in-image exit node."
    st.themeDark.value = ui.themeMode.value != 1
    st.activity.value = ui.log.value
    st.appLabel.value = "Ghost Browser Mobile"
    local.useLocal.value = ui.useLocal.value
    local.labels.value = ui.modelLabels.value
    local.index.value = ui.modelIndex.value
    local.status.value = ui.modelStatus.value
    local.progress.value = ui.modelProgress.value
    st.local.value = local
    val handlers = androidx.compose.runtime.remember(sa, act) {
        engineer.myapp.gb.shared.SettingsHandlers(
            onSaveClusterUrl = sa.onSaveClusterUrl, onSignIn = sa.onSignIn, onSignOut = sa.onSignOut, onConnectToggle = sa.onConnectToggle,
            onSetPassword = sa.onSetPassword,
            onResync = sa.onResync, onOpenTraining = sa.onOpenTraining, onOpenDownloads = sa.onOpenDownloads,
            onOpenTailscale = sa.onOpenTailscale,
            onSetTheme = { dark -> sa.onSetTheme(if (dark) 0 else 1) }, onClearLog = sa.onClearLog,
            aiModel = act.aiModel,
            onSetUseLocal = sa.onSetUseLocal, onSelectLocalModel = sa.onSelectModelIndex, onDownloadLocalModel = sa.onDownloadModel,
        )
    }
    engineer.myapp.gb.shared.SettingsScreenShared(st, shell.aiModel, handlers, onClose = onClose)
}
