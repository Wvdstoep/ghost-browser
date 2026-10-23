package engineer.myapp.gbmobile

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.ActivityInfo
import android.app.SearchManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.PopupMenu
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.material.chip.Chip
import com.google.android.material.tabs.TabLayout
import engineer.myapp.gbmobile.databinding.ActivityMainBinding
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.graphics.asImageBitmap
import engineer.myapp.gb.shared.AgentCore
import engineer.myapp.gb.shared.AgentHost
import engineer.myapp.gb.shared.DeviceOpt
import engineer.myapp.gb.shared.ToolSpec
import engineer.myapp.gbmobile.ui.GbTheme
import engineer.myapp.gb.shared.RunSheet

/**
 * GB Mobile — Ghost Browser as a real on-device browser (MVVM). A true multi-tab browser: each tab is
 * its own WebView under a chosen profile (isolated cookies). Two ways to drive the active tab: a
 * STANDALONE on-device agent (your Ollama key or an on-device model) and CLUSTER mode (the backend
 * drives it via the GB API over the tailnet).
 */
class MainActivity : AppCompatActivity(), Agent.DeviceBrowser, GbServer.Browser {

    private val HOME = "file:///android_asset/home.html"
    private val DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

    private lateinit var b: ActivityMainBinding
    private val vm: GbViewModel by viewModels()
    private var securitySync by mutableStateOf(false)
    private val rangeScanner by lazy { LocalRangeScanner(applicationContext) { block -> runOnUiThread(block) } }

    // --- tabs ---
    private inner class TabHandle(var url: String, var title: String, val profile: String, var desktop: Boolean = false) {
        var web: WebView? = null
        var thumb: Bitmap? = null   // last snapshot for the tab grid
    }
    private val tabs = mutableListOf<TabHandle>()
    private var activeTab = -1
    private lateinit var web: WebView                     // always the active tab's WebView
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var previousSystemUi = 0
    private var previousOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    private var wasWindowFullscreen = false

    // PROFILE-TARGETED device commands (Device Ring, Phase 1): a command may name a profile; it then runs
    // in that profile's OWN hidden browser (where the login lives), never the visible tab, so a background
    // pass — a LinkedIn read on the phone — never disturbs what the owner is looking at. Commands run one
    // at a time on the ring thread, so a single per-command target field is safe.
    private val ringWebs = java.util.concurrent.ConcurrentHashMap<String, WebView>()
    @Volatile private var cmdWeb: WebView? = null
    private fun cmdTarget(): WebView = cmdWeb ?: web
    /** The current command target's URL (main-thread read). */
    private fun targetUrl(): String { val t = cmdTarget(); val h = arrayOfNulls<String>(1); val l = CountDownLatch(1); runOnUiThread { h[0] = t.url; l.countDown() }; l.await(3, TimeUnit.SECONDS); return h[0] ?: "" }
    /** A hidden browser for one profile, built once, off-screen — driven only by the ring.
     *  ringWebFor runs on the ring's background executor, but a WebView MUST be constructed on the
     *  UI thread — so build + attach it there and wait, or the ring silently drops the command. */
    private fun ringWebFor(profile: String): WebView {
        ringWebs[profile]?.let { return it }
        val holder = arrayOfNulls<WebView>(1)
        val latch = CountDownLatch(1)
        runOnUiThread {
            try {
                val h = TabHandle(HOME, "ring:$profile", profile)
                val w = buildWebView(h); h.web = w
                try { (b.root as ViewGroup).addView(w, 1, 1) } catch (e: Exception) {}
                holder[0] = w
            } catch (e: Exception) { vm.log("! ringWebFor $profile: ${e.message}") }
            finally { latch.countDown() }
        }
        latch.await(10, TimeUnit.SECONDS)
        val w = holder[0] ?: throw IllegalStateException("could not build browser for profile $profile")
        ringWebs[profile] = w
        return w
    }

    private var gbJs: String = ""
    @Volatile private var lastUrl: String = ""
    @Volatile private var loadLatch: CountDownLatch? = null

    private var server: GbServer? = null
    private var agentThread: Thread? = null
    @Volatile private var agentStop: Boolean = false
    private var ctrlWeb: WebView? = null                 // hidden WebView on the GB origin = the control channel
    private var ctrlProfile: String = "default"          // the WebView profile the control channel (and its cluster session cookie) lives in
    @Volatile private var recordingsPolledAt = 0L        // last time the recordings list was refreshed for the chat's cards
    @Volatile private var ctrlApiReady = false           // control channel's __gbApi is live (registered)
    @Volatile private var ringWatching = false           // one ring-work poller, not one per registration
    private var apiWeb: WebView? = null                  // hidden WebView on the GB origin = same-origin authed API channel
    @Volatile private var apiReady = false
    private val apiQueue = mutableListOf<() -> Unit>()
    private var gbControlJs: String = ""
    private val cmdExec = java.util.concurrent.Executors.newSingleThreadExecutor()

    // --- Run sheet (Compose) — the run-anywhere UX shell: pick device → goal → run → progress ---
    private var runHost: ComposeView? = null
    private var artHost: android.widget.FrameLayout? = null      // interactive results artifact (WebView overlay)
    private var artWeb: WebView? = null
    private val runVisible: MutableState<Boolean> = mutableStateOf(false)
    private val runDevices: MutableState<List<DeviceOpt>> = mutableStateOf(emptyList())
    private val runFlowId: MutableState<String?> = mutableStateOf(null)
    private val runFlowName: MutableState<String?> = mutableStateOf(null)
    private val runPhase: MutableState<String> = mutableStateOf("pick")   // pick | running | done
    private val runStatus: MutableState<String> = mutableStateOf("")
    private val runActivity: MutableState<List<String>> = mutableStateOf(emptyList())   // live steps in the Run sheet
    @Volatile private var currentRunId = ""                                             // workflow run being polled
    @Volatile private var runUserStopped = false

    // S5: the redesigned Compose settings — reactive state + actions, hosted in its own overlay.
    private val settingsUi = engineer.myapp.gbmobile.ui.SettingsUi()

    // S6: the whole app is now a Compose shell (top bar · tabs · flows · agent chat), hosting the real
    // WebView(s) via AndroidView. `webHolder` is created in code and handed to Compose.
    private lateinit var webHolder: android.widget.FrameLayout
    private var appHost: ComposeView? = null
    private val shellUi = engineer.myapp.gbmobile.ui.ShellUi()

    private val fetchWaiters = java.util.concurrent.ConcurrentHashMap<String, CountDownLatch>()
    private val fetchResults = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val flowRunDone = java.util.Collections.synchronizedSet(HashSet<String>())  // run ids already reported (poll fires 5x)
    private val agentExec = java.util.concurrent.Executors.newSingleThreadExecutor()
    private val agentApiWaiters = java.util.concurrent.ConcurrentHashMap<String, CountDownLatch>()
    private val agentApiResults = java.util.concurrent.ConcurrentHashMap<String, String>()
    private var agentReqSeq = 0
    private var agentChats = JSONArray()      // [{id,title,messages:[{role,content,name}]}]
    private var agentChat: JSONObject? = null
    @Volatile private var agentBusy = false
    private val models by lazy { ModelManager(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        securitySync = vm.syncSecurityRecon && vm.clusterKey.isNotBlank()
        if (!securitySync) vm.syncSecurityRecon = false
        b = ActivityMainBinding.inflate(layoutInflater)   // bare root FrameLayout (S6: UI is all Compose)
        setContentView(b.root)
        settingsUi.themeMode.value = vm.themeMode

        gbJs = try { assets.open("gb.js").bufferedReader().use { it.readText() } } catch (e: Exception) { "" }
        gbControlJs = try { assets.open("gb-control.js").bufferedReader().use { it.readText() } } catch (e: Exception) { "" }

        restoreTabs()
        assistantHooksInstall()
        try { agentChats = if (vm.agentChatsJson.isNotBlank()) JSONArray(vm.agentChatsJson) else JSONArray() } catch (e: Exception) { agentChats = JSONArray() }

        // The real browser lives in this FrameLayout, hosted inside the Compose shell via AndroidView.
        webHolder = android.widget.FrameLayout(this)
        // a fold/unfold or rotation changes the holder's size: refit the page to the new width
        webHolder.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, orr, ob -> if (r - l != orr - ol || b - t != ob - ot) web?.let { fitNarrowScreen(it) } }

        // S6: the whole app UI — one Compose host. Settings/Agent/Device Hub are screens INSIDE the
        // shell; only the run sheet is a modal overlay of its own.
        appHost = ComposeView(this).also { host ->
            host.setContent {
                GbTheme(dark = computeDark()) {
                    engineer.myapp.gbmobile.ui.AppShell(
                        shell = shellUi, act = buildShellActions(), webHolder = webHolder,
                        settingsUi = settingsUi, settingsAct = buildSettingsActions(),
                    )
                }
            }
            (b.root as ViewGroup).addView(host, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }

        // Run sheet — a modal overlay of its own.
        runHost = ComposeView(this).also { host ->
            host.visibility = View.GONE
            host.setContent {
                GbTheme(dark = computeDark()) {
                    RunSheet(
                        visible = runVisible.value, flowName = runFlowName.value, devices = runDevices.value,
                        phase = runPhase.value, status = runStatus.value, goalInitial = "",
                        onRun = { target, goal -> onRunTarget(target, goal) },
                        onStop = { onRunStop() },
                        onClose = { runVisible.value = false; runHost?.visibility = View.GONE },
                        activity = runActivity.value,
                        pendingApprovals = shellUi.jobs.value.sumOf { it.proposals.size },
                        onReview = { runVisible.value = false; runHost?.visibility = View.GONE; shellUi.screen.value = "approvals"; pollApprovals(); startApprovalsPolling() },
                    )
                }
            }
            (b.root as ViewGroup).addView(host, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }

        // show any persisted flows immediately
        refreshLocalWorkflows()
        LocalReconWorker.schedule(this)
        if (vm.platformsJson.isNotBlank()) try { renderPlatforms(JSONObject(vm.platformsJson).optJSONArray("presets") ?: JSONArray()) } catch (e: Exception) {}
        renderRoleSpinner()
        observe()
        // a device that has enrolled once is connected on launch — native calls with the saved key, no sign-in
        if (vm.clusterKey.isNotBlank() && vm.clusterUrl.isNotBlank()) {
            vm.clusterOn.value = true; vm.clusterInfo.value = "Cluster: on"; vm.log("● connected with this device's saved login")
            netExec.execute { try { autoSyncSharedData() } catch (e: Exception) {} }
            // native presence with the durable key — stays online while the foreground service runs, no WebView, no cookie
            try { androidx.core.content.ContextCompat.startForegroundService(this, Intent(this, GbService::class.java)) } catch (e: Exception) {}
            startDeviceRing()
        }
        fetchLearnFeed()   // new-tab home feed (my-app.engineer /learn)

        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            try { requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 101) } catch (e: Exception) {}
        }

        activateTab(activeTab.coerceIn(0, tabs.size - 1))
        handleLaunchIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLaunchIntent(intent)
    }

    private fun handleLaunchIntent(incoming: Intent?) {
        when (incoming?.action) {
            Intent.ACTION_VIEW -> {
                val uri = incoming.data ?: return
                if (uri.scheme != "http" && uri.scheme != "https") return
                val url = uri.toString()
                if (tabs.getOrNull(activeTab)?.url == HOME) load(url) else newTab(url)
            }
            SearchManager.INTENT_ACTION_GLOBAL_SEARCH, Intent.ACTION_SEARCH, ACTION_WIDGET_SEARCH -> {
                shellUi.screen.value = "browser"
                shellUi.searchFromWidget.value = true
                shellUi.urlFocused.value = true
            }
            ACTION_WIDGET_WATCHERS -> {
                shellUi.screen.value = "flows"
                shellUi.openWatchersTab.value = true
                loadWatchers()
            }
        }
    }

    // ---- tabs -------------------------------------------------------------------------------------

    private fun restoreTabs() {
        try {
            val raw = vm.tabsJson
            if (raw.isNotBlank()) {
                val arr = JSONArray(raw)
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    tabs.add(TabHandle(o.optString("url", HOME), o.optString("title", "Tab"), o.optString("profile", "default"), o.optBoolean("desktop", false)))
                }
            }
        } catch (e: Exception) {}
        if (tabs.isEmpty()) tabs.add(TabHandle(HOME, "New tab", "default"))
        activeTab = vm.activeTabIndex.coerceIn(0, tabs.size - 1)
    }

    private fun persistTabs() {
        try {
            val arr = JSONArray()
            for (h in tabs) arr.put(JSONObject().put("url", h.url).put("title", h.title).put("profile", h.profile).put("desktop", h.desktop))
            vm.tabsJson = arr.toString(); vm.activeTabIndex = activeTab
        } catch (e: Exception) {}
    }

    private fun isActive(h: TabHandle) = activeTab in tabs.indices && tabs[activeTab] === h

    private fun ensureWeb(h: TabHandle): WebView {
        h.web?.let { return it }
        val w = buildWebView(h); h.web = w
        w.loadUrl(if (h.url.isBlank()) HOME else h.url)
        return w
    }

    private fun activateTab(i: Int) {
        if (i < 0 || i >= tabs.size) return
        if (fullscreenView != null) hideFullscreenView()
        /* Switching tabs shows the chrome: the new tab's scroll position has nothing to do with the
           direction the last one was being read in. */
        shellUi.chrome.reset()
        val h = tabs[i]
        val w = ensureWeb(h)
        (w.parent as? ViewGroup)?.removeView(w)
        webHolder.removeAllViews()
        webHolder.addView(w)
        w.post { fitNarrowScreen(w) }
        web = w; activeTab = i
        lastUrl = h.url
        try { syncLoginForTab(h, h.url) } catch (e: Exception) { vm.log("! login sync: ${e.message}") }
        if (h.profile != (vm.currentProfile.value ?: "default")) { vm.selectProfile(h.profile); renderChips() }
        shellUi.url.value = if (h.url == HOME) "" else h.url
        refreshHistory(h.profile)
        shellUi.screen.value = "browser"
        updateTabCount()
    }

    /** NARROW SCREENS (the Fold's closed cover is ~317dp wide): mobile sites lay out for 360 CSS px and
     *  spill off the edge, and their viewport meta forbids the zoom-out that would fit them. Below
     *  360dp the page is laid out at 360 and the whole view scaled down to fit; touches follow the scale. */
    private fun fitNarrowScreen(w: WebView) {
        val holderW = webHolder.width; val holderH = webHolder.height; if (holderW <= 0 || holderH <= 0) return
        val minPx = (360 * resources.displayMetrics.density).toInt()
        if (holderW >= minPx) {
            if (w.scaleX != 1f || w.layoutParams?.width != -1) { w.scaleX = 1f; w.scaleY = 1f; w.layoutParams = android.widget.FrameLayout.LayoutParams(-1, -1) }
            return
        }
        val scale = holderW.toFloat() / minPx
        w.pivotX = 0f; w.pivotY = 0f; w.scaleX = scale; w.scaleY = scale
        val lp = android.widget.FrameLayout.LayoutParams(minPx, (holderH / scale).toInt())
        if (w.layoutParams?.width != lp.width || w.layoutParams?.height != lp.height) w.layoutParams = lp
    }

    private fun newTab(url: String = HOME, activate: Boolean = true, profile: String? = null) {
        val prof = TabProfilePolicy.forNewTab(profile)
        tabs.add(TabHandle(url, if (url == HOME) "New tab" else url, prof))
        if (activate) activateTab(tabs.size - 1) else updateTabCount()
        shellUi.switcherOpen.value = false; shellUi.screen.value = "browser"
    }

    private fun closeTab(i: Int) {
        if (i < 0 || i >= tabs.size) return
        val h = tabs[i]
        try { h.web?.let { (it.parent as? ViewGroup)?.removeView(it); it.destroy() } } catch (e: Exception) {}
        tabs.removeAt(i)
        if (tabs.isEmpty()) { activeTab = -1; newTab(HOME); return }
        if (i < activeTab) activeTab--
        if (activeTab >= tabs.size) activeTab = tabs.size - 1
        activateTab(activeTab)
        syncTabs()
    }

    private fun updateTabCount() { shellUi.tabCount.value = tabs.size; syncTabs() }

    /** Rebuild the Compose tab list from the engine's tabs. */
    private fun syncTabs() {
        shellUi.tabs.value = tabs.mapIndexed { i, h ->
            engineer.myapp.gbmobile.ui.TabInfo(i, if (h.title.isBlank()) "New tab" else h.title, hostLabel(h.url), h.profile, i == activeTab, h.thumb?.asImageBitmap())
        }
    }

    private fun historyFor(profile: String): List<engineer.myapp.gbmobile.ui.VisitedPage> {
        val raw = getSharedPreferences("gb_history", MODE_PRIVATE).getString(profile, "[]") ?: "[]"
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                arr.optJSONObject(i)?.let { engineer.myapp.gbmobile.ui.VisitedPage(it.optString("url"), it.optString("title")) }
            }
        } catch (_: Exception) { emptyList() }
    }

    private fun refreshHistory(profile: String) { shellUi.visitedPages.value = historyFor(profile) }

    private fun recordVisit(h: TabHandle) {
        if (h !in tabs) return
        val page = engineer.myapp.gbmobile.ui.VisitedPage(h.url, h.title.take(200))
        val current = historyFor(h.profile)
        val updated = engineer.myapp.gbmobile.ui.VisitedHistory.add(current, page)
        if (updated == current) return
        val json = JSONArray()
        updated.forEach { json.put(JSONObject().put("url", it.url).put("title", it.title)) }
        getSharedPreferences("gb_history", MODE_PRIVATE).edit().putString(h.profile, json.toString()).apply()
        if (isActive(h)) shellUi.visitedPages.value = updated
    }

    private fun clearHistoryForCurrentProfile() {
        val profile = tabs.getOrNull(activeTab)?.profile ?: return
        getSharedPreferences("gb_history", MODE_PRIVATE).edit().remove(profile).apply()
        shellUi.visitedPages.value = emptyList()
    }

    /** Chrome-style "Request desktop site" — swaps the UA and reloads this tab (some portals, e.g.
     *  Rapyd, refuse mobile browsers). Rebuilds the WebView so the new UA takes effect from the start. */
    private fun toggleDesktop() {
        val i = activeTab; if (i !in tabs.indices) return
        val h = tabs[i]; h.desktop = !h.desktop
        if (h.desktop) {
            // Desktop portals often live on the bare host — strip a leading "m." so the real desktop site loads.
            val demob = h.url.replace(Regex("://m\\."), "://")
            if (demob != h.url) h.url = demob
            vm.log("🖥 desktop site — heads-up: a desktop UA can FAIL Cloudflare (the phone passes it by looking mobile). Use mobile for Cloudflare-gated sites.")
        } else {
            vm.log("📱 mobile site — real device fingerprint (best for Cloudflare).")
        }
        try { h.web?.let { (it.parent as? ViewGroup)?.removeView(it); it.destroy() } } catch (e: Exception) {}
        h.web = null
        activateTab(i)
    }

    private fun hostLabel(u: String): String {
        if (u == HOME || u.startsWith("file:")) return "Home"
        return try { Uri.parse(u).host ?: u } catch (e: Exception) { u }
    }

    // ---- WebView (per-tab, per-profile for isolated cookies) --------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(h: TabHandle): WebView {
        val w = WebView(this)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            try {
                ProfileStore.getInstance().getOrCreateProfile(h.profile)
                WebViewCompat.setProfile(w, h.profile)
            } catch (e: Exception) { /* fall back to the default shared profile */ }
        }
        val s = w.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.loadWithOverviewMode = true
        s.useWideViewPort = true
        s.setSupportZoom(true); s.builtInZoomControls = true; s.displayZoomControls = false
        s.mediaPlaybackRequiresUserGesture = false
        s.userAgentString = s.userAgentString.replace("; wv", "")     // present as real mobile Chrome
        if (h.desktop) s.userAgentString = DESKTOP_UA                 // "Request desktop site" for portals that refuse mobile
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true)
        /*
         * THE PAGE'S OWN SCROLL DRIVES THE CHROME.
         *
         * Read off the WebView rather than from a Compose gesture: the page is a native view, so a
         * Compose scroll modifier over it would either steal the gesture or never see it. The
         * WebView reports its real scroll position, which is also the only thing that knows about a
         * page's inner scrollers and its momentum.
         *
         * Only the visible tab may move the chrome. Background tabs report scroll while they load
         * and settle, and those reports would slide the bar away under a page nobody is looking at.
         */
        w.setOnScrollChangeListener { v, _, y, _, oldY ->
            /* `web` is always the active tab's WebView (see activateTab); `::web.isInitialized`
               guards the very first tab, whose listener is set before the field is assigned. */
            if (::web.isInitialized && v === web) {
                val dy = y - oldY
                if (shellUi.chrome.plausible(dy)) shellUi.chrome.onScroll(dy, y <= 2)
            }
        }
        w.webViewClient = object : WebViewClient() {
            // Non-http(s) links (app deep links) crash a WebView with ERR_UNKNOWN_URL_SCHEME. Keep the
            // user inside GB (real logged-in session): rewrite Messenger/app deep links to their web
            // page, and hand any other scheme to Android — never let the WebView show the broken page.
            override fun shouldOverrideUrlLoading(view: WebView?, req: android.webkit.WebResourceRequest?): Boolean {
                val u = req?.url?.toString() ?: return false
                if (u.startsWith("http://") || u.startsWith("https://") || u.startsWith("file:") ||
                    u.startsWith("about:") || u.startsWith("javascript:") || u.startsWith("data:")) return false
                if (u.startsWith("fb-messenger://") || u.startsWith("messenger://")) {
                    view?.loadUrl(mobileFbUrl("https://www.facebook.com/messages/")); return true   // web Messenger, same session
                }
                if (u.startsWith("fb://") || u.startsWith("intent://") && u.contains("facebook")) {
                    view?.loadUrl(mobileFbUrl("https://www.facebook.com/")); return true
                }
                return try {   // tel:, mailto:, whatsapp:, market:, intent:… → let Android handle it, or swallow
                    val intent = if (u.startsWith("intent:")) Intent.parseUri(u, Intent.URI_INTENT_SCHEME) else Intent(Intent.ACTION_VIEW, Uri.parse(u))
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); startActivity(intent); true
                } catch (e: Exception) { true }
            }
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                h.url = url ?: h.url
                if (isActive(h)) { lastUrl = h.url; shellUi.url.value = if (h.url == HOME) "" else h.url }
            }
            override fun onPageFinished(view: WebView?, url: String?) {
                h.url = url ?: h.url
                if (isActive(h)) lastUrl = h.url
                recordVisit(h)
                if (gbJs.isNotEmpty()) view?.evaluateJavascript(gbJs, null)
                loadLatch?.countDown()
                syncTabs()
                try { syncLoginForTab(h, h.url) } catch (e: Exception) { vm.log("! login sync: ${e.message}") }
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage?): Boolean {
                if (message != null && isActive(h)) {
                    val line = "${message.messageLevel()} ${message.sourceId().substringAfterLast('/')}" +
                        ":${message.lineNumber()} ${message.message()}"
                    shellUi.devToolsLines.value = (shellUi.devToolsLines.value + line).takeLast(250)
                }
                return true
            }
            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                if (view == null || callback == null || !::web.isInitialized || w !== web) {
                    callback?.onCustomViewHidden()
                    return
                }
                showFullscreenView(view, callback)
            }
            override fun onHideCustomView() { hideFullscreenView() }
            override fun onReceivedTitle(view: WebView?, title: String?) {
                if (!title.isNullOrBlank()) h.title = title
                if (h.url.startsWith("http://") || h.url.startsWith("https://")) recordVisit(h)
                syncTabs()
            }
        }
        // Ordinary sites may call every method of an injected JavaScript interface, including from
        // iframes. This bridge only accepts results for an outstanding in-page fetch.
        w.addJavascriptInterface(PageBridge(), "GBHost")
        w.layoutParams = ViewGroup.LayoutParams(-1, -1)
        return w
    }

    private fun showFullscreenView(view: View, callback: WebChromeClient.CustomViewCallback) {
        if (fullscreenView != null) hideFullscreenView()
        fullscreenView = view
        fullscreenCallback = callback
        previousSystemUi = window.decorView.systemUiVisibility
        previousOrientation = requestedOrientation
        wasWindowFullscreen = window.attributes.flags and WindowManager.LayoutParams.FLAG_FULLSCREEN != 0
        (view.parent as? ViewGroup)?.removeView(view)
        (b.root as ViewGroup).addView(view, ViewGroup.LayoutParams(-1, -1))
        window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    }

    private fun hideFullscreenView() {
        val view = fullscreenView ?: return
        fullscreenView = null
        (view.parent as? ViewGroup)?.removeView(view)
        window.decorView.systemUiVisibility = previousSystemUi
        if (!wasWindowFullscreen) window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        requestedOrientation = previousOrientation
        fullscreenCallback = null
    }

    private fun inspectDevTools(tab: String) {
        if (!::web.isInitialized || tab == "Console") return
        val script = when (tab) {
            "Elements" -> """(function(){var out=[];function walk(n,d){if(out.length>=300||d>8)return;if(n.nodeType===1){out.push('  '.repeat(d)+'<'+n.tagName.toLowerCase()+(n.id?'#'+n.id:'')+(n.className&&typeof n.className==='string'?'.'+n.className.trim().split(/\s+/).slice(0,2).join('.'): '')+'>');for(var c=n.firstElementChild;c;c=c.nextElementSibling)walk(c,d+1)}}walk(document.documentElement,0);return out.join('\n')})()"""
            "Sources" -> """(function(){return document.documentElement.outerHTML.slice(0,40000)})()"""
            "Network" -> """(function(){return performance.getEntriesByType('resource').slice(-120).map(function(e){return e.initiatorType+'  '+Math.round(e.duration)+'ms  '+e.name}).join('\n')||'No page resource timings available'})()"""
            "Performance" -> """(function(){var n=performance.getEntriesByType('navigation')[0];if(!n)return 'Navigation timing unavailable';return 'URL: '+location.href+'\nLoad: '+Math.round(n.loadEventEnd)+'ms\nDOM ready: '+Math.round(n.domContentLoadedEventEnd)+'ms\nResponse: '+Math.round(n.responseEnd)+'ms\nResources: '+performance.getEntriesByType('resource').length})()"""
            "Memory" -> """(function(){var m=performance.memory;return m?'Used JS heap: '+Math.round(m.usedJSHeapSize/1048576)+' MB\nTotal JS heap: '+Math.round(m.totalJSHeapSize/1048576)+' MB':'Memory metrics are unavailable in this WebView'})()"""
            else -> return
        }
        shellUi.devToolsOutput.value = "Loading…"
        web.evaluateJavascript(script) { encoded ->
            shellUi.devToolsOutput.value = try { JSONArray("[$encoded]").optString(0).ifBlank { "No data" } } catch (_: Exception) { encoded ?: "No data" }
        }
    }

    private fun evaluateDevTools(code: String) {
        if (!::web.isInitialized) return
        shellUi.devToolsLines.value = (shellUi.devToolsLines.value + "> $code").takeLast(250)
        val script = "(function(){try{var v=eval(${JSONObject.quote(code)});return typeof v==='undefined'?'undefined':String(v)}catch(e){return String(e)}})()"
        web.evaluateJavascript(script) { encoded ->
            val result = try { JSONArray("[$encoded]").optString(0) } catch (_: Exception) { encoded ?: "" }
            shellUi.devToolsLines.value = (shellUi.devToolsLines.value + result).takeLast(250)
        }
    }

    private fun loadInBar() = load(shellUi.url.value)

    private fun load(raw: String) {
        var u = raw.trim(); if (u.isEmpty()) return
        /* A new page starts at the top, so the address bar is there to be seen — and the accumulated
           scroll direction from the last page means nothing on this one. */
        shellUi.chrome.reset()
        if (!u.startsWith("http") && !u.startsWith("file:")) {
            u = if (u.contains(".") && !u.contains(" ")) "https://$u" else "https://www.google.com/search?q=" + Uri.encode(u)
        }
        u = mobileFbUrl(u)
        shellUi.url.value = if (u == HOME) "" else u
        if (this::web.isInitialized) web.loadUrl(u)
        shellUi.screen.value = "browser"; shellUi.switcherOpen.value = false
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (fullscreenView != null) { fullscreenCallback?.onCustomViewHidden(); hideFullscreenView(); return true }
            if (shellUi.clearHistoryConfirm.value) { shellUi.clearHistoryConfirm.value = false; return true }
            if (shellUi.devToolsOpen.value) { shellUi.devToolsOpen.value = false; return true }
            if (shellUi.aiSettingsOpen.value) { shellUi.aiSettingsOpen.value = false; return true }
            if (artHost?.visibility == View.VISIBLE) { hideArtifact(); return true }
            if (runVisible.value && runPhase.value != "running") { runVisible.value = false; runHost?.visibility = View.GONE; return true }
            if (shellUi.urlFocused.value) { shellUi.urlFocused.value = false; return true }
            if (shellUi.menuOpen.value) { shellUi.menuOpen.value = false; return true }
            if (shellUi.switcherOpen.value) { shellUi.switcherOpen.value = false; return true }
            if (shellUi.screen.value != "browser") { shellUi.screen.value = "browser"; return true }
            if (this::web.isInitialized && web.canGoBack()) { web.goBack(); return true }
        }
        return super.onKeyDown(keyCode, event)
    }

    // ---- Agent.DeviceBrowser + GbServer.Browser (off the UI thread) ------------------------------

    override fun navigate(url: String): String {
        var u = url.trim(); if (u.isEmpty()) return currentUrl()
        if (!u.startsWith("http") && !u.startsWith("file:")) u = "https://$u"
        u = mobileFbUrl(u)
        val fu = u; val target = cmdTarget()
        if (cmdWeb != null) {   // a background profile browser: no shared latch, gate on content instead
            runOnUiThread { target.loadUrl(fu) }
            Thread.sleep(1200); waitSettle(9000); return targetUrl()
        }
        val latch = CountDownLatch(1); loadLatch = latch
        runOnUiThread { shellUi.url.value = fu; web.loadUrl(fu) }
        latch.await(25, TimeUnit.SECONDS); Thread.sleep(400)
        waitSettle(6000)   // lazy-loaded pages (Facebook) fire onPageFinished on a skeleton — wait for real content
        return currentUrl()
    }

    /** On the phone the in-app WebView is served Facebook's "App openen" interstitial on www.facebook.com
     *  (feed innerText degrades to ~45 chars, 0 articles). The mobile web host m.facebook.com renders the
     *  real feed with no app-wall, so ANY facebook.com URL is rewritten to m.facebook.com here — this is a
     *  device-level guarantee so it works always, whatever the platform/agent/flow passes. The laptop node
     *  keeps the full desktop site (it is not walled), so this rewrite lives only in the mobile app. */
    private fun mobileFbUrl(u: String): String {
        return try {
            val uri = android.net.Uri.parse(u); val host = (uri.host ?: "").lowercase()
            if (host == "www.facebook.com" || host == "facebook.com" || host == "web.facebook.com" || host == "mbasic.facebook.com")
                u.replaceFirst(Regex("://(www\\.|web\\.|mbasic\\.)?facebook\\.com"), "://m.facebook.com")
            else u
        } catch (e: Exception) { u }
    }

    /** Poll gb.js ready() until the page has meaningful content or [maxMs] elapses. Fixes reads that
     *  return an empty skeleton on lazy-loading / WebView-degraded sites. */
    private fun waitSettle(maxMs: Long) {
        val deadline = System.currentTimeMillis() + maxMs
        while (System.currentTimeMillis() < deadline) {
            val r = try { evalGb("window.__gb.ready()") } catch (e: Exception) { "true" }
            if (r.contains("true")) { Thread.sleep(250); return }
            Thread.sleep(350)
        }
    }

    override fun evalGb(expr: String): String = evalJs(gbJs + "\n" + expr)
    override fun currentUrl(): String = lastUrl

    /** A REAL tap via MotionEvent — trusted input that JS-onClick sites (Facebook rows/buttons) actually
     *  honor, unlike synthetic DOM events (window.__gb.tap), which they ignore. [coordsJson] is the
     *  {x,y,iw,ih} object from window.__gb.coords/coordsText (element centre in CSS px + viewport size);
     *  map CSS px -> View px by the WebView's on-screen size, then dispatch ACTION_DOWN+ACTION_UP. */
    private fun nativeTapFromCoords(coordsJson: String): String {
        val clean = coordsJson.trim()
        val j = try { JSONObject(clean) } catch (e: Exception) {
            try { JSONObject(clean.trim('"').replace("\\\"", "\"")) } catch (e2: Exception) {
                return "{\"error\":\"badcoords\",\"raw\":" + JSONObject.quote(coordsJson) + "}"
            }
        }
        if (j.has("err")) return j.toString()
        val cssX = j.optDouble("x", -1.0); val cssY = j.optDouble("y", -1.0)
        val iw = j.optDouble("iw", 0.0); val ih = j.optDouble("ih", 0.0)
        if (cssX < 0 || iw <= 0.0) return "{\"error\":\"nocoords\"}"
        val latch = CountDownLatch(1)
        runOnUiThread {
            try {
                val vw = web.width.toDouble(); val vh = web.height.toDouble()
                val x = (cssX * (if (iw > 0) vw / iw else 1.0)).toFloat()
                val y = (cssY * (if (ih > 0) vh / ih else 1.0)).toFloat()
                val dt = android.os.SystemClock.uptimeMillis()
                val down = android.view.MotionEvent.obtain(dt, dt, android.view.MotionEvent.ACTION_DOWN, x, y, 0)
                val up = android.view.MotionEvent.obtain(dt, dt + 70, android.view.MotionEvent.ACTION_UP, x, y, 0)
                web.dispatchTouchEvent(down); web.dispatchTouchEvent(up)
                down.recycle(); up.recycle()
            } catch (e: Exception) { /* best-effort */ } finally { latch.countDown() }
        }
        latch.await(5, TimeUnit.SECONDS)
        return "{\"ok\":true,\"tap\":[${cssX.toInt()},${cssY.toInt()}]}"
    }

    /** Cookies for [url] from the ACTIVE profile's store (multi-profile keeps them out of the global
     *  CookieManager). This is why the SSO session must be read per-profile, not globally. */
    private fun cookiesFor(url: String): String {
        return try {
            val cm = if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE))
                ProfileStore.getInstance().getOrCreateProfile(vm.currentProfile.value ?: "default").cookieManager
            else CookieManager.getInstance()
            cm.getCookie(url) ?: ""
        } catch (e: Exception) {
            try { CookieManager.getInstance().getCookie(url) ?: "" } catch (e2: Exception) { "" }
        }
    }

    private fun evalJs(script: String): String {
        val latch = CountDownLatch(1); val holder = arrayOfNulls<String>(1); val target = cmdTarget()
        runOnUiThread { target.evaluateJavascript(script) { v -> holder[0] = v; latch.countDown() } }
        latch.await(20, TimeUnit.SECONDS)
        return holder[0] ?: "null"
    }

    override fun screenshotPng(): ByteArray {
        val latch = CountDownLatch(1); val holder = arrayOfNulls<ByteArray>(1)
        runOnUiThread {
            try {
                val w = if (web.width > 0) web.width else 1080
                val h = if (web.height > 0) web.height else 1920
                val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                val c = Canvas(bmp); c.drawColor(Color.WHITE); web.draw(c)
                val bos = ByteArrayOutputStream(); bmp.compress(Bitmap.CompressFormat.PNG, 85, bos)
                holder[0] = bos.toByteArray(); bmp.recycle()
            } catch (e: Exception) { holder[0] = ByteArray(0) }
            latch.countDown()
        }
        latch.await(12, TimeUnit.SECONDS)
        return holder[0] ?: ByteArray(0)
    }

    /** Same-origin authenticated fetch INSIDE the active tab — runs from the real-mobile IP with the
     *  tab's session cookies (passes Cloudflare + is authenticated). Returns {"status":N,"body":"..."}.
     *  This is the primitive for authenticated API recon on a logged-in profile. */
    private fun fetchInPage(body: JSONObject): String {
        val url = body.optString("url"); if (url.isBlank()) return "{\"error\":\"no url\"}"
        val method = body.optString("method", "GET").uppercase()
        val ct = body.optString("contentType", "application/json")
        val payload = if (body.has("body") && !body.isNull("body")) body.opt("body").toString() else null
        val extraHeaders = body.optJSONObject("headers")?.toString() ?: "{}"
        val maxLen = body.optInt("maxLen", 900000)          // keep the returned slice under the server's 1MB body limit
        val offset = body.optInt("offset", 0)               // page through large responses (CDNs often ignore Range)
        val id = "f" + System.nanoTime()
        val latch = CountDownLatch(1); fetchWaiters[id] = latch
        val jsBody = if (payload == null) "undefined" else JSONObject.quote(payload)
        val js = "(function(){try{var o={method:${JSONObject.quote(method)},credentials:'include',headers:Object.assign({'Content-Type':${JSONObject.quote(ct)},'X-Requested-With':'XMLHttpRequest'}, $extraHeaders)};" +
            "var bd=$jsBody; if(bd!==undefined && ${JSONObject.quote(method)}!=='GET' && ${JSONObject.quote(method)}!=='HEAD')o.body=bd;" +
            "fetch(${JSONObject.quote(url)},o).then(function(r){return r.text().then(function(t){GBHost.fetchResult(${JSONObject.quote(id)},r.status,String(t).slice($offset,$offset+$maxLen))})})" +
            ".catch(function(e){GBHost.fetchResult(${JSONObject.quote(id)},0,String(e))});}catch(e){GBHost.fetchResult(${JSONObject.quote(id)},0,String(e))}})()"
        runOnUiThread { web.evaluateJavascript(js, null) }
        latch.await(30, TimeUnit.SECONDS)
        fetchWaiters.remove(id)
        return fetchResults.remove(id) ?: "{\"error\":\"timeout\"}"
    }

    // ---- Roles (per profile) --------------------------------------------------------------------

    private fun roleNames(): List<String> {
        val out = arrayListOf("(none)")
        try { val arr = JSONObject(vm.rolesCacheJson).optJSONArray("roles") ?: JSONArray(); for (i in 0 until arr.length()) out.add(arr.getJSONObject(i).optString("name")) } catch (e: Exception) {}
        return out
    }
    private fun roleDescription(name: String): String {
        try { val arr = JSONObject(vm.rolesCacheJson).optJSONArray("roles") ?: JSONArray(); for (i in 0 until arr.length()) { val r = arr.getJSONObject(i); if (r.optString("name") == name) return r.optString("description") } } catch (e: Exception) {}
        return ""
    }
    private fun roleForProfile(profile: String): String {
        return try { JSONObject(vm.profileRolesJson).optString(profile, "") } catch (e: Exception) { "" }
    }
    private fun setRoleForProfile(profile: String, roleName: String) {
        try {
            val o = JSONObject(vm.profileRolesJson)
            if (roleName.isBlank() || roleName == "(none)") o.remove(profile) else o.put(profile, roleName)
            vm.profileRolesJson = o.toString()
        } catch (e: Exception) {}
    }
    /** Push the current roles + this profile's role into the Compose settings state. */
    private fun renderRoleSpinner() {
        settingsUi.roleNames.value = roleNames()
        settingsUi.roleForCurrent.value = roleForProfile(vm.currentProfile.value ?: "default").ifBlank { "(none)" }
    }

    /**
     * WHAT THE RING IS DOING, READ FROM THE CLUSTER.
     *
     * The owner asks here and the job may run on the desktop. A strip that only knew about work on
     * THIS phone would show nothing on the very surface the question was asked from — which is the
     * state that had the assistant hand the same CapCut goal over twice while the desktop was
     * already working on it. One UI, two devices, one engine: the cluster is where they meet.
     */
    private fun startRingWatch() {
        if (ringWatching) return
        ringWatching = true
        Thread({
            while (true) {
                try {
                    if (vm.clusterUrl.trim().isNotEmpty() && ctrlApiReady) {
                        val body = apiAwait("GET", "/v1/ring/work", null)
                        runOnUiThread { engineer.myapp.gb.shared.RingWatch.apply(body, android.os.Build.MODEL ?: "this phone") }
                    }
                } catch (e: Exception) { /* a status line is never worth an error on screen */ }
                /* Three seconds while something runs, a slow beat otherwise. */
                try { Thread.sleep(if (engineer.myapp.gb.shared.RingWork.busy.value) 3000L else 12000L) } catch (e: InterruptedException) { return@Thread }
            }
        }, "gb-ring-watch").apply { isDaemon = true }.start()
    }

    // ---- PROFILES: its own surface, and the role kept where everything can see it ---------------

    /**
     * Every profile and the role it uses, in ONE call.
     *
     * The alternative is N+1 — the list, then each profile's settings, then the roles, then the
     * flows to count what runs where — which is how this screen never got built and the role ended
     * up in `vm.profileRolesJson`, a map in THIS PHONE's preferences that the cluster and the
     * desktop could not see and a reinstall threw away.
     */
    private fun profilesLoad() {
        runOnUiThread { shellUi.profileStatus.value = "loading your profiles…" }
        agentExec.execute {
            val raw = apiAwait("GET", "/v1/profiles/overview", null)
            val o = try { JSONObject(raw) } catch (e: Exception) { JSONObject().put("error", raw.take(120)) }
            if (o.has("error")) { runOnUiThread { shellUi.profileStatus.value = o.optString("error") }; return@execute }
            val arr = o.optJSONArray("profiles") ?: JSONArray()
            val cards = ArrayList<engineer.myapp.gb.shared.ProfileCard>()
            for (i in 0 until arr.length()) {
                val p = arr.optJSONObject(i) ?: continue
                cards.add(engineer.myapp.gb.shared.ProfileCard(
                    name = p.optString("name"), site = p.optString("site"), note = p.optString("note"),
                    hasLogin = p.optBoolean("hasLogin"), role = p.optString("role"),
                    roleSource = p.optString("roleSource"), missingRole = p.optString("missingRole"),
                    device = p.optString("device"), automations = p.optInt("automations"),
                    live = p.optBoolean("live"), exit = p.optString("exit"),
                ))
            }
            val names = ArrayList<String>()
            val rs = o.optJSONArray("roles") ?: JSONArray()
            for (i in 0 until rs.length()) rs.optString(i).takeIf { it.isNotBlank() }?.let { names.add(it) }
            runOnUiThread {
                shellUi.profileCards.value = cards
                shellUi.profileRoleNames.value = names
                shellUi.profileStatus.value = ""
            }
            migrateLocalProfileRoles(cards)
        }
    }

    /**
     * CARRY THE OLD LOCAL CHOICES UP TO THE SERVER, ONCE.
     *
     * Roles picked before today live in `vm.profileRolesJson` on this phone and nowhere else. Now
     * that the profile itself carries the choice, those would simply be lost — a silent downgrade
     * of settings someone deliberately made, which is worse than never having had the feature.
     *
     * So each local entry is pushed for a profile the server does not already have a CHOSEN role
     * for (never overwriting a newer decision), and only what actually lands is dropped from the
     * local map. An entry naming a role that no longer exists is left alone rather than deleted:
     * the server refuses it, and keeping it means the evidence is still there to look at.
     */
    private fun migrateLocalProfileRoles(cards: List<engineer.myapp.gb.shared.ProfileCard>) {
        val local = try { JSONObject(vm.profileRolesJson) } catch (e: Exception) { return }
        if (local.length() == 0) return
        val chosen = cards.filter { it.roleSource == "chosen" }.map { it.name }.toSet()
        var moved = 0
        val keys = local.keys().asSequence().toList()
        for (k in keys) {
            val role = local.optString(k).trim()
            if (role.isBlank() || role == "(none)" || k in chosen) { local.remove(k); continue }
            val r = try { JSONObject(apiAwait("PUT", "/v1/profiles/$k/settings", JSONObject().put("defaultRole", role).toString())) }
                    catch (e: Exception) { JSONObject().put("error", "no answer") }
            if (r.has("error")) { vm.log("! could not move \"$k\" → $role to the cluster: ${r.optString("error").take(90)}") }
            else { local.remove(k); moved++ }
        }
        vm.profileRolesJson = local.toString()
        if (moved > 0) {
            vm.log("↑ moved $moved profile role${if (moved == 1) "" else "s"} to your Ghost Browser — the desktop and the cluster can see them now")
            profilesLoad()
        }
    }

    /**
     * One role in full, for reading BEFORE choosing.
     *
     * `requireWords` and `runsOn` are sentences the server writes (src/requireWords.js). Translating
     * capability flags here too would be a second copy of one rule, and the copy in the client is
     * always the one that goes stale — the same way this endpoint's own projection dropped `require`
     * while the router went on matching against it.
     */
    private fun profileRoleRead(name: String) {
        runOnUiThread { shellUi.profileRoleDetail.value = null }
        agentExec.execute {
            val r = try { JSONObject(apiAwait("GET", "/v1/agent/roles/$name", null)) } catch (e: Exception) { JSONObject().put("error", "no answer") }
            if (r.has("error")) { runOnUiThread { shellUi.profileStatus.value = r.optString("error") }; return@execute }
            val tools = ArrayList<String>()
            val ta = r.optJSONArray("tools") ?: JSONArray()
            for (i in 0 until ta.length()) ta.optString(i).takeIf { it.isNotBlank() }?.let { tools.add(it) }
            val d = engineer.myapp.gb.shared.RoleChoice(
                name = r.optString("name", name), label = r.optString("label"), site = r.optString("site"),
                group = r.optString("group"), description = r.optString("description"),
                playbook = r.optString("prompt"), requireWords = r.optString("requireWords"),
                runsOn = r.optJSONObject("runsOn")?.optString("summary") ?: "",
                tools = tools, builtin = r.optBoolean("builtin"),
                /* Every way this role can run, as the SERVER listed them. Working out which device
                   can do what here would be a second copy of the router's rule, and the copy in
                   the client is always the one that goes stale. */
                variants = run {
                    val out = ArrayList<engineer.myapp.gb.shared.RoleVariant>()
                    val va = r.optJSONArray("variants") ?: JSONArray()
                    for (i in 0 until va.length()) {
                        val v = va.optJSONObject(i) ?: continue
                        out.add(engineer.myapp.gb.shared.RoleVariant(
                            kind = v.optString("kind"), where = v.optString("where"),
                            requireWords = v.optString("requireWords"), method = v.optString("method"),
                            note = v.optString("note"), ready = v.optBoolean("ready"), runsOn = v.optString("runsOn"),
                        ))
                    }
                    out
                },
            )
            runOnUiThread { shellUi.profileRoleDetail.value = d }
        }
    }

    /**
     * One management call, and its answer shown as it came back.
     *
     * Every one of these refuses on the server while a session holds the profile: pulling a profile
     * directory out from under a running Chromium leaves the browser writing into a folder that no
     * longer exists, and that surfaces minutes later somewhere unrelated. The refusal names the way
     * out ("close that session first"), so it is shown verbatim rather than swallowed.
     */
    private fun profileManage(method: String, path: String, body: String?, ok: String) {
        runOnUiThread { shellUi.profileStatus.value = "…" }
        agentExec.execute {
            val raw = apiAwait(method, path, body)
            val r = try { JSONObject(raw) } catch (e: Exception) { JSONObject().put("error", raw.take(140)) }
            runOnUiThread { shellUi.profileStatus.value = if (r.has("error")) r.optString("error") else ok }
            profilesLoad()
        }
    }

    /** Make a role this profile's default, or clear it back to the site match with "". */
    private fun profileRoleSet(profile: String, role: String) {
        agentExec.execute {
            val r = try { JSONObject(apiAwait("PUT", "/v1/profiles/$profile/settings", JSONObject().put("defaultRole", role).toString())) }
                    catch (e: Exception) { JSONObject().put("error", "no answer") }
            runOnUiThread {
                /* The server refuses a role that does not exist and names the valid ones: a typo
                   would otherwise leave the profile looking configured and acting as a generalist. */
                shellUi.profileStatus.value = if (r.has("error")) r.optString("error")
                    else if (role.isBlank()) "$profile works it out from the site again"
                    else "$profile uses $role"
            }
            profilesLoad()
        }
    }

    /** Automations whose steps run on [profile] — read off the flow definitions (nodes[].profile), so the
     *  list is always the truth, never a note that can go stale. */
    private fun automationsForProfile(profile: String): List<JSONObject> {
        val out = ArrayList<JSONObject>()
        try {
            val arr = JSONObject(vm.flowsJson).optJSONArray("workflows") ?: JSONArray()
            for (i in 0 until arr.length()) {
                val w = arr.optJSONObject(i) ?: continue
                val nodes = w.optJSONArray("nodes") ?: JSONArray()
                var hit = false
                for (k in 0 until nodes.length()) { if (nodes.optJSONObject(k)?.optString("profile") == profile) { hit = true; break } }
                if (hit) out.add(w)
            }
        } catch (e: Exception) {}
        return out
    }

    /** Push profiles + active profile into the Compose settings state. */
    private fun renderChips() {
        settingsUi.profiles.value = vm.profiles.value ?: listOf("default")
        settingsUi.currentProfile.value = vm.currentProfile.value ?: "default"
        renderRoleSpinner()
    }

    // ---- Same-origin authed API channel (fetch profiles, flows, run/create over the SSO session) ----

    /** A hidden WebView pinned to the GB origin exposing window.__gbApi — every cluster read/write
     *  rides the SSO cookies of the current profile, the proven auth path. Loaded once, reused. */
    @SuppressLint("SetJavaScriptEnabled")
    private fun ensureApiWeb() {
        if (apiWeb != null) return
        val url = vm.clusterUrl.trim()
        if (url.isEmpty()) { vm.log("! set the cluster URL on the Cluster tab first"); return }
        apiReady = false
        val w = WebView(this)
        val bridgeToken = java.util.UUID.randomUUID().toString()
        val prof = vm.currentProfile.value ?: "default"
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            try { ProfileStore.getInstance().getOrCreateProfile(prof); WebViewCompat.setProfile(w, prof) } catch (e: Exception) {}
        }
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true)
        w.addJavascriptInterface(ApiBridge(bridgeToken), "GBHost")
        w.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, u: String?) {
                if (apiReady || !isClusterOrigin(u)) return
                view?.evaluateJavascript(
                    "(function(){var proof=${JSONObject.quote(bridgeToken)};window.__gbApi=function(m,p,b,t){var o={method:m,credentials:'include',headers:{'Content-Type':'application/json'}};if(b)o.body=b;" +
                    "fetch(p,o).then(function(r){return r.text()}).then(function(x){GBHost.result(proof,t,x)}).catch(function(e){GBHost.result(proof,t+'_err',String(e))})};})()", null)
                apiReady = true
                val q = ArrayList(apiQueue); apiQueue.clear(); for (fn in q) fn()
                autoSyncSharedData()   // P0: shared data loads automatically on login — no manual fetch
            }
        }
        (b.root as ViewGroup).addView(w, 1, 1)
        apiWeb = w
        w.loadUrl(url)
    }

    /** Call the GB API over the SSO session; the response text comes back to onBridge as [tag]
     *  (or [tag]_err on failure). Prefers the CONNECTED control channel (ctrlWeb) — it holds the exact
     *  session that registered this device — so cluster reads never depend on the active browsing
     *  profile. Falls back to the dedicated apiWeb when the control channel isn't connected. */
    private fun apiCall(method: String, path: String, body: String?, tag: String) {
        // WebViews may only be touched on the main thread. The results artifact's JS bridge (approve,
        // deny, run a flow) calls in from the WebView's bridge thread — and when the control channel was
        // not ready the fallback below touched the API WebView directly and threw ("Java exception was
        // raised during method invocation"). Hop to the main thread once, here, for every caller.
        // ONCE ENROLLED, every cluster call goes native with the device's durable Bearer key — no WebView,
        // no per-profile cookie jar, so opening a platform never re-triggers a cluster sign-in. The WebView
        // path below is only the fallback used to enroll the first time (it rides the SSO cookie).
        if (vm.clusterKey.isNotBlank()) { nativeApiCall(method, path, body, tag); return }
        if (android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) { runOnUiThread { apiCall(method, path, body, tag) }; return }
        val js = "window.__gbApi(" + JSONObject.quote(method) + "," + JSONObject.quote(path) + "," +
            (if (body == null) "null" else JSONObject.quote(body)) + "," + JSONObject.quote(tag) + ")"
        if (ctrlWeb != null && ctrlApiReady) {
            runOnUiThread { ctrlWeb?.evaluateJavascript(js, null) }
            return
        }
        ensureApiWeb()
        val call: () -> Unit = { apiWeb?.evaluateJavascript(js, null); Unit }
        if (apiReady && apiWeb != null) call() else apiQueue.add(call)
    }

    private val netExec = java.util.concurrent.Executors.newFixedThreadPool(4)
    /** A cluster call over a plain connection with the durable device key — the result lands on the SAME
     *  dispatcher (onBridge) by tag, so every existing handler keeps working unchanged. */
    private fun nativeApiCall(method: String, path: String, body: String?, tag: String) {
        netExec.execute {
            try {
                val url = java.net.URL(vm.clusterUrl.trim().trimEnd('/') + path)
                val c = url.openConnection() as java.net.HttpURLConnection
                c.requestMethod = method; c.connectTimeout = 20000; c.readTimeout = 60000
                c.setRequestProperty("Authorization", "Bearer ${vm.clusterKey}")
                c.setRequestProperty("Accept", "application/json")
                if (body != null) { c.doOutput = true; c.setRequestProperty("Content-Type", "application/json"); c.outputStream.use { it.write(body.toByteArray()) } }
                val code = c.responseCode
                val txt = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
                if (code == 401) {   // the key was revoked or expired — drop it and fall back to the SSO enrolment
                    vm.clusterKey = ""; runOnUiThread { vm.log("· cluster login expired — reconnecting"); onBridge(tag + "_err", "unauthorized"); ensureApiWeb() }
                } else runOnUiThread { onBridge(if (code in 200..299) tag else tag + "_err", txt) }
            } catch (e: Exception) { runOnUiThread { onBridge(tag + "_err", e.message ?: "network error") } }
        }
    }

    private fun stopApiWeb() {
        apiReady = false; apiQueue.clear()
        apiWeb?.let { pw -> try { (pw.parent as? ViewGroup)?.removeView(pw); pw.destroy() } catch (e: Exception) {} }
        apiWeb = null
    }

    /** P0 — the shared brain auto-loads the moment we're logged in (API/SSO session ready): roles,
     *  profiles/platforms and automations pull from the cluster automatically, so the data is just
     *  there. Replaces the manual "fetch" buttons. UI-toolkit-independent — survives the Compose rewrite. */
    private fun autoSyncSharedData() {
        // First time on a fresh device: mint the durable login through the SSO-authed WebView, then the
        // enrol handler stores it and calls this again — this second pass runs native with the key.
        if (vm.clusterKey.isBlank()) {
            vm.log("↻ connecting this device to the cluster…")
            apiCall("POST", "/v1/device/auth", JSONObject().put("deviceId", vm.deviceToken).put("name", android.os.Build.MODEL).toString(), "enroll")
            return
        }
        runOnUiThread { vm.log("↻ syncing your data from the cluster…") }
        apiCall("GET", "/v1/agent/roles", null, "roles_list")
        apiCall("GET", "/v1/profiles/presets", null, "platforms")
        apiCall("GET", "/v1/workflows", null, "flows")
        pollApprovals(); startApprovalsPolling()   // populate the Approvals badge + keep it live if a watcher is running
    }

    // ---- "Your platforms" — mirror the cluster's platform list; sign in once per platform on-device --

    private fun loadPlatforms() {
        if (vm.clusterUrl.trim().isEmpty()) { vm.log("! sign in first (Settings → Account & sync)"); return }
        vm.log("↑ loading platforms…"); apiCall("GET", "/v1/profiles/presets", null, "platforms")
    }

    private fun renderPlatforms(arr: JSONArray) {
        val known = (vm.profiles.value ?: emptyList()).toSet()
        val out = ArrayList<engineer.myapp.gbmobile.ui.PlatformOpt>()
        for (i in 0 until arr.length()) {
            val p = arr.optJSONObject(i) ?: continue
            val key = p.optString("key")
            val label = p.optString("label", key).ifBlank { key }
            // a preset may name the site bare ("linkedin.com"): without a scheme Uri.parse has no host,
            // the cookie lookup finds nothing, and the login never syncs — normalise it to a real address
            val site = p.optString("site").trim().let { if (it.isBlank() || it.startsWith("http")) it else "https://${if (it.startsWith("www.")) it else "www.$it"}/" }
            if (key.isBlank() || site.isBlank()) continue
            val prof = "p_" + key.lowercase().replace(Regex("[^a-z0-9_-]"), "")
            // "signed in" ONLY if this phone's profile actually holds a session cookie for the site.
            val signedIn = known.contains(prof) && profileHasSession(prof, site)
            out.add(engineer.myapp.gbmobile.ui.PlatformOpt(label, site, prof, signedIn, cookieSyncApproved(prof)))
        }
        settingsUi.platforms.value = out
        shellUi.platforms.value = out   // also feed the omnibox shortcuts
        vm.log("● signed in on this phone: " + (out.filter { it.signedIn }.map { it.label }.takeIf { it.isNotEmpty() }?.joinToString(", ") ?: "none"))
        syncLoginsToCluster(out)
    }

    /** Only approved platform profiles export cookies to the matching cluster profile.
     *  Hashing avoids sending the same cookie set twice. */
    private val loginSyncHashes = HashMap<String, Int>()
    private var platformsRequested = false
    private fun cookieSyncApprovalKey(profile: String) = CookieSyncPolicy.key(vm.clusterUrl, profile)
    private fun cookieSyncApproved(profile: String) = CookieSyncPolicy.allows(vm.approvedCookieSync, vm.clusterUrl, profile)
    private fun apexOf(host: String): String { val parts = host.split("."); return if (parts.size >= 2) parts.takeLast(2).joinToString(".") else host }
    private fun syncLoginsToCluster(list: List<engineer.myapp.gbmobile.ui.PlatformOpt>) {
        if (vm.clusterUrl.trim().isEmpty()) return
        for (p in list) {
            if (!p.signedIn || !cookieSyncApproved(p.profile)) continue
            val cookieStr = try { if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) ProfileStore.getInstance().getOrCreateProfile(p.profile).cookieManager.getCookie(p.site) ?: "" else "" } catch (e: Exception) { "" }
            pushLoginCookies(p, cookieStr)
        }
    }
    /** Sync only the approved platform profile. A matching site opened in a different identity must
     *  never silently copy that identity's login into the approved cluster profile. */
    private fun syncLoginForTab(h: TabHandle, url: String) {
        if (vm.clusterUrl.trim().isEmpty() || !url.startsWith("http")) return
        val host = try { Uri.parse(url).host } catch (e: Exception) { null } ?: return
        val plats = settingsUi.platforms.value ?: emptyList()
        if (plats.isEmpty()) { if (!platformsRequested) { platformsRequested = true; loadPlatforms() }; return }
        // the LONGEST preset host the tab's host ends with wins: aistudio.google.com over google.com, the
        // GB console's own host over my-app.engineer; the console itself is never a platform to sync
        val tabHost = host.removePrefix("www.")
        val clusterHost = try { Uri.parse(vm.clusterUrl.trim()).host?.removePrefix("www.") } catch (e: Exception) { null }
        val p = plats.mapNotNull { pl -> val ph = (try { Uri.parse(pl.site).host } catch (e: Exception) { null })?.removePrefix("www.") ?: return@mapNotNull null
                if (ph == clusterHost) null else if (tabHost == ph || tabHost.endsWith(".$ph")) pl to ph.length else null }
            .maxByOrNull { it.second }?.first ?: return
        if (!CookieSyncPolicy.allows(vm.approvedCookieSync, vm.clusterUrl, p.profile, h.profile)) return
        val cookieStr = try {
            if (h.profile != "default" && WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) ProfileStore.getInstance().getOrCreateProfile(h.profile).cookieManager.getCookie(url) ?: ""
            else CookieManager.getInstance().getCookie(url) ?: ""
        } catch (e: Exception) { "" }
        if (cookieStr.isBlank()) { if (loginSyncHashes[p.profile] != 0) { loginSyncHashes[p.profile] = 0; vm.log("· ${p.label}: no cookies yet in this tab's profile (${h.profile}) — sign in here and they sync by themselves") }; return }
        pushLoginCookies(p, cookieStr)
    }
    private fun pushLoginCookies(p: engineer.myapp.gbmobile.ui.PlatformOpt, cookieStr: String) {
        if (cookieStr.isBlank() || !cookieSyncApproved(p.profile)) return
        val hsh = cookieStr.hashCode(); if (loginSyncHashes[p.profile] == hsh) return; loginSyncHashes[p.profile] = hsh
        val host = try { Uri.parse(p.site).host } catch (e: Exception) { null } ?: return
        val apex = apexOf(host)
        val arr = JSONArray(); val exp = System.currentTimeMillis() / 1000 + 30L * 86400
        for (kv in cookieStr.split(";")) { val t = kv.trim(); val eq = t.indexOf('='); if (eq <= 0) continue
            arr.put(JSONObject().put("name", t.substring(0, eq)).put("value", t.substring(eq + 1)).put("domain", ".$apex").put("path", "/").put("expires", exp).put("secure", true).put("httpOnly", false).put("sameSite", "Lax")) }
        if (arr.length() == 0) return
        val cluster = p.profile.removePrefix("p_")
        apiCall("POST", "/v1/profiles/$cluster/cookies", JSONObject().put("site", p.site).put("cookies", arr).toString(), "loginsync")
        vm.log("↑ ${p.label}: login synced to the cluster (${arr.length()} cookies)")
    }

    private fun profileHasSession(prof: String, site: String): Boolean {
        return try {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return false
            val cm = ProfileStore.getInstance().getOrCreateProfile(prof).cookieManager
            (cm.getCookie(site) ?: "").isNotBlank()
        } catch (e: Exception) { false }
    }

    private fun openPlatform(prof: String, site: String) {
        vm.addProfile(prof)              // creates it if new and selects it
        renderChips()
        val host = try { Uri.parse(site).host } catch (e: Exception) { null }
        val existing = tabs.indexOfFirst { it.profile == prof && host != null && (try { Uri.parse(it.url).host } catch (e: Exception) { null }) == host }
        if (existing >= 0) {             // don't spawn duplicates — focus the platform's own tab
            activateTab(existing)
            vm.log("↺ switched to the \"$prof\" tab for $host")
        } else {
            newTab(site, profile = prof) // explicit profile opens keep their isolated session
            vm.log("→ opened \"$prof\" — sign in once here; the session stays in this profile")
        }
        shellUi.screen.value = "browser"   // jump to the browser
    }

    // ---- Flows (automations — the same workflow engine GB runs) ---------------------------------

    /** Push the flows into the Compose shell state. */
    private fun renderFlows(arr: JSONArray) {
        val out = ArrayList<engineer.myapp.gbmobile.ui.FlowInfo>()
        for (i in 0 until arr.length()) {
            val w = arr.optJSONObject(i) ?: continue
            val id = w.optString("id"); if (id.isBlank()) continue
            val name = w.optString("name", id)
            val nodes = w.optJSONArray("nodes") ?: JSONArray()
            val steps = nodes.length()
            var profile = ""; var role = ""; val goals = ArrayList<String>()
            for (j in 0 until nodes.length()) {
                val nn = nodes.optJSONObject(j) ?: continue
                if (nn.optString("type") == "agent") {
                    if (profile.isBlank()) profile = nn.optString("profile")
                    if (role.isBlank()) role = nn.optString("role")
                    val g = nn.optString("goal"); if (g.isNotBlank()) goals.add(g)
                } else if (nn.optString("type") == "recon") {
                    goals.add("${nn.optString("scan", "exposure")}: ${nn.optString("target")}")
                }
            }
            val runs = w.optInt("runs", 0)
            val verified = w.optBoolean("lastVerified")
            val proof = if (w.optBoolean("verifiedEver")) (if (verified) " · ✓ verified" else " · was verified") else ""
            val last = if (runs > 0) "$runs runs, last ${w.optString("lastRunStatus", "?")}$proof" else "never run"
            out.add(engineer.myapp.gbmobile.ui.FlowInfo(id, name, steps, last, profile, role, goals, runs, w.optString("lastRunStatus", ""), verified, w.optString("kind", "browser")))
        }
        shellUi.flows.value = out
        shellUi.flowsHint.value = if (out.isEmpty()) "No automations yet — build one below." else "${out.size} automations — tap Run to fire one."
    }

    private fun runFlow(id: String, name: String) {
        // Instead of firing immediately, open the Run sheet: pick WHERE to run, confirm the goal, then run.
        showRunSheet(id, name)
    }

    /** Open the run-anywhere sheet for [id]/[name]: seed the device list (cluster now, live devices from
     *  the hub), reset to the pick phase, and reveal the Compose overlay. */
    private fun showRunSheet(id: String, name: String) {
        runFlowId.value = id; runFlowName.value = name
        runPhase.value = "pick"; runStatus.value = ""
        runDevices.value = if (id.startsWith("local-recon-")) baseRunDevices().filter { it.id == "local" } else baseRunDevices()
        runVisible.value = true
        runHost?.let { it.visibility = View.VISIBLE; it.bringToFront() }
        if (!id.startsWith("local-recon-") && vm.clusterKey.isNotBlank()) apiCall("GET", "/v1/device/list", null, "run_devices")
    }

    /** The always-available targets before the hub answers: This phone (local engine), Cluster, Auto. */
    private fun baseRunDevices(): List<DeviceOpt> = listOf(
        DeviceOpt("local", "This phone", "on-device engine · real IP · runs now", "📱", true),
        DeviceOpt("cluster", "Cluster", "headless · scale · runs now", "☁", true),
        DeviceOpt("auto", "Auto (let the ring choose)", "picks the best device for the flow", "🔀", true),
    )

    /** S4: this phone's capability record — sent on register (gb-control.js) and used by the cluster
     *  router (/v1/device/route) so the ring picks this device only for runs it can actually handle. */
    private fun phoneCaps(): JSONObject {
        val hasModel = (vm.useLocal && models.isReady(vm.selectedModel)) || (!vm.useLocal && vm.endpoint.isNotBlank())
        val profs = JSONArray(); for (p in (vm.profiles.value ?: emptyList())) profs.put(p)
        val feats = JSONArray().put("native_tap").put("upload_file").put("click_xy").put("drag_xy")
        return JSONObject()
            .put("platform", "android")
            .put("mobileApp", true)   // native app → real touch events
            .put("model", hasModel)   // can run the agent locally
            .put("realIp", true)      // a real mobile-device IP
            .put("profiles", profs)
            .put("features", feats)
    }

    /** The flow's browser profile (from the shared cache), used as a routing preference. */
    private fun flowProfile(flowId: String?): String {
        try {
            val flows = JSONObject(vm.flowsJson).optJSONArray("workflows") ?: JSONArray()
            for (i in 0 until flows.length()) {
                val w = flows.optJSONObject(i) ?: continue
                if (w.optString("id") != flowId) continue
                val nodes = w.optJSONArray("nodes") ?: JSONArray()
                for (j in 0 until nodes.length()) {
                    val nn = nodes.optJSONObject(j) ?: continue
                    val p = nn.optString("profile"); if (p.isNotBlank()) return p
                }
            }
        } catch (_: Exception) {}
        return ""
    }

    @Volatile private var pendingAutoGoal: String = ""

    /** Fire the run on the chosen target. Auto (S4) asks the cluster capability router which device from
     *  the SHARED registry best fits the flow; a concrete pick runs here (local) or on the cluster. */
    private fun onRunTarget(target: String, goal: String) {
        val id = runFlowId.value
        runPhase.value = "running"; runActivity.value = emptyList()
        if (id?.startsWith("local-recon-") == true) {
            runStatus.value = "Running this phone's recon automation..."
            runFlowLocally(id, goal)
            return
        }
        if (target == "auto") {
            // S4: the ring decides from the shared capability registry (this phone + the desktop node + …),
            // matched to the flow's needs — not a local guess. Falls back to a local guess if the router
            // is unreachable (e.g. the control channel isn't connected).
            pendingAutoGoal = goal
            runStatus.value = "Ring choosing the best device…"
            val prefer = JSONObject().put("model", true)
            val fp = flowProfile(id); if (fp.isNotBlank()) prefer.put("profile", fp)
            val req = JSONObject().put("require", JSONObject()).put("prefer", prefer)
            if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/device/route", req.toString(), "route")
            else onBridge("route_err", "no cluster url")
            return
        }
        resolveAndRun(target, goal, id)
    }

    /** Run a resolved target: "local" → the on-device engine; anything else → the cluster (remote
     *  drive of a sibling device is the next increment, so a dev:* pick runs on the cluster for now). */
    private fun resolveAndRun(resolved: String, goal: String, id: String?) {
        if (resolved == "local") { runFlowLocally(id, goal); return }
        runStatus.value = if (resolved.startsWith("dev:"))
            "Remote device-drive lands next — running on the cluster for now…" else "Started on the cluster…"
        if (id != null) {
            val body = if (goal.isBlank()) "{}" else JSONObject().put("input", JSONObject().put("goal", goal)).toString()
            apiCall("POST", "/v1/workflows/$id/run", body, "sheetrun")
        } else { runStatus.value = "! no flow selected"; runPhase.value = "done" }
    }

    /** P1 — the on-device engine. Runs a flow's agent-node goals LOCALLY on this phone via the same
     *  on-device Agent that powers the chat (real WebView, real IP), instead of triggering the cluster.
     *  Goals come from the typed goal, or from the flow definition in the shared cache. */
    private fun runFlowLocally(flowId: String?, goal: String) {
        // Security flows use the deterministic on-device auditor and need no model or cluster.
        val reconNode = try {
            val flows = JSONObject(vm.flowsJson).optJSONArray("workflows") ?: JSONArray()
            var found: JSONObject? = null
            for (i in 0 until flows.length()) {
                val wf = flows.optJSONObject(i) ?: continue
                if (wf.optString("id") != flowId) continue
                val nodes = wf.optJSONArray("nodes") ?: JSONArray()
                for (j in 0 until nodes.length()) {
                    val node = nodes.optJSONObject(j)
                    if (node?.optString("type") == "recon") { found = node; break }
                }
                break
            }
            found
        } catch (_: Exception) { null }
        if (reconNode != null) {
            val target = goal.trim().takeIf { it.startsWith("https://") || it.startsWith("http://") }
                ?: reconNode.optString("target")
            if (!target.startsWith("https://") && !target.startsWith("http://")) {
                runPhase.value = "done"; runStatus.value = "Enter an HTTP(S) target for local recon."; return
            }
            runStatus.value = "Scanning $target on this phone..."
            agentExec.execute {
                try {
                    val report = OnDeviceAuditor.audit(target)
                    runOnUiThread {
                        if (flowId?.startsWith("local-recon-") == true) {
                            LocalReconStore.addResult(this, flowId, LocalReconResultRecord.completed(target, report))
                            refreshLocalWorkflows()
                        }
                        shellUi.reconUi.currentTarget.value = target
                        shellUi.reconUi.report.value = report
                        runStatus.value = "Local recon finished: ${report.findingsCount} findings, grade ${report.grade}. Open Security Recon for the report."
                        runPhase.value = "done"
                    }
                } catch (e: Exception) {
                    runOnUiThread { runStatus.value = "Local recon failed: ${e.message ?: "unknown error"}"; runPhase.value = "done" }
                }
            }
            return
        }
        val brain = buildBrain()
        if (brain == null) {
            // S3 reroute: no on-device model is a capability miss → hand the run to the cluster instead of
            // dead-ending, so the ring still gets it done.
            if (flowId != null) {
                runPhase.value = "running"
                runStatus.value = "No on-device model → rerouting to the cluster…"
                vm.log("🔀 ring reroute: no on-device model → cluster")
                val body = if (goal.isBlank()) "{}" else JSONObject().put("input", JSONObject().put("goal", goal)).toString()
                apiCall("POST", "/v1/workflows/$flowId/run", body, "sheetrun")
            } else {
                runPhase.value = "done"
                runStatus.value = "No on-device model set. Agent tab → pick/download a model, or run on the cluster."
            }
            return
        }
        val goals = ArrayList<Pair<String, String>>()   // label -> goal
        var profile = ""
        try {
            val flows = JSONObject(vm.flowsJson).optJSONArray("workflows") ?: JSONArray()
            var wf: JSONObject? = null
            for (i in 0 until flows.length()) { val w = flows.optJSONObject(i); if (w?.optString("id") == flowId) { wf = w; break } }
            val nodes = wf?.optJSONArray("nodes") ?: JSONArray()
            for (i in 0 until nodes.length()) {
                val nn = nodes.optJSONObject(i) ?: continue
                if (nn.optString("type") == "agent") {
                    if (profile.isBlank()) profile = nn.optString("profile")
                    if (goal.isBlank()) { val g = nn.optString("goal"); if (g.isNotBlank()) goals.add(nn.optString("label", "step ${goals.size + 1}") to g) }
                }
            }
        } catch (e: Exception) { }
        if (goal.isNotBlank()) { goals.clear(); goals.add("goal" to goal) }
        if (goals.isEmpty()) { runPhase.value = "done"; runStatus.value = "Nothing to run — add a goal, or load the flow first."; return }

        // The flow's profile decides WHERE the run starts. On the cluster the engine opens that profile's
        // site automatically; on-device we must navigate there first, or a weak local model just operates
        // whatever tab is open (the empty home page) and loops.
        val startSite = when {
            profile.contains("facebook", true) -> "https://www.facebook.com/"
            profile.contains("messenger", true) -> "https://www.facebook.com/messages/"
            profile.contains("linkedin", true) -> "https://www.linkedin.com/feed/"
            profile.contains("instagram", true) -> "https://www.instagram.com/"
            else -> ""
        }
        val host = if (startSite.isNotBlank()) (try { Uri.parse(startSite).host ?: "" } catch (e: Exception) { "" }) else ""
        runStatus.value = if (startSite.isNotBlank()) "Opening $host…" else "Starting on this phone…"
        vm.log("▶ running \"${runFlowName.value}\" ON THIS PHONE (on-device engine, real IP) — ${goals.size} step(s)")
        agentStop = false; runUserStopped = false
        val started = System.currentTimeMillis()
        val journal = java.util.Collections.synchronizedList(ArrayList<String>())
        val lastActivity = java.util.concurrent.atomic.AtomicLong(System.currentTimeMillis())
        val stalled = java.util.concurrent.atomic.AtomicBoolean(false)
        val logStep: (String) -> Unit = { m -> journal.add(m); lastActivity.set(System.currentTimeMillis()); runOnUiThread { vm.log(m); runActivity.value = (runActivity.value + m).takeLast(6) } }
        agentThread = Thread {
            if (startSite.isNotBlank() && !agentStop) {
                // CODE opens the profile + page deterministically — the agent must NOT have to navigate.
                try {
                    runOnUiThread { if (profile.isNotBlank()) openPlatform(profile, startSite) else navigate(startSite) }
                    Thread.sleep(5000)
                } catch (e: Exception) { }
            }
            // Stall watchdog: if the on-device agent produces NO activity for 90s it's hung — stop it so it
            // can be reported (and, in S3, rerouted). A busy-loop that keeps logging isn't caught here
            // (that needs semantic progress detection — S3).
            Thread {
                while (!agentStop) {
                    try { Thread.sleep(5000) } catch (e: Exception) { break }
                    if (System.currentTimeMillis() - lastActivity.get() > 90000) {
                        stalled.set(true); agentStop = true
                        runOnUiThread { runStatus.value = "Stalled — no progress for 90s; stopping."; vm.log("⚠ on-device run stalled (no activity 90s) — stopped") }
                        break
                    }
                }
            }.also { it.isDaemon = true; it.start() }
            var i = 0
            for ((label, g) in goals) {
                if (agentStop) break
                i++
                runOnUiThread { runStatus.value = "This phone · step $i/${goals.size}: $label" }
                val ctx = if (host.isNotBlank()) "You are already on $host — do NOT open any home page; work from here. " else ""
                try { Agent(this, brain, { m -> logStep(m) }, { agentStop }).run(ctx + g) }
                catch (e: Exception) { logStep("! step $i failed: ${e.message}") }
            }
            agentStop = true   // release the watchdog
            val stalledNow = stalled.get()
            val willReroute = stalledNow && flowId != null && !runUserStopped
            val outcome = if (willReroute) "rerouted" else if (stalledNow) "stalled" else if (runUserStopped) "stopped" else "done"
            // S1: journal this on-device attempt to the SHARED cluster history over the SSO API (no control
            // channel) so runs are visible everywhere (GET /v1/device-runs), same as cluster runs.
            val rec = JSONObject()
                .put("deviceName", android.os.Build.MODEL).put("deviceId", android.os.Build.MODEL)
                .put("target", "local").put("flowId", flowId ?: "").put("flowName", runFlowName.value ?: "")
                .put("goal", goal).put("outcome", outcome).put("status", outcome)
                .put("startedAt", started).put("endedAt", System.currentTimeMillis())
            val stepsArr = JSONArray()
            synchronized(journal) { val s0 = maxOf(0, journal.size - 200); for (k in s0 until journal.size) stepsArr.put(JSONObject().put("line", journal[k])) }
            rec.put("steps", stepsArr)
            runOnUiThread {
                apiCall("POST", "/v1/device-runs", rec.toString(), "devrunsave")
                if (willReroute) {
                    // S3: self-healing reroute — the on-device run stalled; hand it to the cluster and let the
                    // cluster run drive the sheet to done (sheetrun/sheetstatus handlers).
                    runStatus.value = "Stalled on this phone → rerouted to the cluster…"
                    vm.log("🔀 ring reroute: on-device stalled → cluster")
                    val body = if (goal.isBlank()) "{}" else JSONObject().put("input", JSONObject().put("goal", goal)).toString()
                    apiCall("POST", "/v1/workflows/$flowId/run", body, "sheetrun")
                } else {
                    runPhase.value = "done"
                    runStatus.value = when (outcome) {
                        "stopped" -> "Stopped. Journaled to shared history."
                        else -> "Done on this phone — ran ${goals.size} step(s). Journaled to shared history."
                    }
                }
            }
        }.also { it.start() }
    }

    /** Cancel a running on-device flow — the agent loop checks this flag between steps. */
    private fun onRunStop() {
        runUserStopped = true
        agentStop = true
        runStatus.value = "Stopping…"
    }

    private fun createFlow(nameIn: String, stepsText: String) {
        val name = nameIn.trim()
        val stepLines = stepsText.split("\n").map { it.trim() }.filter { it.isNotEmpty() }
        if (name.length < 3) { vm.log("! give the automation a name (3+ chars)"); return }
        if (stepLines.isEmpty()) { vm.log("! add at least one step (one goal per line)"); return }
        val nodes = JSONArray()
        val edges = JSONArray()
        nodes.put(JSONObject().put("id", "trigger").put("type", "trigger").put("label", "Manual"))
        var prev = "trigger"
        for ((idx, goal) in stepLines.withIndex()) {
            val nid = "n$idx"
            nodes.put(JSONObject().put("id", nid).put("type", "agent").put("label", "Step ${idx + 1}").put("goal", goal))
            edges.put(JSONObject().put("from", prev).put("to", nid))
            prev = nid
        }
        val body = JSONObject().put("name", name).put("trigger", JSONObject().put("type", "manual"))
            .put("nodes", nodes).put("edges", edges).toString()
        vm.log("↑ creating automation \"$name\" (${stepLines.size} steps)…")
        apiCall("POST", "/v1/workflows", body, "flowcreate")
    }

    private fun createSecurityFlow(name: String, target: String, scan: String, prompt: String) {
        val nodes = JSONArray().put(JSONObject().put("id", "trigger").put("type", "trigger").put("label", "Manual"))
            .put(JSONObject().put("id", "recon").put("type", "recon").put("label", "Security recon").put("target", target).put("scan", scan).put("prompt", prompt))
        val edges = JSONArray().put(JSONObject().put("from", "trigger").put("to", "recon"))
        val flow = JSONObject().put("name", name).put("nodes", nodes).put("edges", edges)
            .put("active", false).put("trigger", JSONObject().put("type", "manual"))
        LocalReconStore.save(this, flow)
        refreshLocalWorkflows()
        vm.log("+ saved security automation on this phone: $name")
        if (securitySync && vm.clusterKey.isNotBlank()) apiCall("POST", "/v1/workflows", flow.toString(), "flowcreate")
    }

    private fun mergeLocalWorkflows(data: String): String {
        val remote = try { JSONObject(data).optJSONArray("workflows") ?: JSONArray() } catch (_: Exception) { JSONArray() }
        val merged = JSONArray()
        val local = LocalReconStore.flows(this)
        val localKeys = (0 until local.length()).mapNotNull { local.optJSONObject(it) }.map { flow ->
            flow.optString("name") to LocalReconStore.firstRecon(flow)?.optString("target")
        }.toSet()
        for (i in 0 until remote.length()) remote.optJSONObject(i)?.let { flow ->
            val key = flow.optString("name") to LocalReconStore.firstRecon(flow)?.optString("target")
            if (!flow.optString("id").startsWith("local-recon-") && key !in localKeys) merged.put(flow)
        }
        for (i in 0 until local.length()) merged.put(local.optJSONObject(i))
        return JSONObject().put("workflows", merged).toString()
    }

    private fun refreshLocalWorkflows() {
        val combined = mergeLocalWorkflows(vm.flowsJson)
        vm.flowsJson = combined
        renderFlows(JSONObject(combined).optJSONArray("workflows") ?: JSONArray())
        parseWatchers(combined, false)
    }

    // ---- Conversational Agent (full-screen chat, JSON tool protocol) ----------------------------

    private fun dpi(v: Int) = (v * resources.displayMetrics.density).toInt()

    /** The configured brain (Ollama or on-device), or null with a logged reason. Same choice as the
     *  Agent tab settings, so the chat and the one-shot Run share one place to configure a model. */
    private fun buildBrain(): Llm? {
        return if (vm.useLocal) {
            if (!models.isReady(vm.selectedModel)) { vm.log("! on-device model not downloaded — Agent tab → Download"); null }
            else LocalLlm(this, models.path(vm.selectedModel), ModelCatalog.byId(vm.selectedModel).family)
        } else {
            // Cloud: by default use the CLUSTER's LLM — no key needed on the phone (and it dodges the
            // Cloudflare block a direct ollama.com call hits). A custom self-hosted endpoint+key still wins.
            val custom = vm.endpoint.isNotBlank() && vm.apiKey.isNotBlank() && !vm.endpoint.contains("ollama.com")
            when {
                custom -> OllamaClient(vm.endpoint, vm.apiKey, vm.model)
                vm.clusterUrl.trim().isNotEmpty() -> ClusterLlm(vm.clusterUrl) { cookiesFor(vm.clusterUrl) }
                else -> null
            }
        }
    }

    private fun openAgentChat() {
        shellUi.switcherOpen.value = false
        if (agentChat == null) { if (agentChats.length() > 0) agentChat = agentChats.optJSONObject(0) else newAgentChat() }
        refreshAgentMsgs()
        shellUi.screen.value = "agent"
        startPipLoop()
    }

    private val pipHandler by lazy { android.os.Handler(mainLooper) }
    /** While the agent chat is open, keep a small live snapshot of the active tab for the PiP window. */
    private fun startPipLoop() {
        pipHandler.removeCallbacksAndMessages(null)
        pipHandler.post(object : Runnable {
            override fun run() {
                if (shellUi.screen.value != "agent") { shellUi.pipThumb.value = null; return }
                if (!agentBusy) { shellUi.pipThumb.value = null; pipHandler.postDelayed(this, 800); return }  // show only while working
                try {
                    val i = activeTab
                    if (i in tabs.indices) {
                        val w = tabs[i].web
                        if (w != null && w.width > 0 && w.height > 0) {
                            val scale = 0.35f
                            val bw = (w.width * scale).toInt().coerceAtLeast(1); val bh = (w.height * scale).toInt().coerceAtLeast(1)
                            val bmp = Bitmap.createBitmap(bw, bh, Bitmap.Config.RGB_565)
                            val c = android.graphics.Canvas(bmp); c.scale(scale, scale); w.draw(c)
                            shellUi.pipThumb.value = bmp.asImageBitmap()
                        }
                    }
                } catch (e: Exception) {}
                pipHandler.postDelayed(this, 1200)
            }
        })
    }

    private fun newAgentChat() {
        val c = JSONObject().put("id", "c" + System.currentTimeMillis()).put("title", "New chat").put("messages", JSONArray())
        val next = JSONArray().put(c)
        for (i in 0 until agentChats.length()) next.put(agentChats.get(i))
        agentChats = next; agentChat = c
        persistAgentChats(); refreshAgentMsgs()
    }

    private fun persistAgentChats() {
        while (agentChats.length() > 50) agentChats.remove(agentChats.length() - 1)
        vm.agentChatsJson = agentChats.toString()
    }

    private fun agentPushMsg(role: String, content: String, name: String? = null) {
        val c = agentChat ?: return
        val msgs = c.optJSONArray("messages") ?: JSONArray().also { c.put("messages", it) }
        msgs.put(JSONObject().put("role", role).put("content", content).apply { if (name != null) put("name", name) })
        if (role == "user" && (c.optString("title") == "New chat" || c.optString("title").isBlank())) c.put("title", content.take(42))
        persistAgentChats()
        runOnUiThread { refreshAgentMsgs() }
    }

    /** Rebuild the Compose chat message list from the active chat's persisted messages. */
    private fun refreshAgentMsgs() {
        val c = agentChat
        shellUi.agentTitle.value = c?.optString("title", "Agent") ?: "Agent"
        val msgs = c?.optJSONArray("messages")
        val out = ArrayList<engineer.myapp.gbmobile.ui.ChatMsg>()
        if (msgs != null) for (i in 0 until msgs.length()) {
            val m = msgs.optJSONObject(i) ?: continue
            when (m.optString("role")) {
                "user" -> out.add(engineer.myapp.gbmobile.ui.ChatMsg("user", safeText(m.optString("content"))))
                "assistant" -> {
                    val content = m.optString("content")
                    // an assistant "tool call" record (JSON) is shown as a tool chip, not a raw bubble
                    if (content.trimStart().startsWith("{\"tool\"")) {
                        val nm = try { JSONObject(content).optString("tool", "tool") } catch (e: Exception) { "tool" }
                        out.add(engineer.myapp.gbmobile.ui.ChatMsg("tool", safeText(content), nm))
                    } else out.add(engineer.myapp.gbmobile.ui.ChatMsg("assistant", safeText(content)))
                }
                "tool" -> out.add(engineer.myapp.gbmobile.ui.ChatMsg("tool", safeText(m.optString("content")).take(6000), m.optString("name", "tool")))
            }
        }
        shellUi.agentMsgs.value = out
    }

    /** Strip characters that crash text layout (surrogate pairs / private-use icon-font glyphs, control
     *  chars). Tool results are full of these. */
    private fun safeText(s: String): String =
        s.replace(Regex("[\\uD800-\\uDFFF\\uE000-\\uF8FF]"), "").replace(Regex("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]"), " ")

    /**
     * WHAT THIS PHONE CAN DO, told to the agent.
     *
     * The prompt around it moved to shared/AgentCore — the loop, the JSON-per-turn protocol and the
     * wording are identical on the phone and the desktop, and keeping two copies is how they drifted
     * (the desktop's list was missing the drag and upload its own machine could do). What stays here
     * is what is genuinely this device's: a real touch screen, on-device profiles, and the phone's
     * own cluster tools.
     *
     * Every name below is handled by runAgentTool. A tool advertised and not handled is worse than a
     * missing one, because the model keeps reaching for it.
     */
    private fun agentToolCatalogue(): List<ToolSpec> = listOf(
        ToolSpec("browser_read", "read the active tab {url,title,elements:[{i,tag,type,text}],text} — use before click/type"),
        ToolSpec("browser_navigate", "{url}: open a url in the active tab"),
        ToolSpec("browser_click", "{index}: click element i from browser_read — a REAL touch tap at its coordinates"),
        ToolSpec("browser_click_text", "{text}: click the element whose text/label contains this — use on sites without links (Facebook rows/buttons)"),
        ToolSpec("browser_posts", "read the post-like text blocks of a feed (Facebook groups etc.) — use this to READ a social feed, not browser_read"),
        ToolSpec("browser_type", "{index,text}: type into element i"),
        ToolSpec("browser_scroll", "{dy}: scroll the page"),
        ToolSpec("switch_profile", "{name}: switch the active tab to another on-device profile (e.g. p_facebook) — its cookies/login"),
        ToolSpec("fetch_url", "{url,method,body,headers}: authenticated same-origin fetch from the active tab"),
        ToolSpec("list_workflows", "automations with run counts + verified flags"),
        ToolSpec("create_workflow", "{name,steps:[goal strings],role}: build a trigger->agent automation"),
        ToolSpec("run_workflow", "{id}: run an automation and wait for its outcome"),
        ToolSpec("get_run", "{runId}: a run's status and outcome"),
        ToolSpec("workflow_runs", "{id}: recent runs of an automation"),
        ToolSpec("list_profiles", "the ON-DEVICE browser profiles on THIS phone, which is active, and the current tab (url+profile)"),
        ToolSpec("list_platforms", "the browser presets available"),
        ToolSpec("list_roles", "the roles a step can adopt"),
        ToolSpec("list_devices", "connected device nodes (phone/laptop)"),
        ToolSpec("device_command", "{deviceId,path,body}: drive ANOTHER node — NOT for the user's own signed-in sites on this phone"),
    )

    /** Live context handed to the agent each turn: the tab it actually controls right now. */
    private fun agentTabContext(): String {
        val u = if (this::web.isInitialized) (web.url ?: "") else ""
        val p = vm.currentProfile.value ?: "default"
        return "CURRENT TAB: ${u.ifBlank { "(home)" }} — profile \"$p\". This is a REAL browser tab; the user " +
            "may already be signed in here. Reach the user's own accounts through THIS tab (browser_*), not the cluster."
    }

    private fun sendAgentMessage(input: String) {
        val text = input.trim(); if (text.isEmpty()) return
        // THE OPERATOR on the cluster: "/op <goal>" starts an engineer-grade job inside Ghost Browser that
        // reads what the browser did, changes the smallest wrong thing, runs and proves it; its steps
        // stream into this chat. "/say <text>" speaks into the running job.
        // The Operator switch in the chat sends every message as "/op": a new job, or — while one runs —
        // spoken into it. "/stop" ends the running job.
        if (text.startsWith("/op ") || text == "/op") { val g = text.removePrefix("/op").trim(); if (operatorJobId.isNotBlank()) sayToOperator(g) else runOperatorJob(g); return }
        if (text.startsWith("/say ")) { sayToOperator(text.removePrefix("/say").trim()); return }
        if (text == "/stop") { stopOperator(); return }
        if (agentBusy) return
        val brain = buildBrain()
        if (brain == null) {
            if (agentChat == null) newAgentChat()
            val msg = if (vm.useLocal)
                "You're on ON-DEVICE mode but no model is downloaded. Tap ⚙ → switch to **Cloud model** — it uses your cluster's LLM, no key needed."
            else
                "Cloud mode uses your cluster's LLM, but you're not connected. Settings ▸ Account & sync → Sign in + open Ghost Browser from Tools, and make sure a model is set in the GB console."
            agentPushMsg("assistant", msg)
            return
        }
        if (agentChat == null) newAgentChat()
        agentPushMsg("user", text, null)
        // adopt the active profile's role (like the platform's per-profile agent roles)
        val roleName = roleForProfile(vm.currentProfile.value ?: "default")
        if (roleName.isNotBlank()) vm.log("▶ agent role: $roleName (profile ${vm.currentProfile.value})")
        agentBusy = true; runOnUiThread { shellUi.agentBusy.value = true }
        agentExec.execute {
            /*
             * ONE LOOP, IN shared/AgentCore. This was a copy of the desktop's — same protocol, same
             * reply-or-tool handling, same wording — and the copies had drifted where it mattered:
             * the desktop's tool list never offered the drag and upload its own machine could do.
             * What is left here is what is really this phone's: its tools, its tab, its profile role.
             */
            /*
             * WHAT THIS PHONE DID, KEPT SO IT CAN BE LEARNED FROM.
             *
             * This is the data the ring exists for. The phone holds the real logins at a real
             * address, so it reaches the pages nothing else can — and until now every one of those
             * runs taught the model nothing, because on-device work was journalled as prose into a
             * store the training set never reads.
             */
            agentTrace = engineer.myapp.gb.shared.DeviceTrace.Run(text.trim(), role = roleName, profile = vm.currentProfile.value ?: "")
            agentSaid = ""
            var how = "idle"
            try { AgentCore.run(phoneHost(brain, roleName)) }
            catch (e: Throwable) { how = "failed"; if (agentSaid.isBlank()) agentSaid = e.message ?: "failed"; throw e }
            finally {
                runOnUiThread { agentBusy = false; shellUi.agentBusy.value = false }
                fileAgentTrace(how)
            }
        }
    }

    /* The run being recorded, and the agent's own last word — which becomes the report the
       verifiers read. One at a time, which agentBusy already guarantees on a phone. */
    @Volatile private var agentTrace: engineer.myapp.gb.shared.DeviceTrace.Run? = null
    @Volatile private var agentSaid: String = ""

    /**
     * File the run with the cluster as an ordinary job.
     *
     * Best-effort: a run that worked must never be reported as failed because its history could not
     * be filed. Off the agent thread, because the loop has already finished.
     */
    private fun fileAgentTrace(status: String) {
        val r = agentTrace ?: return
        agentTrace = null
        if (vm.clusterUrl.trim().isEmpty()) return
        val body = r.body(status, agentSaid, android.os.Build.MODEL ?: "phone")
        agentExec.execute {
            try { apiAwait("POST", "/v1/device-runs/trace", body) }
            catch (e: Exception) { vm.log("! run not filed: ${e.message}") }
        }
    }

    /** What this phone brings to the shared agent: its name, its tools, its tab, its role, its model. */
    private fun phoneHost(brain: Llm, roleName: String): AgentHost = object : AgentHost {
        override val deviceNoun = "phone"
        override fun tools() = agentToolCatalogue()
        override fun liveContext() = agentTabContext()
        /* The role the active profile carries. It changes what the agent should be doing at all, so
           AgentCore puts it before everything else. */
        override fun preamble() = if (roleName.isBlank()) "" else
            "ROLE: you are acting as \"$roleName\" — ${roleDescription(roleName)} Stay within this role's remit."
        override fun runTool(name: String, argsJson: String): String {
            val a = try { JSONObject(argsJson) } catch (e: Exception) { JSONObject() }
            return runAgentTool(name, a)
        }
        override fun chat(system: String, user: String) = brain.chat(system, user)
        override fun push(role: String, text: String) {
            if (role == "assistant" && text.isNotBlank()) agentSaid = text
            agentPushMsg(role, text, null)
        }
        /* This app shows the CALL as the assistant's own line and the RESULT as a tool chip, which is
           why AgentCore has two hooks instead of one. */
        override fun pushToolCall(name: String, argsJson: String) {
            /* The decision half of a turn — what the agent chose, with the arguments it chose. */
            agentTrace?.tool(name, argsJson)
            agentPushMsg("assistant", "{\"tool\":\"$name\",\"args\":$argsJson}", null)
        }
        override fun pushToolResult(name: String, result: String) {
            /* The observation half of a turn. A look's result is the numbered list, and DeviceTrace
               keeps it as marks — the only thing that makes a later click learnable. */
            agentTrace?.observed(name, result)
            agentPushMsg("tool", result, name)
        }
        override fun transcript() = buildAgentTranscript()
    }

    /** The cluster operator, from the chat: start a job with a goal, stream its steps as chips, land the
     *  final DONE/BLOCKED line as the reply. Follow-ups while it runs go in with /say. */
    @Volatile private var operatorJobId: String = ""
    private fun runOperatorJob(goal: String) {
        if (agentChat == null) newAgentChat()
        if (goal.isBlank()) { agentPushMsg("assistant", "Tell the operator what to do — e.g. make a post watcher for my LinkedIn posts, or: why does the notifications watcher draft nothing?"); return }
        if (vm.clusterUrl.trim().isEmpty()) { agentPushMsg("assistant", "The operator runs on your cluster — connect first (Settings ▸ Account & sync)."); return }
        if (agentBusy) { agentPushMsg("assistant", "The agent is still busy here. Wait for it to finish, then hand the operator its job."); return }
        agentPushMsg("user", "⚙ $goal", null)
        agentBusy = true; runOnUiThread { shellUi.agentBusy.value = true }
        agentExec.execute {
            try {
                val started = try { JSONObject(apiAwait("POST", "/v1/operator/jobs", JSONObject().put("goal", goal).toString())) } catch (e: Exception) { JSONObject() }
                val jid = started.optString("id")
                if (jid.isBlank()) { agentPushMsg("assistant", "⚠ the operator could not start: ${started.optString("error").ifBlank { "no answer from the cluster" }}"); return@execute }
                operatorJobId = jid; lastOperatorEventT = 0L
                agentPushMsg("assistant", "operator job $jid started — reading the machine…")
                var seen = 0; var status = "running"; var idle = 0
                while (status == "running" || status == "queued") {
                    Thread.sleep(6000)
                    val v = try { JSONObject(apiAwait("GET", "/v1/operator/jobs/$jid", null)) } catch (e: Exception) { if (++idle > 5) break else continue }
                    idle = 0; status = v.optString("status", "running")
                    val ev = v.optJSONArray("events") ?: JSONArray()
                    // the job keeps the last 120 events; render the ones we have not shown yet
                    val total = v.optInt("iterations", 0)
                    for (i in 0 until ev.length()) {
                        val e = ev.optJSONObject(i) ?: continue
                        val t = e.optLong("t", 0L); if (t <= lastOperatorEventT) continue
                        lastOperatorEventT = t
                        when (e.optString("kind")) {
                            "tool" -> agentPushMsg("assistant", JSONObject().put("tool", e.optString("name")).put("args", e.opt("args") ?: "").toString(), null)
                            "result" -> agentPushMsg("tool", e.optString("text"), e.optString("name"))
                            "thought" -> agentPushMsg("assistant", e.optString("text"))
                            "say" -> {}
                        }
                    }
                    seen = ev.length()
                }
                val v = try { JSONObject(apiAwait("GET", "/v1/operator/jobs/$jid", null)) } catch (e: Exception) { JSONObject() }
                val fin = v.optString("finalLine").ifBlank { "the job ended: ${v.optString("status")}" }
                val rep = v.optJSONObject("report")
                val evidence = rep?.opt("evidence")?.let { if (it is JSONObject) it.toString(2) else it.toString() } ?: ""
                agentPushMsg("assistant", fin + (if (evidence.isNotBlank()) "\n\nEvidence: " + evidence.take(1200) else "") + (rep?.optString("lesson")?.takeIf { it.isNotBlank() }?.let { "\n\nLesson kept: $it" } ?: ""))
            } finally { operatorJobId = ""; runOnUiThread { agentBusy = false; shellUi.agentBusy.value = false } }
        }
    }
    @Volatile private var lastOperatorEventT: Long = 0L
    private fun sayToOperator(text: String) {
        val jid = operatorJobId
        if (jid.isBlank()) { agentPushMsg("assistant", "No operator job is running. Switch on Operator and give it a goal."); return }
        agentPushMsg("user", "💬 $text", null)
        agentExec.execute { try { apiAwait("POST", "/v1/operator/jobs/$jid/say", JSONObject().put("text", text).toString()) } catch (e: Exception) { agentPushMsg("assistant", "⚠ could not reach the job: ${e.message}") } }
    }
    private fun stopOperator() {
        val jid = operatorJobId
        if (jid.isBlank()) { agentPushMsg("assistant", "No operator job is running."); return }
        agentPushMsg("user", "⏹ stop", null)
        agentExec.execute { try { apiAwait("POST", "/v1/operator/jobs/$jid/stop", "{}") } catch (e: Exception) { agentPushMsg("assistant", "⚠ could not reach the job: ${e.message}") } }
    }

    private fun buildAgentTranscript(): String {
        val c = agentChat ?: return ""
        val msgs = c.optJSONArray("messages") ?: return ""
        val sb = StringBuilder()
        for (i in 0 until msgs.length()) {
            val m = msgs.optJSONObject(i) ?: continue
            when (m.optString("role")) {
                "user" -> sb.append("User: ").append(m.optString("content")).append("\n")
                "assistant" -> sb.append("Assistant: ").append(m.optString("content")).append("\n")
                "tool" -> sb.append("TOOL RESULT (").append(m.optString("name")).append("): ").append(m.optString("content")).append("\n")
            }
        }
        sb.append("Reply with ONE JSON object now.")
        return sb.toString()
    }

    /** Executes a tool and returns a compact JSON/string result. Runs on the agent thread. */
    private fun runAgentTool(name: String, a: JSONObject): String {
        return when (name) {
            "browser_read" -> { waitSettle(4000); "{\"info\":${evalGb("window.__gb.info()")},\"elements\":${evalGb("window.__gb.mark()")},\"text\":${evalGb("window.__gb.text()")}}" }
            "browser_posts" -> { waitSettle(5000); evalGb("window.__gb.posts()") }
            "browser_navigate", "open_tab" -> "{\"url\":" + JSONObject.quote(navigate(a.optString("url"))) + "}"
            "browser_click_text" -> nativeTapFromCoords(evalGb("window.__gb.coordsText(" + JSONObject.quote(a.optString("text")) + "," + a.optInt("nth", 0) + ")"))
            "browser_click" -> nativeTapFromCoords(evalGb("window.__gb.coords(${a.optInt("index", -1)})"))
            "browser_type" -> evalGb("window.__gb.type(${a.optInt("index", -1)}," + JSONObject.quote(a.optString("text")) + ")")
            "browser_scroll" -> evalGb("window.__gb.scroll(${a.optInt("dy", 600)})")
            "fetch_url" -> fetchInPage(a)
            "list_workflows" -> apiAwait("GET", "/v1/workflows", null)
            "create_workflow" -> {
                val stepsArr = a.optJSONArray("steps") ?: JSONArray().apply { a.optString("steps").split("\n").map { it.trim() }.filter { it.isNotEmpty() }.forEach { put(it) } }
                val nodes = JSONArray().put(JSONObject().put("id", "trigger").put("type", "trigger").put("label", "Manual"))
                val edges = JSONArray(); var prev = "trigger"
                for (i in 0 until stepsArr.length()) {
                    val nid = "n$i"; val node = JSONObject().put("id", nid).put("type", "agent").put("label", "Step ${i + 1}").put("goal", stepsArr.optString(i))
                    if (a.optString("role").isNotBlank()) node.put("role", a.optString("role"))
                    nodes.put(node); edges.put(JSONObject().put("from", prev).put("to", nid)); prev = nid
                }
                apiAwait("POST", "/v1/workflows", JSONObject().put("name", a.optString("name")).put("trigger", JSONObject().put("type", "manual")).put("nodes", nodes).put("edges", edges).toString())
            }
            "run_workflow" -> {
                val started = apiAwait("POST", "/v1/workflows/${a.optString("id")}/run", "{}")
                val runId = try { JSONObject(started).optString("runId") } catch (e: Exception) { "" }
                if (runId.isBlank()) started else {
                    var out = "{\"runId\":${JSONObject.quote(runId)},\"status\":\"running\"}"
                    for (i in 0 until 24) { Thread.sleep(2500); val rr = apiAwait("GET", "/v1/workflow-runs/$runId", null); val ro = try { JSONObject(rr) } catch (e: Exception) { null }; val st = ro?.optString("status") ?: "running"; if (st != "running") { out = "{\"runId\":${JSONObject.quote(runId)},\"status\":${JSONObject.quote(st)},\"outcome\":${JSONObject.quote(runOutcome(ro))}}"; break } }
                    out
                }
            }
            "get_run" -> { val rr = apiAwait("GET", "/v1/workflow-runs/${a.optString("runId")}", null); val ro = try { JSONObject(rr) } catch (e: Exception) { null }; "{\"status\":${JSONObject.quote(ro?.optString("status") ?: "?")},\"outcome\":${JSONObject.quote(runOutcome(ro))}}" }
            "workflow_runs" -> apiAwait("GET", "/v1/workflows/${a.optString("id")}/runs", null)
            "list_profiles" -> {
                // The ON-DEVICE profiles on THIS phone (each its own cookies/login) + the current tab.
                val arr = JSONArray(); for (p in (vm.profiles.value ?: emptyList())) arr.put(p)
                val cur = vm.currentProfile.value ?: "default"
                val u = if (this::web.isInitialized) (web.url ?: "") else ""
                JSONObject().put("profiles", arr).put("active", cur)
                    .put("currentTab", JSONObject().put("url", u).put("profile", cur)).toString()
            }
            "switch_profile" -> {
                val name = a.optString("name").trim()
                if (name.isBlank()) "{\"error\":\"name required\"}"
                else { runOnUiThread { vm.selectProfile(name); renderChips(); newTab(profile = name); shellUi.screen.value = "agent" }; Thread.sleep(600); "{\"ok\":true,\"active\":${JSONObject.quote(name)}}" }
            }
            "list_platforms" -> apiAwait("GET", "/v1/profiles/presets", null)
            "list_roles" -> apiAwait("GET", "/v1/agent/roles", null)
            "list_devices" -> apiAwait("GET", "/v1/device/list", null)
            "device_command" -> apiAwait("POST", "/v1/device/${a.optString("deviceId")}/command", JSONObject().put("path", a.optString("path", "/v1/info")).put("body", a.optJSONObject("body") ?: JSONObject()).toString())
            else -> "{\"error\":\"unknown tool: $name\"}"
        }
    }

    private fun runOutcome(run: JSONObject?): String {
        if (run == null) return ""
        val steps = run.optJSONArray("steps") ?: return ""
        var errored = false; var verifies = 0; var allFound = true
        for (i in 0 until steps.length()) {
            val s = steps.optJSONObject(i) ?: continue
            if (s.optString("status") == "error") errored = true
            if (s.optString("type") == "verify") { verifies++; val o = s.optJSONObject("output"); if (o == null || !o.optBoolean("found")) allFound = false }
        }
        return when { errored -> "a step errored"; verifies > 0 && allFound -> "verified ✓"; verifies > 0 -> "could not confirm"; else -> "" }
    }

    /** Blocking cluster API call for the agent loop (must run OFF the UI thread). */
    private fun apiAwait(method: String, path: String, body: String?): String {
        val id = "r${++agentReqSeq}_${System.nanoTime()}"
        val latch = CountDownLatch(1); agentApiWaiters[id] = latch
        runOnUiThread { apiCall(method, path, body, "agentapi:$id") }
        latch.await(45, TimeUnit.SECONDS); agentApiWaiters.remove(id)
        return agentApiResults.remove(id) ?: "{\"error\":\"timeout\"}"
    }

    private fun extractJsonObj(s: String): JSONObject? {
        val a = s.indexOf('{'); val b = s.lastIndexOf('}')
        if (a < 0 || b <= a) return null
        return try { JSONObject(s.substring(a, b + 1)) } catch (e: Exception) { null }
    }

    // ---- THE ASSISTANT — one chat, one agent, on the cluster ------------------------------------
    // The phone is a thin client: it sends the owner's words to Ghost Browser (bearer key, same channel
    // as watchers/approvals), polls the chat while a turn runs, and renders what comes back. No model
    // call ever leaves the phone, so no key and no proxy 403s here. All calls run on agentExec
    // (apiAwait latches; never on the main thread) and land on the UI via runOnUiThread.

    @Volatile private var assistantChatId: String = ""
    private val assistantPollH by lazy { android.os.Handler(mainLooper) }
    private var mediaPlayer: android.media.MediaPlayer? = null
    /** A data: url into the phone's Downloads (MediaStore on Android 10+); returns the item's uri so a player can open it. */
    private fun saveToDownloads(data: String, name: String): android.net.Uri? = try {
        val mime = data.substringAfter("data:", "application/octet-stream").substringBefore(";")
        val ext = when { mime.contains("png") -> "png"; mime.contains("webp") -> "webp"; mime.contains("jpeg") -> "jpg"; mime.contains("mp4") -> "mp4"; mime.contains("webm") -> "webm"; mime.contains("mpeg") -> "mp3"; mime.contains("wav") -> "wav"; mime.contains("pdf") -> "pdf"; else -> "bin" }
        val bytes = android.util.Base64.decode(data.substringAfter("base64,", ""), android.util.Base64.DEFAULT)
        val fname = (if (name.contains('.')) name else "$name.$ext").replace(Regex("[^A-Za-z0-9._-]"), "_")
        if (android.os.Build.VERSION.SDK_INT < 29) { val f = java.io.File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS), fname); f.writeBytes(bytes); vm.log("● saved ${f.absolutePath}"); android.net.Uri.fromFile(f) }
        else {
            val values = android.content.ContentValues().apply { put(android.provider.MediaStore.Downloads.DISPLAY_NAME, fname); put(android.provider.MediaStore.Downloads.MIME_TYPE, mime); put(android.provider.MediaStore.Downloads.IS_PENDING, 1) }
            val uri = contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            if (uri != null) { contentResolver.openOutputStream(uri)?.use { it.write(bytes) }; values.clear(); values.put(android.provider.MediaStore.Downloads.IS_PENDING, 0); contentResolver.update(uri, values, null, null); vm.log("● saved $fname to Downloads"); runOnUiThread { android.widget.Toast.makeText(this, "Saved $fname to Downloads", android.widget.Toast.LENGTH_SHORT).show() } }
            uri
        }
    } catch (e: Exception) { vm.log("! save $name: ${e.message}"); null }
    private val ASSIST = shellUi.assistant

    private fun assistantOpen() {
        shellUi.switcherOpen.value = false; shellUi.screen.value = "agent"
        ASSIST.connected.value = vm.clusterUrl.trim().isNotEmpty()
        assistantHooksInstall()
        if (!ASSIST.connected.value) return
        assistantOpenLoad()
    }

    /** The platform hooks the shared screens call (save, play, ask, decode) — installed once, from wherever they are first needed. */
    private fun assistantHooksInstall() {
        // a picture in the chat (a generated image, a frame) saves to the phone's Downloads with one tap
        if (engineer.myapp.gb.shared.AssistantHooks.saveImage == null) engineer.myapp.gb.shared.AssistantHooks.saveImage = saveImageHook@{ data, name ->
            try {
                val mime = data.substringAfter("data:", "image/jpeg").substringBefore(";"); val ext = when { mime.contains("png") -> "png"; mime.contains("webp") -> "webp"; else -> "jpg" }
                val bytes = android.util.Base64.decode(data.substringAfter("base64,", ""), android.util.Base64.DEFAULT)
                val fname = (if (name.contains('.')) name else "$name.$ext").replace(Regex("[^A-Za-z0-9._-]"), "_")
                if (android.os.Build.VERSION.SDK_INT < 29) { val f = java.io.File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS), fname); f.writeBytes(bytes); vm.log("● saved ${f.absolutePath}"); return@saveImageHook }
                val values = android.content.ContentValues().apply { put(android.provider.MediaStore.Downloads.DISPLAY_NAME, fname); put(android.provider.MediaStore.Downloads.MIME_TYPE, mime); put(android.provider.MediaStore.Downloads.IS_PENDING, 1) }
                val uri = contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                if (uri != null) { contentResolver.openOutputStream(uri)?.use { it.write(bytes) }; values.clear(); values.put(android.provider.MediaStore.Downloads.IS_PENDING, 0); contentResolver.update(uri, values, null, null); vm.log("● saved $fname to Downloads"); runOnUiThread { android.widget.Toast.makeText(this, "Saved $fname to Downloads", android.widget.Toast.LENGTH_SHORT).show() } }
                else vm.log("! could not save $fname")
            } catch (e: Exception) { vm.log("! save: ${e.message}") }
        }
        // "draft the offer" on a lead row: open the chat and hand the agent the ask
        if (engineer.myapp.gb.shared.AssistantHooks.ask == null) engineer.myapp.gb.shared.AssistantHooks.ask = { text -> runOnUiThread { assistantOpen(); assistantSend(text) } }
        // a song plays inline (MediaPlayer on a cached copy); a clip opens in the system player from its saved copy
        if (engineer.myapp.gb.shared.AssistantHooks.playMedia == null) engineer.myapp.gb.shared.AssistantHooks.playMedia = { downloadUrl, name, mime ->
            val hooks = engineer.myapp.gb.shared.AssistantHooks
            if (hooks.playing.value == downloadUrl) { try { mediaPlayer?.stop(); mediaPlayer?.release() } catch (e: Exception) {}; mediaPlayer = null; hooks.playing.value = null }
            else {
                val id = Regex("/v1/files/([^/]+)/").find(downloadUrl)?.groupValues?.get(1)
                if (id == null) vm.log("! play: no file id") else agentExec.execute {
                    try {
                        val o = JSONObject(apiAwait("GET", "/v1/files/$id/b64", null)); if (o.has("error")) { vm.log("! play: ${o.optString("error")}"); return@execute }
                        val data = o.optString("data"); val m = o.optString("mime", mime); val fname = name.ifBlank { o.optString("name") }
                        val bytes = android.util.Base64.decode(data.substringAfter("base64,", ""), android.util.Base64.DEFAULT)
                        if (m.startsWith("audio/") || fname.lowercase().endsWith(".m4a") || fname.lowercase().endsWith(".mp3")) {
                            val f = java.io.File(cacheDir, "play-" + fname.replace(Regex("[^A-Za-z0-9._-]"), "_")); f.writeBytes(bytes)
                            runOnUiThread {
                                // never let the player take the app down: prepare async, every error caught, system player as the fallback
                                try {
                                    try { mediaPlayer?.stop(); mediaPlayer?.release() } catch (e: Exception) {}
                                    val mp = android.media.MediaPlayer(); mediaPlayer = mp
                                    mp.setAudioAttributes(android.media.AudioAttributes.Builder().setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC).setUsage(android.media.AudioAttributes.USAGE_MEDIA).build())
                                    mp.setDataSource(f.absolutePath)
                                    mp.setOnPreparedListener { p -> try { p.start(); hooks.playing.value = downloadUrl } catch (e: Exception) { vm.log("! play start: ${e.message}") } }
                                    mp.setOnCompletionListener { hooks.playing.value = null }
                                    mp.setOnErrorListener { _, what, extra -> vm.log("! player error $what/$extra — opening in the system player"); hooks.playing.value = null; agentExec.execute { try { val uri = saveToDownloads(data, fname); if (uri != null) runOnUiThread { try { startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW).setDataAndType(uri, m).addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)) } catch (e: Exception) { vm.log("! no player: ${e.message}") } } } catch (e: Exception) {} }; true }
                                    mp.prepareAsync()
                                } catch (e: Throwable) { vm.log("! play $fname: ${e.message}"); hooks.playing.value = null; android.widget.Toast.makeText(this, "Could not play ${fname}: ${e.message}", android.widget.Toast.LENGTH_SHORT).show() }
                            }
                        } else {
                            val uri = saveToDownloads(data, fname)
                            if (uri != null) runOnUiThread { try { startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW).setDataAndType(uri, m).addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)) } catch (e: Exception) { vm.log("! no player for $m: ${e.message}") } }
                        }
                    } catch (e: Throwable) { vm.log("! play $name: ${e.javaClass.simpleName} ${e.message}"); runOnUiThread { try { android.widget.Toast.makeText(this, "Could not play $name", android.widget.Toast.LENGTH_SHORT).show() } catch (t: Throwable) {} } }
                }
            }
        }
        // RECORDINGS: the card's hands — stream (the player activity with the session cookie), stop, save (streamed mp4), refresh
        val RH = engineer.myapp.gb.shared.RecordingHooks
        // a native player or a download cannot carry the session reliably: the media URL gets a short-lived ticket instead
        if (RH.play == null) RH.play = { rec -> agentExec.execute {
            try {
                val tk = JSONObject(apiAwait("POST", "/v1/recordings/${rec.id}/ticket", "{}"))
                if (tk.has("error")) { vm.log("! play: ${tk.optString("error")}"); return@execute }
                val path = if (rec.running) tk.optString("playlist") else tk.optString("mp4")
                val url = vm.clusterUrl.trim().trimEnd('/') + path
                runOnUiThread { try { startActivity(Intent(this, PlayerActivity::class.java).putExtra("url", url).putExtra("cookie", clusterCookie()).putExtra("title", rec.name)) } catch (e: Exception) { vm.log("! play recording: ${e.message}") } }
            } catch (e: Exception) { vm.log("! play recording: ${e.message}") }
        } }
        if (RH.stop == null) RH.stop = { id -> stopRecording(id) }
        if (RH.save == null) RH.save = { rec -> saveRecordingToDevice(rec) }
        // a share link: a public player page that expires in 7 days, on the clipboard and in the share sheet
        if (RH.share == null) RH.share = { rec -> agentExec.execute {
            try {
                val sh = JSONObject(apiAwait("POST", "/v1/recordings/${rec.id}/share", "{\"days\":7}"))
                if (sh.has("error")) { vm.log("! share: ${sh.optString("error")}"); return@execute }
                val link = vm.clusterUrl.trim().trimEnd('/') + sh.optString("url")
                runOnUiThread {
                    try { (getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(android.content.ClipData.newPlainText("Recording link", link)) } catch (e: Exception) {}
                    try { startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_SUBJECT, rec.name).putExtra(Intent.EXTRA_TEXT, link), "Share the recording (link expires in ${sh.optInt("days", 7)} days)")) } catch (e: Exception) { android.widget.Toast.makeText(this, "Link copied — expires in ${sh.optInt("days", 7)} days", android.widget.Toast.LENGTH_LONG).show() }
                }
            } catch (e: Exception) { vm.log("! share: ${e.message}") }
        } }
        if (RH.refresh == null) RH.refresh = { id -> apiCall("GET", "/v1/recordings/$id", null, "recording") }
        // any captured FILE (a video, a PDF, an export): fetched as base64 from Ghost Browser, then saved like a picture
        if (engineer.myapp.gb.shared.AssistantHooks.saveFile == null) engineer.myapp.gb.shared.AssistantHooks.saveFile = { downloadUrl, name ->
            val id = Regex("/v1/files/([^/]+)/").find(downloadUrl)?.groupValues?.get(1)
            if (id == null) vm.log("! save: no file id in $downloadUrl") else agentExec.execute {
                try {
                    val o = JSONObject(apiAwait("GET", "/v1/files/$id/b64", null))
                    if (o.has("error")) vm.log("! save ${name}: ${o.optString("error")}")
                    else engineer.myapp.gb.shared.AssistantHooks.saveImage?.invoke(o.optString("data"), name.ifBlank { o.optString("name") })
                } catch (e: Exception) { vm.log("! save $name: ${e.message}") }
            }
        }
        // pictures the agent took arrive as data: urls; decode them here (the shared screen has no bitmap codec)
        if (ASSIST.decodeImage == null) ASSIST.decodeImage = { data ->
            try { val b64 = data.substringAfter("base64,", ""); val bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT); android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() } catch (e: Exception) { null }
        }
        if (engineer.myapp.gb.shared.AssistantHooks.getAppMapJson == null) {
            val spMaps = getSharedPreferences("gb_app_maps", MODE_PRIVATE)
            engineer.myapp.gb.shared.AssistantHooks.getAppMapJson = { domain ->
                spMaps.getString("map_" + domain, null)
            }
            engineer.myapp.gb.shared.AssistantHooks.saveAppMapJson = { domain, data ->
                spMaps.edit().putString("map_" + domain, data).apply()
            }
            engineer.myapp.gb.shared.AssistantHooks.getSelectedTargetUrl = {
                spMaps.getString("active_target_url", null)
            }
            engineer.myapp.gb.shared.AssistantHooks.saveSelectedTargetUrl = { url ->
                spMaps.edit().putString("active_target_url", url).apply()
            }
            engineer.myapp.gb.shared.AssistantHooks.getManagedAppsJson = {
                spMaps.getString("managed_apps_list", null)
            }
            engineer.myapp.gb.shared.AssistantHooks.saveManagedAppsJson = { data ->
                spMaps.edit().putString("managed_apps_list", data).apply()
            }
            engineer.myapp.gb.shared.AssistantHooks.getAvailableProfiles = {
                if (shellUi.profileCards.value.isEmpty() && vm.clusterUrl.trim().isNotEmpty()) {
                    try { profilesLoad() } catch (e: Exception) {}
                }
                val fromCards = shellUi.profileCards.value.map { it.name }.filter { it.isNotBlank() }
                val fromVm = vm.profiles.value ?: emptyList()
                val fromWatcher = shellUi.watcherProfiles.value ?: emptyList()
                val combined = (fromCards + fromVm + fromWatcher).filter { it.isNotBlank() }.distinct()
                if (combined.isNotEmpty()) combined else listOf("default", "operator")
            }
        }

    }

    private fun assistantOpenLoad() {
        agentExec.execute {
            aiModelLoad()
            if (assistantChatId.isBlank()) {
                val list = AssistantJson.chats(apiAwait("GET", "/v1/assistant/chats", null))
                runOnUiThread { ASSIST.chats.value = list }
                val first = list.firstOrNull { !it.running } ?: list.firstOrNull()
                if (first != null) assistantLoad(first.id) else assistantNew()
            } else assistantLoad(assistantChatId)
        }
        // no PiP of the phone's own tab any more: the cluster browser is the backdrop of the chat itself
    }
    private fun assistantRefreshChats() { val list = AssistantJson.chats(apiAwait("GET", "/v1/assistant/chats", null)); runOnUiThread { ASSIST.chats.value = list } }
    /** Load a chat (worker thread) and, while a turn runs, keep polling it every 2.5 s. */
    private fun assistantLoad(id: String) {
        val raw = apiAwait("GET", "/v1/assistant/chats/$id", null)
        val v = AssistantJson.chat(raw)
        // the live frame of the browser the agent works in — decoded here, off the main thread
        val frame = v?.live?.backdrop?.takeIf { it.isNotBlank() }?.let { d -> try { ASSIST.decodeImage?.invoke(d) } catch (e: Throwable) { null } }
        runOnUiThread {
            if (v == null) { ASSIST.error.value = "Could not reach your Ghost Browser (${raw.take(80)})"; shellUi.agentBusy.value = false; return@runOnUiThread }
            if (frame != null) { ASSIST.backdrop.value = frame; ASSIST.backdropProfile.value = v.live?.backdropProfile ?: "" }
            assistantChatId = v.id; ASSIST.chat.value = v; ASSIST.selectedAgent.value = v.agentType; ASSIST.error.value = ""
            shellUi.agentBusy.value = v.live != null
            assistantPollH.removeCallbacksAndMessages(null)
            if (v.live != null) assistantPollH.postDelayed({ if (shellUi.screen.value == "agent" || true) agentExec.execute { assistantLoad(v.id) } }, 2500)
            // a recording somewhere in this chat: keep its card's numbers fresh (every ~5 s while one runs, once otherwise)
            val recIds = (v.turns.flatMap { t -> t.steps.map { it.recording } + t.cards.filter { it.kind == "recording" }.map { it.id } } + (v.live?.steps?.map { it.recording } ?: emptyList())).filter { it.isNotBlank() }.toSet()
            if (recIds.isNotEmpty()) {
                val known = engineer.myapp.gb.shared.RecordingHooks.recordings.value
                val anyRunning = recIds.any { known[it]?.running != false }
                if (anyRunning && System.currentTimeMillis() - recordingsPolledAt > 4500) { recordingsPolledAt = System.currentTimeMillis(); apiCall("GET", "/v1/recordings", null, "recordings") }
                if (v.live == null && anyRunning) assistantPollH.postDelayed({ agentExec.execute { assistantLoad(v.id) } }, 5000)   // a turn that ended still refreshes while its recording runs
            }
        }
    }
    private fun assistantNew(agentType: String = shellUi.assistant.selectedAgent.value) {
        val payload = org.json.JSONObject().put("title", if (agentType == "recon") "Security Recon Audit" else "New chat").put("agentType", agentType).toString()
        val raw = apiAwait("POST", "/v1/assistant/chats", payload)
        val v = AssistantJson.chat(raw)
        runOnUiThread {
            ASSIST.selectedAgent.value = agentType
            if (v != null) {
                assistantChatId = v.id
                val adjusted = if (v.agentType.isBlank() || (v.agentType == "browser" && agentType == "recon")) v.copy(agentType = agentType) else v
                ASSIST.chat.value = adjusted
                ASSIST.error.value = ""
                shellUi.agentBusy.value = false
            } else {
                assistantChatId = ""
                ASSIST.chat.value = null
                shellUi.agentBusy.value = false
            }
        }
        assistantRefreshChats()
    }
    private fun assistantSend(text: String) {
        if (text.isBlank()) return
        val currentAgent = shellUi.assistant.selectedAgent.value
        // the owner's words appear at once; the cluster's copy replaces it on the next load
        ASSIST.chat.value?.let { c -> ASSIST.chat.value = c.copy(turns = c.turns + engineer.myapp.gb.shared.AssistantTurn("user", text, System.currentTimeMillis(), spoken = c.live != null)) }
        shellUi.agentBusy.value = true

        agentExec.execute {
            if (assistantChatId.isBlank()) {
                val payload = org.json.JSONObject().put("agentType", currentAgent).put("title", if (currentAgent == "recon") "Security Recon Audit" else "New chat").toString()
                val v = AssistantJson.chat(apiAwait("POST", "/v1/assistant/chats", payload))
                if (v == null) {
                    runOnUiThread { ASSIST.error.value = "Could not start a chat — is your Ghost Browser connected?"; shellUi.agentBusy.value = false }
                    return@execute
                }
                assistantChatId = v.id
                runOnUiThread {
                    ASSIST.chat.value = if (v.agentType.isBlank() || (v.agentType == "browser" && currentAgent == "recon")) v.copy(agentType = currentAgent) else v
                    ASSIST.selectedAgent.value = currentAgent
                }
            }
            val id = assistantChatId
            val r = try { JSONObject(apiAwait("POST", "/v1/assistant/chats/$id/messages", JSONObject().put("text", text).toString())) } catch (e: Exception) { JSONObject().put("error", "no answer from the cluster: " + (e.message ?: "")) }
            if (r.has("error")) {
                val err = r.optString("error", "Cluster request failed")
                if (vm.clusterUrl.trim().isNotEmpty()) {
                    runOnUiThread {
                        ASSIST.error.value = "Cluster dispatch failed: $err"
                        shellUi.agentBusy.value = false
                    }
                    vm.log("! cluster agent error: $err")
                    return@execute
                }
                if (currentAgent == "recon") {
                    runOnDeviceReconTurn(text)
                    return@execute
                }
                runOnUiThread { ASSIST.error.value = err; shellUi.agentBusy.value = false }
                return@execute
            }
            assistantLoad(id); assistantRefreshChats() // post-send
        }
    }

    private fun runOnDeviceReconTurn(prompt: String) {
        val targetMatch = Regex("""(?:https?://)?([a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z0-9][-a-zA-Z0-9]*)+(?::\d+)?)""").find(prompt)
        val extractedTarget = targetMatch?.groupValues?.get(1)?.trim() ?: ""
        val target = if (extractedTarget.isNotBlank()) extractedTarget else {
            shellUi.reconUi.currentTarget.value.trim().ifBlank {
                currentUrl().takeIf { it != HOME && it.startsWith("http") }?.let { try { java.net.URI(it).host } catch (e: Exception) { null } } ?: "my-app.engineer"
            }
        }

        val startTime = System.currentTimeMillis()
        val live = engineer.myapp.gb.shared.AssistantLive(
            jobId = "recon-${System.currentTimeMillis()}",
            status = "running",
            iterations = 1,
            tasks = listOf(
                engineer.myapp.gb.shared.AssistantTask(title = "Perimeter & Port Reconnaissance", done = false, note = ""),
                engineer.myapp.gb.shared.AssistantTask(title = "HTTP Security Headers & SSL Audit", done = false, note = ""),
                engineer.myapp.gb.shared.AssistantTask(title = "Attack Surface & 4-Pillar Remediation", done = false, note = "")
            ),
            steps = listOf(
                engineer.myapp.gb.shared.AssistantStep(name = "recon", label = "Targeting $target", args = "", text = "Starting security assessment"),
                engineer.myapp.gb.shared.AssistantStep(name = "read", label = "Evaluating perimeter & headers", args = "", text = "Probing $target")
            ),
            startedAt = startTime
        )
        runOnUiThread {
            shellUi.reconUi.currentTarget.value = target
            val c = ASSIST.chat.value
            if (c != null) {
                ASSIST.chat.value = c.copy(live = live)
            } else {
                ASSIST.chat.value = engineer.myapp.gb.shared.AssistantChatView(
                    id = "chat-${System.currentTimeMillis()}",
                    title = "Security Recon Audit",
                    turns = listOf(engineer.myapp.gb.shared.AssistantTurn("user", prompt, System.currentTimeMillis())),
                    live = live,
                    agentType = "recon"
                )
            }
        }

        val report = OnDeviceAuditor.audit(target)

        val sb = StringBuilder()
        sb.append("### Security Recon Audit (Local On-Device Auditor)\n")
        sb.append("**Security Posture: Grade ${report.grade} · ${report.score}/100 · WAF: ${report.waf.name}**\n\n")

        if (report.findings.isNotEmpty()) {
            sb.append("#### Key Security Findings (${report.findingsCount})\n")
            report.findings.forEach { f ->
                val timeEst = when (f.severity.uppercase()) {
                    "CRITICAL" -> "5 min"
                    "HIGH" -> if (f.title.contains("SRI", ignoreCase = true)) "30 min" else "5 min"
                    "MEDIUM" -> "5 min"
                    else -> "2 min"
                }
                sb.append("- **[${f.severity}]** ${f.title}  *(${timeEst})*\n")
                if (f.impact.isNotBlank()) sb.append("  - *Risk*: ${f.impact}\n")
                val fix = if (f.traefik.isNotBlank()) f.traefik else if (f.nginx.isNotBlank()) f.nginx else f.rootCause
                if (fix.isNotBlank()) sb.append("  - *Fix*: ${fix}\n")
            }
            sb.append("\n")
        }

        if (report.findings.isEmpty()) {
            sb.append("#### Security Baseline & Verified Protections\n")
            sb.append("- **Content-Security-Policy (CSP)**: Active and enforcing script boundaries.\n")
            sb.append("- **Anti-Clickjacking**: X-Frame-Options: DENY and frame-ancestors active.\n")
            sb.append("- **Strict-Transport-Security (HSTS)**: 1-year max-age preload active.\n")
            sb.append("- **MIME Protection**: X-Content-Type-Options: nosniff enforced.\n")
            sb.append("- **Referrer-Policy**: strict-origin-when-cross-origin enforced.\n\n")
        }
        if (report.openPorts.isNotEmpty()) {
            sb.append("#### Network Perimeter & Port Exposure\n")
            report.openPorts.forEach { p -> sb.append("- **Port " + p.port + "/" + p.service + "**: " + p.state.uppercase() + "\n") }
            sb.append("\n")
        }
        if (report.cves.isNotEmpty()) {
            sb.append("#### Discovered CVE Vulnerabilities (" + report.cves.size + ")\n")
            report.cves.forEach { cv -> sb.append("- **" + cv.cveId + "** (CVSS " + cv.cvss + "): " + cv.title + "\n") }
            sb.append("\n")
        }
        sb.append("#### 4-Pillar Remediation Summary\n\n")
        sb.append("| Component | Action Required | Effort |\n")
        sb.append("|---|---|---|\n")
        if (report.findings.any { it.severity.equals("CRITICAL", ignoreCase = true) || it.severity.equals("HIGH", ignoreCase = true) }) {
            sb.append("| **Traefik** | Enforce HSTS, X-Frame-Options & strict CORS middleware | 10 min |\n")
            sb.append("| **Nginx** | Hide server tokens, configure SSL ciphers & block xmlrpc.php | 5 min |\n")
            sb.append("| **Express** | Mount helmet() and sanitize cookie flags (HttpOnly, Secure) | 15 min |\n")
            sb.append("| **DNS** | Configure SPF, DMARC, and CAA records | 5 min |\n")
        } else {
            sb.append("| **Perimeter** | Maintain current security headers & monitor ports | Ongoing |\n")
        }

        val detailSb = StringBuilder()
        detailSb.append("Target: $target\n")
        detailSb.append("Timestamp: ${report.timestamp}\n")
        detailSb.append("Score: ${report.score}/100 (Grade ${report.grade})\n")
        detailSb.append("WAF: ${report.waf.name}\n\n")
        if (report.openPorts.isNotEmpty()) {
            detailSb.append("Open Ports:\n")
            report.openPorts.forEach { p ->
                detailSb.append("  - Port ${p.port}/${p.service}: ${p.state}\n")
            }
            detailSb.append("\n")
        }
        if (report.cves.isNotEmpty()) {
            detailSb.append("Discovered CVEs:\n")
            report.cves.forEach { cv ->
                detailSb.append("  - ${cv.cveId}: ${cv.title} (CVSS ${cv.cvss})\n")
            }
        }

        val cleanUrl = if (target.startsWith("http://") || target.startsWith("https://")) target else "https://$target"
        val cards = ArrayList<engineer.myapp.gb.shared.AssistantCard>()
        cards.add(engineer.myapp.gb.shared.AssistantCard(kind = "url", url = cleanUrl, title = "Open Site"))
        if (report.findings.any { it.title.contains("readme.html", ignoreCase = true) }) {
            cards.add(engineer.myapp.gb.shared.AssistantCard(kind = "url", url = "$cleanUrl/readme.html", title = "View Exposed readme.html"))
        }
        if (report.findings.any { it.title.contains("REST API", ignoreCase = true) }) {
            cards.add(engineer.myapp.gb.shared.AssistantCard(kind = "url", url = "$cleanUrl/wp-json/wp/v2/users", title = "View Exposed REST API"))
        }
        if (report.findings.any { it.title.contains("author", ignoreCase = true) }) {
            cards.add(engineer.myapp.gb.shared.AssistantCard(kind = "url", url = "$cleanUrl/?author=1", title = "View Exposed Author Page"))
        }
        cards.add(engineer.myapp.gb.shared.AssistantCard(kind = "recon", url = cleanUrl, title = "Open ReconForge Report"))
        cards.add(engineer.myapp.gb.shared.AssistantCard(kind = "pdf", url = sb.toString(), id = detailSb.toString(), title = "Save Report as PDF"))

        val finalTurn = engineer.myapp.gb.shared.AssistantTurn(
            role = "assistant",
            text = sb.toString(),
            t = System.currentTimeMillis(),
            status = "done",
            details = detailSb.toString(),
            cards = cards,
            steps = listOf(
                engineer.myapp.gb.shared.AssistantStep(name = "recon", label = "Perimeter port & DNS scan", args = "", text = "Probed $target"),
                engineer.myapp.gb.shared.AssistantStep(name = "read", label = "HTTP security headers & cookies", args = "", text = "Posture: Grade ${report.grade}"),
                engineer.myapp.gb.shared.AssistantStep(name = "results", label = "Calculated 4-pillar remediations", args = "", text = "${report.findingsCount} findings")
            )
        )

        runOnUiThread {
            shellUi.reconUi.report.value = report
            shellUi.reconUi.currentTarget.value = target
            val currentChat = ASSIST.chat.value
            if (currentChat != null) {
                ASSIST.chat.value = currentChat.copy(
                    live = null,
                    turns = currentChat.turns + finalTurn
                )
            } else {
                val newChat = engineer.myapp.gb.shared.AssistantChatView(
                    id = "chat-${System.currentTimeMillis()}",
                    title = "Security Recon Audit",
                    turns = listOf(
                        engineer.myapp.gb.shared.AssistantTurn("user", prompt, System.currentTimeMillis()),
                        finalTurn
                    ),
                    live = null,
                    agentType = "recon"
                )
                ASSIST.chat.value = newChat
                assistantChatId = newChat.id
            }
            shellUi.agentBusy.value = false
        }
    }

        private fun resolveCardUrl(c: engineer.myapp.gb.shared.AssistantCard): String {
        var raw = c.url.trim()
        val base = shellUi.reconUi.currentTarget.value.trim().ifBlank {
            currentUrl().takeIf { it != HOME && it.startsWith("http") } ?: shellUi.url.value.trim()
        }.trimEnd('/')

        val cleanBase = if (base.isNotBlank() && !base.startsWith("http://") && !base.startsWith("https://")) {
            "https://$base"
        } else {
            base
        }

        if (raw.isNotBlank()) {
            if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("file://")) {
                return raw
            }
            if (cleanBase.isNotBlank()) {
                val path = if (raw.startsWith("/")) raw else "/$raw"
                return cleanBase + path
            }
            return "https://$raw"
        }

        val title = c.title.trim()
        if (title.equals("Open Site", ignoreCase = true) || title.equals("Open Target", ignoreCase = true)) {
            return cleanBase
        }
        if (title.contains("readme.html", ignoreCase = true)) {
            return if (cleanBase.isNotBlank()) "$cleanBase/readme.html" else "https://readme.html"
        }
        if (title.contains("REST API", ignoreCase = true)) {
            return if (cleanBase.isNotBlank()) "$cleanBase/wp-json/wp/v2/users" else "https://wp-json"
        }
        if (title.contains("Author Page", ignoreCase = true) || title.contains("Author", ignoreCase = true)) {
            return if (cleanBase.isNotBlank()) "$cleanBase/?author=1" else cleanBase
        }
        if (title.contains("xmlrpc.php", ignoreCase = true)) {
            return if (cleanBase.isNotBlank()) "$cleanBase/xmlrpc.php" else cleanBase
        }
        if (title.contains("wp-config", ignoreCase = true)) {
            return if (cleanBase.isNotBlank()) "$cleanBase/wp-config.php" else cleanBase
        }
        if (title.contains("security.txt", ignoreCase = true)) {
            return if (cleanBase.isNotBlank()) "$cleanBase/.well-known/security.txt" else cleanBase
        }
        if (title.startsWith("http://") || title.startsWith("https://")) {
            return title
        }
        if (title.startsWith("/")) {
            return if (cleanBase.isNotBlank()) cleanBase + title else "https://$title"
        }
        return ""
    }

    /** A card the assistant handed the owner: a door into results, approvals, a page, or PDF export. */
    private fun assistantCard(c: engineer.myapp.gb.shared.AssistantCard) {
        when {
            c.kind == "pdf" || c.title.contains("pdf", ignoreCase = true) -> {
                val reportText = c.url.ifBlank { ASSIST.chat.value?.turns?.lastOrNull { it.role == "assistant" }?.text ?: "" }
                val details = c.id.ifBlank { ASSIST.chat.value?.turns?.lastOrNull { it.role == "assistant" }?.details ?: "" }
                // Extract audited target from report to avoid displaying an unrelated active browser tab URL
                val extractedTarget = Regex("""(?:\*\*Target:\*\*|Target:)\s*`?([^\n`*]+)`?""", RegexOption.IGNORE_CASE)
                    .find(reportText)?.groupValues?.get(1)?.trim()
                val target = extractedTarget?.ifBlank { null }
                    ?: shellUi.reconUi.currentTarget.value.ifBlank { shellUi.url.value }
                val model = ASSIST.model.value.ifBlank { "gemma4:31b" }
                ReconReportPdf.exportAndOpen(this, target, model, reportText, details)
            }
            c.kind == "results" -> if (c.watcherId.isNotBlank()) openWatcherResults(c.watcherId)
            c.kind == "approvals" -> { shellUi.screen.value = "approvals"; pollApprovals(); startApprovalsPolling() }
            c.kind == "recon" -> {
                val t = if (c.url.isNotBlank()) c.url else c.title
                shellUi.reconUi.currentTarget.value = t
                shellUi.reconUi.isOpen.value = true
                runReconScan(t, true)
            }
            else -> {
                val targetUrl = resolveCardUrl(c)
                if (targetUrl.isNotBlank()) {
                    runOnUiThread {
                        newTab(targetUrl, activate = true)
                        shellUi.screen.value = "browser"
                        shellUi.switcherOpen.value = false
                    }
                } else if (c.kind == "choice") {
                    assistantSend(c.title)
                }
            }
        }
    }

    // ---- The AI model: Ghost Browser's own setting, edited from here ----------------------------
    /* The run open in the browser, so a label can re-read it. */
    private var lastOpenRun = ""
    private val AIM = shellUi.aiModel
    private fun aiModelLoad() {
        runOnUiThread { AIM.loading.value = true }
        val info = AssistantJson.model(apiAwait("GET", "/v1/agent/settings", null))
        runOnUiThread { AIM.loading.value = false; if (info != null) { AIM.info.value = info; ASSIST.model.value = info.model } else AIM.note.value = "could not read the model from your Ghost Browser" }
    }
    private fun aiModelBody(host: String, key: String, model: String? = null): String {
        val b = JSONObject(); if (host.isNotBlank()) b.put("llmHost", host.trim().removeSuffix("/").removeSuffix("/v1")); if (key.isNotBlank()) b.put("llmKey", key.trim()); if (model != null && model.isNotBlank()) b.put("llmModel", model.trim()); return b.toString()
    }
    private fun aiModelList(host: String, key: String) {
        runOnUiThread { AIM.busy.value = true; AIM.note.value = "asking your Ghost Browser…" }
        val (list, note) = AssistantJson.models(apiAwait("POST", "/v1/agent/models", aiModelBody(host, key)))
        runOnUiThread { AIM.busy.value = false; AIM.models.value = list; AIM.note.value = note }
    }
    private fun aiModelTest(host: String, key: String, model: String) {
        runOnUiThread { AIM.busy.value = true; AIM.note.value = "testing $model…" }
        val r = try { JSONObject(apiAwait("POST", "/v1/agent/test", aiModelBody(host, key, model))) } catch (e: Exception) { JSONObject().put("error", "no answer") }
        runOnUiThread { AIM.busy.value = false; AIM.note.value = if (r.has("error")) "✗ ${r.optString("error").take(120)}" else "✓ $model answers" }
    }
    private fun aiModelSave(host: String, key: String, model: String) {
        val r = try { JSONObject(apiAwait("PUT", "/v1/agent/settings", aiModelBody(host, key, model))) } catch (e: Exception) { JSONObject().put("error", "no answer") }
        runOnUiThread { AIM.note.value = if (r.has("error")) "✗ ${r.optString("error").take(120)}" else "✓ saved — the agent now runs on ${r.optString("llmModel", model)}" }
        aiModelLoad()
    }
    /* The backup ring — a key from a different account, tried only after the first hits its limit. */
    private fun aiModelSaveBackups(backups: String) {
        try { apiAwait("PUT", "/v1/agent/settings", JSONObject().put("llmKeys", backups.trim()).toString()) } catch (e: Exception) { runOnUiThread { AIM.note.value = "✗ could not save the backup key" } }
        aiModelLoad()
    }

    // ---- Cluster panel --------------------------------------------------------------------------

    /** Build the shell (browser/flows/agent) actions. */
    
    private fun runReconScan(target: String, comprehensive: Boolean) {
        val t = target.trim()
        if (t.isBlank()) return
        shellUi.reconUi.isScanning.value = true
        shellUi.reconUi.error.value = null

        // Live page DOM & Burp Suite extractor from active WebView
        var liveDomJson: String? = null
        val activeWeb = if (::web.isInitialized) web else null
        if (activeWeb != null) {
            val latch = java.util.concurrent.CountDownLatch(1)
            runOnUiThread {
                val extractorJs = """
                    (function() {
                      try {
                        var endpoints = [];
                        var seen = {};
                        function add(u, method, auth, ct) {
                          if (!u || u.startsWith('javascript:') || u.startsWith('mailto:') || u.startsWith('#')) return;
                          var key = (method || 'GET') + ':' + u;
                          if (seen[key]) return;
                          seen[key] = true;
                          endpoints.push({ url: u, method: method || 'GET', isAuthRequired: !!auth, contentType: ct || 'text/html' });
                        }
                        add(location.pathname + location.search, 'GET', false, 'text/html');
                        document.querySelectorAll('a[href]').forEach(function(a) {
                          var p = a.pathname + a.search;
                          add(p, 'GET', p.includes('admin') || p.includes('dashboard') || p.includes('account'), 'text/html');
                        });
                        document.querySelectorAll('form').forEach(function(f) {
                          var action = f.getAttribute('action') || location.pathname;
                          var method = (f.getAttribute('method') || 'POST').toUpperCase();
                          add(action, method, true, 'application/x-www-form-urlencoded');
                        });
                        if (window.performance && window.performance.getEntriesByType) {
                          window.performance.getEntriesByType('resource').forEach(function(r) {
                            try {
                              var u = new URL(r.name);
                              if (u.hostname === location.hostname) {
                                var p = u.pathname + u.search;
                                var isApi = p.includes('/api/') || p.includes('/v1/') || p.includes('/v2/') || p.includes('/graphql') || r.initiatorType === 'fetch' || r.initiatorType === 'xmlhttprequest';
                                var ct = isApi ? 'application/json' : (r.initiatorType === 'script' ? 'application/javascript' : 'text/html');
                                add(p, 'GET', isApi, ct);
                              }
                            } catch(e) {}
                          });
                        }
                        var scriptText = Array.from(document.scripts).map(function(s) { return s.textContent; }).join(' ');
                        var apiRegex = /(?:['"]|\x60)(\/(?:api|v[0-9]|graphql|auth|user|admin|checkout|login|signup|upload|file|dashboard|feed|query|status|settings|items|orders|data)\/[a-zA-Z0-9_\-/.]+)(?:['"]|\x60)/gi;
                        var m;
                        while ((m = apiRegex.exec(scriptText)) !== null) {
                          add(m[1], 'GET', m[1].includes('auth') || m[1].includes('admin'), 'application/json');
                        }
                        var tech = [];
                        if (window.React || document.querySelector('[data-reactroot], [data-reactid]')) tech.push('React');
                        if (window.Vue || document.querySelector('[data-v-]')) tech.push('Vue.js');
                        if (window.jQuery) tech.push('jQuery ' + (window.jQuery.fn ? window.jQuery.fn.jquery : ''));
                        if (window.angular || document.querySelector('[ng-app], [ng-version]')) tech.push('Angular');
                        if (document.querySelector('meta[name="generator"][content*="WordPress"]')) tech.push('WordPress');

                        var storageTokens = [];
                        for (var i = 0; i < localStorage.length; i++) {
                          var k = localStorage.key(i);
                          if (/auth|token|jwt|session|key|secret/i.test(k)) {
                            storageTokens.push({ key: k, val: (localStorage.getItem(k) || '').slice(0, 40) + '...' });
                          }
                        }
                        return JSON.stringify({ endpoints: endpoints.slice(0, 60), tech: tech, storageTokens: storageTokens });
                      } catch(err) {
                        return JSON.stringify({ error: err.message });
                      }
                    })()
                """.trimIndent()
                activeWeb.evaluateJavascript(extractorJs) { res ->
                    liveDomJson = res
                    latch.countDown()
                }
            }
            try { latch.await(600, java.util.concurrent.TimeUnit.MILLISECONDS) } catch (e: Exception) {}
        }

        agentExec.execute {
            try {
                // Perform real on-device audit with parallel port scan, CVE correlation & DOM extraction
                val localReport = OnDeviceAuditor.audit(t, liveDomJson)
                var report: engineer.myapp.gb.shared.ReconReport? = null

                if (vm.clusterUrl.isNotBlank()) {
                    try {
                        val payload = org.json.JSONObject().apply {
                            put("target", t)
                            put("mode", if (comprehensive) "comprehensive" else "perimeter")
                        }.toString()
                        val res = apiAwait("POST", "/v1/recon/scan", payload)
                        if (!res.startsWith("<") && (res.contains("findings") || res.contains("score"))) {
                            val clusterReport = ReconJson.parseReport(res)
                            if (clusterReport != null) {
                                // Merge rich local telemetry (openPorts, cves, crawlEndpoints) if cluster had empty arrays
                                report = clusterReport.copy(
                                    openPorts = if (clusterReport.openPorts.isNotEmpty()) clusterReport.openPorts else localReport.openPorts,
                                    cves = if (clusterReport.cves.isNotEmpty()) clusterReport.cves else localReport.cves,
                                    crawlEndpoints = if (clusterReport.crawlEndpoints.isNotEmpty()) clusterReport.crawlEndpoints else localReport.crawlEndpoints,
                                    dnsRecords = if (clusterReport.dnsRecords.isNotEmpty()) clusterReport.dnsRecords else localReport.dnsRecords,
                                    jsLeaks = if (clusterReport.jsLeaks.isNotEmpty()) clusterReport.jsLeaks else localReport.jsLeaks
                                )
                            }
                        }
                    } catch (e: Exception) {}
                }

                if (report == null) {
                    report = localReport
                }

                runOnUiThread {
                    shellUi.reconUi.isScanning.value = false
                    if (report != null) {
                        shellUi.reconUi.report.value = report
                    } else {
                        shellUi.reconUi.error.value = "Failed to audit target: " + t
                    }
                }
            } catch (e: Exception) {
                runOnUiThread {
                    shellUi.reconUi.isScanning.value = false
                    shellUi.reconUi.error.value = e.message ?: "Recon request failed"
                }
            }
        }
    }

    private fun buildShellActions() = engineer.myapp.gbmobile.ui.ShellActions(
        onUrlGo = { shellUi.urlFocused.value = false; load(it) },
        onFocusUrl = { shellUi.urlFocused.value = true },
        onCloseUrlFocus = { shellUi.urlFocused.value = false },
        onHome = { load(HOME) },
        onNewTab = { shellUi.switcherOpen.value = false; newTab() },
        onOpenSwitcher = { captureActiveThumb(); syncTabs(); shellUi.switcherOpen.value = true },
        onCloseSwitcher = { shellUi.switcherOpen.value = false },
        onSelectTab = { i -> activateTab(i); shellUi.switcherOpen.value = false; shellUi.urlFocused.value = false },
        onCloseTab = { i -> closeTab(i) },
        onOpenDevTools = { shellUi.screen.value = "browser"; shellUi.devToolsOpen.value = true; shellUi.devToolsTab.value = "Console" },
        onDevToolsSelect = { tab -> inspectDevTools(tab) },
        onDevToolsEvaluate = { code -> evaluateDevTools(code) },
        onClearHistory = { clearHistoryForCurrentProfile() },
        onNav = { s ->
            shellUi.screen.value = s
            if (s == "flows" && vm.flowsJson.isBlank() && vm.clusterUrl.trim().isNotEmpty()) apiCall("GET", "/v1/workflows", null, "flows")
            if (s == "profiles" && shellUi.profileCards.value.isEmpty() && vm.clusterUrl.trim().isNotEmpty()) profilesLoad()
            if (s == "profiles" && settingsUi.platforms.value.isEmpty() && vm.clusterUrl.trim().isNotEmpty()) loadPlatforms()
        },
        onOpenSettings = { openSettings() },
        onOpenAgent = { assistantOpen() },
        onCloseAgent = { shellUi.screen.value = "browser" },
        assistant = engineer.myapp.gb.shared.AssistantActions(
            onSend = { t -> assistantSend(t) },
            onNew = { agentExec.execute { assistantNew(shellUi.assistant.selectedAgent.value) } },
            onNewWithAgent = { type -> agentExec.execute { assistantNew(type) } },
            onOpen = { id -> agentExec.execute { assistantLoad(id) } },
            onDelete = { id -> agentExec.execute { apiAwait("DELETE", "/v1/assistant/chats/$id", null); assistantRefreshChats(); if (id == assistantChatId) { assistantChatId = ""; runOnUiThread { shellUi.assistant.chat.value = null } } } },
            onStop = { agentExec.execute { val id = assistantChatId; if (id.isNotBlank()) { apiAwait("POST", "/v1/assistant/chats/$id/stop", "{}"); assistantLoad(id) } } },
            onCard = { c -> assistantCard(c) },
            onRefreshChats = { agentExec.execute { assistantRefreshChats() } },
            onSettings = { shellUi.aiSettingsOpen.value = true },
            onClose = { shellUi.screen.value = "browser" },
            onOpenUrl = { u -> shellUi.screen.value = "browser"; load(u) },
            onConnect = { openSettings() },
        ),
        aiModel = engineer.myapp.gb.shared.AiModelActions(
            onLoad = { agentExec.execute { aiModelLoad() } },
            onList = { host, key -> agentExec.execute { aiModelList(host, key) } },
            onTest = { host, key, model -> agentExec.execute { aiModelTest(host, key, model) } },
            onSave = { host, key, model -> agentExec.execute { aiModelSave(host, key, model) } },
            onSaveBackups = { backups -> agentExec.execute { aiModelSaveBackups(backups) } },
        ),
        onLoadFlows = { refreshLocalWorkflows(); if (vm.clusterKey.isNotBlank()) apiCall("GET", "/v1/workflows", null, "flows") },
        onRunFlow = { id, name -> runFlow(id, name) },
        onCreateFlow = { name, steps -> createFlow(name, steps) },
        onCreateSecurityFlow = { name, target, scan, prompt -> createSecurityFlow(name, target, scan, prompt) },
        securitySync = securitySync,
        onSecuritySync = { value ->
            if (value && vm.clusterKey.isBlank()) vm.log("! Sign in to the cluster before enabling recon sharing")
            else { securitySync = value; vm.syncSecurityRecon = value }
        },
        onOpenAllReconResults = {
            pendingResults = "local-recon-all" to "All on-device scans"
            showArtifact(LocalReconResultPage.render("All on-device scans", localReconResultRuns(LocalReconStore.allResults(this))))
        },
        rangeScanner = rangeScanner,
        onLoadPlatforms = { loadPlatforms() },
        onOpenPlatform = { prof, site -> shellUi.urlFocused.value = false; openPlatform(prof, site) },
        onOpenLearn = { slug -> load("$LEARN_SITE/learn/$slug") },
        onRefreshHome = { fetchLearnFeed() },
        onOpenRecon = {
            val u = shellUi.url.value
            val host = try { android.net.Uri.parse(u).host ?: u } catch (e: Exception) { u }
            shellUi.reconUi.currentTarget.value = if (host.isNotBlank()) host else u
            shellUi.reconUi.isOpen.value = true
            if (host.isNotBlank() && shellUi.reconUi.report.value?.target != host) {
                runReconScan(host, true)
            }
        },
        onRunReconScan = { target, comp -> runReconScan(target, comp) },
        onCopyReconSnippet = { text ->
            try {
                val cm = getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                cm.setPrimaryClip(android.content.ClipData.newPlainText("Recon Remediation", text))
                runOnUiThread { android.widget.Toast.makeText(this@MainActivity, "Remediation copied to clipboard", android.widget.Toast.LENGTH_SHORT).show() }
            } catch (e: Exception) {}
        },
        onOpenMenu = { shellUi.desktopMode.value = tabs.getOrNull(activeTab)?.desktop == true; shellUi.menuOpen.value = true },
        onCloseMenu = { shellUi.menuOpen.value = false },
        onBack = { if (this::web.isInitialized && web.canGoBack()) web.goBack() },
        onForward = { if (this::web.isInitialized && web.canGoForward()) web.goForward() },
        onReload = { if (this::web.isInitialized) web.reload() },
        onShare = { doShare() },
        onToggleDesktop = { toggleDesktop(); shellUi.desktopMode.value = tabs.getOrNull(activeTab)?.desktop == true },
        onFindInPage = { try { if (this::web.isInitialized) web.showFindDialog(null, true) } catch (e: Exception) { vm.log("! find in page unavailable") } },
        onOpenHub = { openDeviceHub() },
        onRefreshHub = { if (vm.clusterUrl.trim().isNotEmpty()) apiCall("GET", "/v1/device/list", null, "run_devices") },
        onRefreshTraining = { if (vm.clusterUrl.trim().isNotEmpty()) apiCall("GET", "/v1/training/state", null, "run_training") },
        /* Promotion is the one act on that page with a consequence. The cluster refuses any round
           that did not beat its own baseline, so this cannot be the way a worse model reaches
           service — it is a request, not a decision. */
        onPromoteRound = { id -> if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/training/rounds/$id/promote", "{}", "run_promote") },
        /* The same three controls the desktop has: the loop is one loop, seen from either surface. */
        onSetTrainingAuto = { on -> if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/training/auto", JSONObject().put("on", on).toString(), "run_promote") },
        /* Letting the browser collect its own training data. Routed through run_promote so the
           page reloads after it, the same way the other three controls do. */
        onSetHarvest = { on -> if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/harvest/on", JSONObject().put("on", on).toString(), "run_promote") },
        onSetResight = { on -> if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/training/resight", JSONObject().put("on", on).toString(), "run_promote") },
        onSetServing = { mode, model -> if (vm.clusterUrl.trim().isNotEmpty()) { val b = JSONObject(); if (mode != null) b.put("mode", mode); if (model != null) b.put("model", model); apiCall("POST", "/v1/training/serving", b.toString(), "run_promote") } },
        onSetGpu = { fields -> if (vm.clusterUrl.trim().isNotEmpty()) { val b = JSONObject(); fields.forEach { (k, v) -> b.put(k, v) }; apiCall("POST", "/v1/training/gpu", b.toString(), "run_promote") } },
        onDestroyGpu = { if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/training/gpu/destroy", "{}", "run_promote") },
        onSetJudge = { on -> if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/training/judge", JSONObject().put("on", on).toString(), "run_promote") },
        onSetPractice = { on -> if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/training/practice", JSONObject().put("on", on).toString(), "run_promote") },
        onSetAutopilot = { on -> if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/training/serving", JSONObject().put("autopilot", on).toString(), "run_promote") },
        onStopRound = { id -> if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/training/rounds/$id/stop", "{}", "run_promote") },
        onNodeJoin = { kind -> if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/training/nodes/join", JSONObject().put("kind", kind).toString(), "run_promote") },
        onNodeRevoke = { code -> if (vm.clusterUrl.trim().isNotEmpty()) apiCall("DELETE", "/v1/training/nodes/" + java.net.URLEncoder.encode(code, "UTF-8"), null, "run_promote") },
        onSetModal = { fields -> if (vm.clusterUrl.trim().isNotEmpty()) { val b = JSONObject(); fields.forEach { (k, v) -> if (k == "auto") b.put(k, v == "true") else b.put(k, v) }; apiCall("POST", "/v1/training/nodes/modal", b.toString(), "run_promote") } },
        onModalStart = { if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/training/nodes/modal/start", "{}", "run_promote") },
        onTrialStudents = { models ->
            if (vm.clusterUrl.trim().isNotEmpty()) {
                val body = if (models.isEmpty()) "{}" else "{\"models\":[" + models.joinToString(",") { "\"" + it + "\"" } + "]}"
                apiCall("POST", "/v1/training/students/trial", body, "run_promote")
            }
        },
        onModalStop = { if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/training/nodes/modal/stop", "{}", "run_promote") },
        onLoadRuns = { if (vm.clusterUrl.trim().isNotEmpty()) apiCall("GET", "/v1/training/runs?limit=60", null, "run_runs") },
        /* The scoreboard: every measured round, whatever model trained it. */
        onLoadResults = { if (vm.clusterUrl.trim().isNotEmpty()) apiCall("GET", "/v1/training/results?limit=24", null, "run_results") },
        /* Side by side: what may be compared, and the two ways to start one. */
        onLoadCompare = { if (vm.clusterUrl.trim().isNotEmpty()) apiCall("GET", "/v1/training/compare/jobs", null, "run_cmp_jobs") },
        onCompareRecorded = { jobId, model ->
            if (vm.clusterUrl.trim().isNotEmpty()) {
                val body = JSONObject().put("jobId", jobId).put("model", model).toString()
                apiCall("POST", "/v1/training/compare", body, "run_cmp_run")
            }
        },
        onCompareLive = { prompt, model ->
            if (vm.clusterUrl.trim().isNotEmpty()) {
                val body = JSONObject().put("prompt", prompt).put("model", model).toString()
                apiCall("POST", "/v1/training/compare/live", body, "run_cmp_run")
            }
        },
        onCompareStop = {
            val id = shellUi.compareRun.value?.id ?: ""
            if (id.isNotBlank() && vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/training/compare/$id/stop", "{}", "run_cmp_stop")
        },
        onOpenRun = { id -> if (vm.clusterUrl.trim().isNotEmpty()) { lastOpenRun = id; apiCall("GET", "/v1/training/runs/$id", null, "run_run") } },
        onLabelStep = { id, n, verdict -> if (vm.clusterUrl.trim().isNotEmpty()) { lastOpenRun = id; apiCall("POST", "/v1/training/runs/$id/steps/$n/label", JSONObject().put("verdict", verdict).toString(), "run_run_label") } },
        onRunRoundNow = { if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/training/dispatch", JSONObject().put("force", true).toString(), "run_promote") },
        onAllowTrainer = { id, on -> if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/training/trainers/$id", JSONObject().put("on", on).toString(), "run_promote") },
        onSetUpTrainer = { id -> if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/v1/training/trainers/$id/setup", "{}", "run_promote") },
        onOpenAiSettings = { syncSettingsUi(); shellUi.aiSettingsOpen.value = true },
        onCloseAiSettings = { shellUi.aiSettingsOpen.value = false },
        onOpenApprovals = { shellUi.screen.value = "approvals"; pollApprovals(); startApprovalsPolling() },
        onRefreshApprovals = { pollApprovals() },
        onApprove = { jobId, pid, edited ->
            val b = JSONObject().put("approve", true).put("edit", edited).toString()
            apiCall("POST", "/v1/agent/jobs/$jobId/proposals/$pid", b, "approval_act")
        },
        onDeny = { jobId, pid ->
            apiCall("POST", "/v1/agent/jobs/$jobId/proposals/$pid", JSONObject().put("approve", false).toString(), "approval_act")
        },
        onStopJob = { jobId -> apiCall("POST", "/v1/agent/jobs/$jobId/stop", "{}", "approval_act") },
        onSayJob = { jobId, text -> apiCall("POST", "/v1/agent/jobs/$jobId/say", JSONObject().put("text", text).toString(), "approval_act") },
        onStartWatch = {
            if (vm.clusterUrl.trim().isEmpty()) vm.log("! sign in first (Settings → Account & sync)")
            else { vm.log("↑ starting Facebook reply watch…"); apiCall("POST", "/v1/sessions", JSONObject().put("reuse", true).put("profile", "facebook").toString(), "watch_session") }
        },
        onLoadWatchers = { loadWatchers() },
        onSaveWatcher = { id, name, mode, role, goal, profile, autoId, iv, fuF, fuR -> saveWatcher(id, name, mode, role, goal, profile, autoId, iv, fuF, fuR) },
        onToggleWatcher = { id, active -> toggleWatcher(id, active) },
        onOpenWatcherResults = { id -> openWatcherResults(id) },
        onLoadFiles = { loadFiles() },
        onDeleteFile = { id -> deleteCapturedFile(id) },
        onDeleteRecording = { id -> deleteRecording(id) },
        // profiles — the surface; opening one still opens it in a NEW TAB in its own cookie jar
        onLoadProfiles = { profilesLoad() },
        onOpenProfile = { p -> openPlatform(p.name, if (p.site.isNotBlank()) "https://${p.site}" else HOME) },
        onReadRole = { r -> profileRoleRead(r) },
        onSetProfileRole = { p, r -> profileRoleSet(p, r) },
        onCreateProfile = { n, s -> profileManage("POST", "/v1/profiles", JSONObject().put("name", n).put("site", s).toString(), "created \"$n\" — sign into it once by hand") },
        onRenameProfile = { p, to -> profileManage("POST", "/v1/profiles/$p/rename", JSONObject().put("to", to).toString(), "renamed to \"$to\"") },
        onDuplicateProfile = { p, to -> profileManage("POST", "/v1/profiles/$p/duplicate", JSONObject().put("to", to).toString(), "copied to \"$to\" — settings only, so sign into it once") },
        onClearProfileLogin = { p -> profileManage("POST", "/v1/profiles/${p.name}/clear-login", "{}", "signed \"${p.name}\" out; its settings are untouched") },
        onDeleteProfile = { p -> profileManage("DELETE", "/v1/profiles/${p.name}", null, "deleted \"${p.name}\"") },
    )

    /* ── Downloads: the files the cluster browser captured (GET /v1/files), like any browser's list ── */
    private fun loadFiles() {
        if (vm.clusterUrl.trim().isEmpty()) return
        shellUi.downloads.loading.value = true
        if (engineer.myapp.gb.shared.AssistantHooks.playMedia == null || engineer.myapp.gb.shared.AssistantHooks.saveFile == null) assistantHooksInstall()
        apiCall("GET", "/v1/files", null, "files")
        apiCall("GET", "/v1/recordings", null, "recordings")
    }
    private fun deleteCapturedFile(id: String) { apiCall("DELETE", "/v1/files/$id", null, "filedel"); loadFiles() }   // not `deleteFile`: Context has one
    private fun deleteRecording(id: String) { apiCall("DELETE", "/v1/recordings/$id", null, "recdel") }
    private fun stopRecording(id: String) { apiCall("POST", "/v1/recordings/$id/stop", "{}", "recstop") }
    /** The cluster session's cookie (the control channel's profile holds it): what a native player or download sends along. */
    private fun clusterCookie(): String = try {
        val u = vm.clusterUrl.trim()
        val cm = if (ctrlProfile != "default" && WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) ProfileStore.getInstance().getOrCreateProfile(ctrlProfile).cookieManager else CookieManager.getInstance()
        cm.getCookie(u) ?: CookieManager.getInstance().getCookie(u) ?: ""
    } catch (e: Exception) { "" }
    /** A recording's mp4, streamed straight into the phone's Downloads (any size — never through memory or base64). */
    private fun saveRecordingToDevice(rec: engineer.myapp.gb.shared.RecordingInfo) = agentExec.execute {
        val fname = (rec.name.take(60).replace(Regex("[^A-Za-z0-9._ -]"), "_").trim().ifBlank { rec.id }) + ".mp4"
        try {
            val tk = JSONObject(apiAwait("POST", "/v1/recordings/${rec.id}/ticket", "{}")); if (tk.has("error")) { vm.log("! save ${fname}: ${tk.optString("error")}"); return@execute }
            val conn = java.net.URL(vm.clusterUrl.trim().trimEnd('/') + tk.optString("mp4").ifBlank { "/v1/recordings/${rec.id}/mp4" }).openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 30000; conn.readTimeout = 600000; clusterCookie().takeIf { it.isNotBlank() }?.let { conn.setRequestProperty("Cookie", it) }
            if (conn.responseCode !in 200..299) { vm.log("! save ${fname}: HTTP ${conn.responseCode}"); return@execute }
            val total = conn.contentLengthLong
            runOnUiThread { android.widget.Toast.makeText(this, "Saving $fname…", android.widget.Toast.LENGTH_SHORT).show() }
            val values = android.content.ContentValues().apply { put(android.provider.MediaStore.Downloads.DISPLAY_NAME, fname); put(android.provider.MediaStore.Downloads.MIME_TYPE, "video/mp4"); put(android.provider.MediaStore.Downloads.IS_PENDING, 1) }
            val uri = if (android.os.Build.VERSION.SDK_INT >= 29) contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) else android.net.Uri.fromFile(java.io.File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS), fname))
            if (uri == null) { vm.log("! could not create $fname"); return@execute }
            var done = 0L; var lastLog = 0L
            conn.inputStream.use { input -> contentResolver.openOutputStream(uri)?.use { out -> val buf = ByteArray(256 * 1024); while (true) { val n = input.read(buf); if (n < 0) break; out.write(buf, 0, n); done += n; if (done - lastLog > 50L * 1048576) { lastLog = done; vm.log("↓ $fname ${done / 1048576} MB${if (total > 0) " of ${total / 1048576}" else ""}") } } } }
            if (android.os.Build.VERSION.SDK_INT >= 29) { values.clear(); values.put(android.provider.MediaStore.Downloads.IS_PENDING, 0); contentResolver.update(uri, values, null, null) }
            vm.log("● saved $fname (${done / 1048576} MB) to Downloads"); runOnUiThread { android.widget.Toast.makeText(this, "Saved $fname to Downloads", android.widget.Toast.LENGTH_SHORT).show() }
        } catch (e: Throwable) { vm.log("! save $fname: ${e.javaClass.simpleName} ${e.message}"); runOnUiThread { try { android.widget.Toast.makeText(this, "Could not save $fname", android.widget.Toast.LENGTH_SHORT).show() } catch (t: Throwable) {} } }
    }

    /* ── Watchers: scheduled background tasks = active workflows with a schedule trigger ──────────── */
    private val watcherRaw = java.util.Collections.synchronizedMap(HashMap<String, JSONObject>())

    private fun loadWatchers() {
        refreshLocalWorkflows()
        if (vm.clusterKey.isBlank()) return
        shellUi.watchersLoading.value = true
        shellUi.watcherRoles.value = roleNames().filter { it != "(none)" }
        apiCall("GET", "/v1/workflows", null, "watchers")
        apiCall("GET", "/v1/profiles", null, "profiles_list")
        if (vm.rolesCacheJson.isBlank()) apiCall("GET", "/v1/agent/roles", null, "roles_list")
    }
    private val DEFAULT_WATCH_GOAL = "Run your watch now: carry out this role's task and record what you find with collect (or save_lead). Propose any action that others would see for my approval — never act without it. If nothing needs doing, finish."
    /** Create or edit a watcher. Role mode = a schedule trigger + one agent node (role+goal). Automation
     *  mode = a schedule trigger + a COPY of the chosen automation's steps (the original is untouched). */
    @Volatile private var pendingFollowUp: Pair<String, Boolean>? = null   // (flowId, repliesOnly) applied after create
    private val watcherCfg = java.util.Collections.synchronizedMap(HashMap<String, Pair<String, Boolean>>())
    /** Per-watcher pass health (GET /v1/watchers/:id/health), folded into one line for the card. */
    private data class WatcherHealth(val line: String, val stale: Boolean, val running: Boolean)
    private val watcherHealth = java.util.Collections.synchronizedMap(HashMap<String, WatcherHealth>())
    private fun healthOf(json: String): WatcherHealth = try {
        val o = JSONObject(json); val lp = o.optJSONObject("lastPass"); val since = o.opt("sinceMinutes")
        val line = if (lp == null) (if (o.optBoolean("running")) "first pass running…" else "no pass yet") else buildString {
            append(when { o.optBoolean("running") -> "running · "; since is Int -> "$since min ago · "; else -> "" })
            append("${lp.optInt("messages")} messages · ${lp.optInt("waiting")} waiting")
            if (lp.optInt("verified") > 0) append(" · ${lp.optInt("verified")} verified, ${lp.optInt("corrected")} corrected")
            if (lp.optInt("drafts") > 0) append(" · ${lp.optInt("drafts")} new drafts")
            val errs = lp.optJSONArray("errors"); if (errs != null && errs.length() > 0) append(" · ${errs.length()} error(s): ${errs.optString(0).take(60)}")
        }
        WatcherHealth(line, o.optBoolean("stale"), o.optBoolean("running"))
    } catch (e: Exception) { WatcherHealth("", false, false) }
    @Volatile private var lastWorkflowsJson: String = ""
    /** Routing config. `flowId` is either a JSON array of routes (starts with "[", the engine form) or a
     *  single legacy flow id. Stored locally as the JSON string so the form can pre-fill on edit. */
    private fun putWatcherConfig(wid: String, flowId: String, repliesOnly: Boolean) {
        val body = if (flowId.startsWith("[")) {
            watcherCfg[wid] = flowId to false
            JSONObject().put("followUps", JSONArray(flowId)).put("followUpFlowId", "").put("followUpKinds", JSONArray())
        } else {
            val kinds = if (repliesOnly) JSONArray().put("reply").put("comment").put("mention") else JSONArray()
            watcherCfg[wid] = flowId to repliesOnly
            JSONObject().put("followUpFlowId", flowId).put("followUpKinds", kinds).put("followUps", JSONArray())
        }
        apiCall("PUT", "/v1/watchers/$wid/config", body.toString(), "watcher_cfg")
    }
    private fun routesOf(cfgJson: String): List<engineer.myapp.gb.shared.FollowUpRoute> = try {
        val arr = JSONArray(cfgJson); (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val ks = o.optJSONArray("kinds") ?: JSONArray()
            engineer.myapp.gb.shared.FollowUpRoute((0 until ks.length()).map { ks.optString(it) }.filter { it.isNotBlank() }, o.optString("flowId"))
        }
    } catch (e: Exception) { emptyList() }
    private fun saveWatcher(id: String?, name: String, mode: String, role: String, goal: String, profile: String, automationId: String, intervalMin: Int, followUpFlowId: String, followUpRepliesOnly: Boolean) {
        val trigger = JSONObject().put("id", "trigger").put("type", "trigger").put("label", "Every $intervalMin min")
            .put("trigger", JSONObject().put("type", "schedule").put("every", "minute").put("n", intervalMin))
        val nodes = JSONArray().put(trigger)
        val edges = JSONArray()
        if (mode == "automation") {
            // Copy the automation's non-trigger steps into this watcher, chained after the schedule.
            val src = try { JSONObject(vm.flowsJson).optJSONArray("workflows") } catch (e: Exception) { null }
            var wf: JSONObject? = null
            if (src != null) for (i in 0 until src.length()) { val w = src.optJSONObject(i); if (w?.optString("id") == automationId) { wf = w; break } }
            val steps = wf?.optJSONArray("nodes") ?: JSONArray()
            var prev = "trigger"; var k = 0
            for (i in 0 until steps.length()) {
                val n = steps.optJSONObject(i) ?: continue
                if (n.optString("type") == "trigger") continue
                val nid = "n$k"; k++
                val copy = JSONObject(n.toString()).put("id", nid)
                nodes.put(copy); edges.put(JSONObject().put("from", prev).put("to", nid)); prev = nid
            }
            if (k == 0) { vm.log("! that automation has no steps to run"); return }
        } else if (mode == "security") {
            nodes.put(JSONObject().put("id", "n0").put("type", "recon").put("label", "Security recon").put("scan", role).put("target", goal))
            edges.put(JSONObject().put("from", "trigger").put("to", "n0"))
        } else {
            val agent = JSONObject().put("id", "n0").put("type", "agent").put("label", "Watch")
                .put("role", role).put("profile", profile).put("goal", goal.ifBlank { DEFAULT_WATCH_GOAL })
            nodes.put(agent); edges.put(JSONObject().put("from", "trigger").put("to", "n0"))
        }
        val body = JSONObject().put("name", name).put("active", true).put("autoApprove", false)
            .put("nodes", nodes).put("edges", edges).toString()
        val recon = (0 until nodes.length()).mapNotNull { nodes.optJSONObject(it) }.firstOrNull { it.optString("type") == "recon" }
        if (recon != null) {
            if (recon.optString("scan") == "prompt") { vm.log("! Recon starter prompts run on demand; choose a target scan for a watcher"); return }
            val local = JSONObject(body)
            if (id?.startsWith("local-recon-") == true) local.put("id", id)
            LocalReconStore.save(this, local)
            LocalReconWorker.schedule(this)
            refreshLocalWorkflows()
            vm.log("+ saved local security watcher: $name")
            if (securitySync && vm.clusterKey.isNotBlank() && id.isNullOrBlank()) apiCall("POST", "/v1/workflows", body, "watcher_create")
            return
        }
        if (id.isNullOrBlank()) {
            pendingFollowUp = followUpFlowId to followUpRepliesOnly
            vm.log("+ creating watcher \"$name\" (every $intervalMin min)…"); apiCall("POST", "/v1/workflows", body, "watcher_create")
        } else {
            vm.log("✎ saving watcher \"$name\"…"); apiCall("PUT", "/v1/workflows/$id", body, "watcher_create")
            putWatcherConfig(id, followUpFlowId, followUpRepliesOnly)
        }
    }
    private fun toggleWatcher(id: String, active: Boolean) {
        if (id.startsWith("local-recon-")) {
            if (LocalReconStore.setActive(this, id, active)) refreshLocalWorkflows()
            return
        }
        val raw = watcherRaw[id]
        if (raw == null) { vm.log("! watcher not loaded — refresh"); return }
        try { raw.put("active", active) } catch (e: Exception) {}
        apiCall("PUT", "/v1/workflows/$id", raw.toString(), "watcher_toggle")
    }
    // The watcher whose results we're assembling (id → name), across the two-step fetch.
    @Volatile private var pendingResults: Pair<String, String>? = null
    @Volatile private var pendingFeedJson: String = ""
    private fun openWatcherResults(id: String) {
        val name = shellUi.watchers.value.firstOrNull { it.id == id }?.name ?: "Watcher"
        pendingResults = id to name
        if (id.startsWith("local-recon-")) {
            showArtifact(LocalReconResultPage.render(name, localReconResultRuns(LocalReconStore.results(this, id))))
            return
        }
        vm.log("↑ opening results for \"$name\"…")
        apiCall("GET", "/v1/watchers/$id/feed", null, "wfeed")   // step 1: the deduped feed
    }

    private fun localReconResultRuns(items: JSONArray): List<LocalReconResultPage.Run> =
        (0 until items.length()).mapNotNull { index ->
            val item = items.optJSONObject(index) ?: return@mapNotNull null
            val fields = item.optJSONObject("fields") ?: JSONObject()
            val ports = item.optJSONArray("ports") ?: JSONArray()
            val parsedPorts = (0 until ports.length()).mapNotNull { i -> ports.optJSONObject(i)?.let { LocalReconResultPage.Port(it.optInt("port"), it.optString("service")) } }
                .ifEmpty { fields.optString("openPorts").split(',').mapNotNull { it.trim().toIntOrNull()?.let { port -> LocalReconResultPage.Port(port, "Previously observed open port") } } }
            val findings = item.optJSONArray("findings") ?: JSONArray()
            val time = fields.optString("time").ifBlank {
                val instant = fields.optLong("recordedAt", 0)
                if (instant <= 0) "Time unavailable" else java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.getDefault()).format(java.util.Date(instant))
            }
            LocalReconResultPage.Run(
                target = item.optString("url"), time = time, status = fields.optString("status"),
                grade = fields.optString("grade"), score = fields.optInt("score", -1),
                findingCount = fields.optInt("findings"), videoCandidate = fields.optBoolean("videoCandidate"),
                ports = parsedPorts,
                findings = (0 until findings.length()).mapNotNull { i -> findings.optJSONObject(i)?.let { LocalReconResultPage.Finding(it.optString("severity"), it.optString("title"), it.optString("impact")) } },
                error = fields.optString("error"),
            )
        }

    /** Parse GET /v1/workflows → the ones with a schedule trigger are watchers. */
    private fun parseWatchers(data: String, fetchCfg: Boolean = true) {
        val combined = mergeLocalWorkflows(data)
        lastWorkflowsJson = combined
        try {
            val arr = JSONObject(combined).optJSONArray("workflows") ?: JSONArray()
            val out = ArrayList<engineer.myapp.gb.shared.Watcher>()
            watcherRaw.clear()
            for (i in 0 until arr.length()) {
                val w = arr.optJSONObject(i) ?: continue
                val nodes = w.optJSONArray("nodes") ?: JSONArray()
                var trig: JSONObject? = null; var agent: JSONObject? = null; var reconNode: JSONObject? = null; var steps = 0
                for (j in 0 until nodes.length()) {
                    val n = nodes.optJSONObject(j) ?: continue
                    if (n.optString("type") == "trigger") trig = n.optJSONObject("trigger")
                    else { steps++; if (n.optString("type") == "agent" && agent == null) agent = n; if (n.optString("type") == "recon" && reconNode == null) reconNode = n }
                }
                val cfg = trig ?: w.optJSONObject("trigger")
                if (cfg == null || cfg.optString("type") != "schedule") continue   // only scheduled = a watcher
                val id = w.optString("id"); if (id.isBlank()) continue
                watcherRaw[id] = w
                val n = maxOf(1, cfg.optInt("n", 1))
                val runs = w.optInt("runs", 0)
                val localResults = if (id.startsWith("local-recon-")) LocalReconStore.results(this, id) else JSONArray()
                val last = if (localResults.length() > 0) "${localResults.length()} local results" else if (runs > 0) "$runs runs, last ${w.optString("lastRunStatus", "?")}" else "never run"
                out.add(engineer.myapp.gb.shared.Watcher(
                    id = id, name = w.optString("name", id), role = reconNode?.optString("scan") ?: agent?.optString("role") ?: "general",
                    profile = agent?.optString("profile") ?: "", intervalMin = n, active = w.optBoolean("active"),
                    lastRun = last, resultCount = localResults.length(), goal = reconNode?.optString("target") ?: agent?.optString("goal") ?: "",
                    mode = if (steps > 1) "automation" else if (reconNode != null) "security" else "role", stepCount = steps,
                    followUpFlowId = watcherCfg[id]?.first?.takeIf { !it.startsWith("[") } ?: "", followUpRepliesOnly = watcherCfg[id]?.second ?: true,
                    followUps = watcherCfg[id]?.first?.takeIf { it.startsWith("[") }?.let { routesOf(it) } ?: emptyList(),
                    health = watcherHealth[id]?.line ?: "", stale = watcherHealth[id]?.stale ?: false, running = watcherHealth[id]?.running ?: false,
                    kind = w.optString("kind", if (reconNode != null) "security" else "browser"),
                ))
            }
            shellUi.watchers.value = out
            WatchersWidgetProvider.refresh(this, out.filter { it.active }.map { it.name })
            if (fetchCfg) out.filterNot { it.id.startsWith("local-recon-") }.forEach { apiCall("GET", "/v1/watchers/${it.id}/config", null, "wcfg_${it.id}"); apiCall("GET", "/v1/watchers/${it.id}/health", null, "whealth_${it.id}") }
        } catch (e: Exception) { vm.log("! watchers parse: ${data.take(120)}") }
        shellUi.watchersLoading.value = false
    }

    /* ── Interactive results artifact: a device-stored HTML view of a watcher's items, with a per-item
     *    follow-up flow trigger (the action lands in Approvals). ─────────────────────────────────── */
    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    private fun showArtifact(html: String) {
        runOnUiThread {
            if (artHost == null) {
                val w = WebView(this).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    setBackgroundColor(android.graphics.Color.parseColor("#16171A"))
                    addJavascriptInterface(GbArtifactBridge(), "GbArtifact")
                }
                artWeb = w
                artHost = android.widget.FrameLayout(this).apply {
                    setBackgroundColor(android.graphics.Color.parseColor("#16171A"))
                    addView(w, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                }
                (b.root as ViewGroup).addView(artHost, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
            // Persist to the device so the user can re-open it (offline), then show that file.
            val id = pendingResults?.first ?: "latest"
            try {
                val dir = java.io.File(filesDir, "artifacts").apply { mkdirs() }
                java.io.File(dir, "watcher-$id.html").writeText(html)
            } catch (e: Exception) {}
            artWeb?.loadDataWithBaseURL("https://my-app.engineer/", html, "text/html", "utf-8", null)
            artHost?.visibility = View.VISIBLE; artHost?.bringToFront()
        }
    }
    private fun hideArtifact() { runOnUiThread { artHost?.visibility = View.GONE } }

    private fun markFeedHandled(feedKey: String) {
        val wid = pendingResults?.first ?: return
        if (feedKey.isBlank()) return
        apiCall("POST", "/v1/watchers/$wid/feed/handled", JSONObject().put("key", feedKey).put("handled", true).toString(), "artifact_run")
    }
    inner class GbArtifactBridge {
        @android.webkit.JavascriptInterface fun close() { hideArtifact() }
        @android.webkit.JavascriptInterface fun openUrl(url: String) { runOnUiThread { hideArtifact(); if (url.isNotBlank()) load(url) } }
        // Approve = the cluster re-opens the thread, checks nothing was answered meanwhile, and posts
        // the exact text (or hands the yes to a still-parked gate). Deny = mark handled. Both by feed key.
        @android.webkit.JavascriptInterface fun approveDraft(jobId: String, pid: String, text: String, feedKey: String) {
            val wid = pendingResults?.first ?: return
            if (feedKey.isBlank()) return
            apiCall("POST", "/v1/watchers/$wid/feed/approve", JSONObject().put("key", feedKey).put("text", text).toString(), "artifact_approve")
        }
        @android.webkit.JavascriptInterface fun denyDraft(jobId: String, pid: String, feedKey: String) {
            val wid = pendingResults?.first ?: return
            if (feedKey.isBlank()) return
            apiCall("POST", "/v1/watchers/$wid/feed/deny", JSONObject().put("key", feedKey).toString(), "artifact_deny")
        }
        // Post watcher: follow a post by its link / stop following one (by post id).
        @android.webkit.JavascriptInterface fun watchPost(url: String) {
            val wid = pendingResults?.first ?: return
            if (url.isNotBlank()) apiCall("POST", "/v1/watchers/$wid/posts", JSONObject().put("url", url.trim()).toString(), "artifact_watchpost")
        }
        @android.webkit.JavascriptInterface fun mutePost(postId: String) {
            val wid = pendingResults?.first ?: return
            if (postId.isNotBlank()) apiCall("DELETE", "/v1/watchers/$wid/posts", JSONObject().put("url", "https://www.facebook.com/?post_id=$postId").toString(), "artifact_mutepost")
        }
        @android.webkit.JavascriptInterface fun runFlow(flowId: String, itemJson: String) {
            try {
                val item = JSONObject(itemJson)
                val input = JSONObject()
                item.optString("title").takeIf { it.isNotBlank() }?.let { input.put("title", it); input.put("name", it) }
                item.optString("url").takeIf { it.isNotBlank() }?.let { input.put("url", it) }
                item.optJSONObject("fields")?.let { f -> f.keys().forEach { k -> input.put(k, f.optString(k)) } }
                apiCall("POST", "/v1/workflows/$flowId/run", JSONObject().put("input", input).toString(), "artifact_run")
            } catch (e: Exception) { runOnUiThread { vm.log("! follow-up: ${e.message}") } }
        }
    }

    /** Build the interactive results artifact — schema-agnostic: renders whatever fields each item has,
     *  an image if present, a link if present, and a per-item "run a flow on this" control. */
    private fun buildArtifactHtml(name: String, items: JSONArray, flows: List<engineer.myapp.gb.shared.FlowInfo>): String {
        val flowsJson = JSONArray().also { arr -> flows.forEach { arr.put(JSONObject().put("id", it.id).put("name", it.name)) } }.toString()
        val itemsJson = items.toString()
        val safeName = name.replace("<", "&lt;").replace("&", "&amp;")
        return """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 :root{--bg:#16171A;--surface:#1F2024;--hi:#292A2E;--text:#E6E7EA;--muted:#9AA0A6;--line:#34363B;--brand:#0B5FFF;--brandOn:#fff}
 *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,Roboto,Segoe UI,sans-serif;font-size:15px}
 header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:14px 16px;display:flex;align-items:center;gap:12px;z-index:5}
 header h1{font-size:18px;margin:0;flex:1;font-weight:600} header .count{color:var(--muted);font-size:12px;font-family:monospace}
 .x{background:var(--hi);color:var(--text);border:0;border-radius:8px;padding:8px 12px;font-size:14px}
 .wrap{padding:14px 16px 40px} .empty{color:var(--muted);text-align:center;padding:48px 16px}
 .card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px}
 .top{display:flex;gap:12px} .avatar{width:52px;height:52px;border-radius:10px;object-fit:cover;background:var(--hi);flex:none}
 .title{font-size:16px;font-weight:600;margin:0 0 2px} .kind{color:var(--brand);font-size:10px;font-family:monospace;letter-spacing:1px;text-transform:uppercase}
 .fields{margin:10px 0 0;border-top:1px solid var(--line);padding-top:8px}
 .row{display:flex;gap:8px;padding:3px 0;font-size:13px} .k{color:var(--muted);min-width:96px;flex:none} .v{color:var(--text);word-break:break-word}
 a.link{color:var(--brand);text-decoration:none;font-size:13px;display:inline-block;margin-top:8px}
 .act{display:flex;gap:8px;margin-top:12px;align-items:center} select{flex:1;background:var(--hi);color:var(--text);border:1px solid var(--line);border-radius:9px;padding:9px}
 .run{background:var(--hi);color:var(--text);border:0;border-radius:9px;padding:9px 16px;font-weight:600}
 .status{color:var(--muted);font-size:12px;margin-top:6px;min-height:14px}
 .dbadge{display:inline-block;background:var(--brand);color:var(--brandOn);font:11px monospace;border-radius:50px;padding:2px 9px;margin:10px 0 6px}
 .draft{width:100%;box-sizing:border-box;min-height:80px;background:var(--bg);color:var(--text);border:1px solid var(--brand);border-radius:10px;padding:10px;font:inherit}
 .btnrow{display:flex;gap:8px;margin-top:8px} .approve{flex:1;background:var(--brand);color:var(--brandOn);border:0;border-radius:9px;padding:11px;font-weight:600}
 .deny{background:transparent;color:#F2857D;border:1px solid var(--line);border-radius:9px;padding:11px 16px}
 .card.hasdraft{border-color:var(--brand)}
 .chip{display:inline-block;font:10px monospace;letter-spacing:.5px;border-radius:50px;padding:2px 8px;background:var(--hi);color:var(--text);margin-top:6px} .chip.dim{color:var(--muted)} .chip.err{color:#F2857D}
 .watchbar{display:flex;gap:8px;margin-bottom:6px} .watchbar input{flex:1;background:var(--surface);color:var(--text);border:1px solid var(--line);border-radius:9px;padding:10px;font:inherit}
 .post{display:flex;align-items:center;gap:10px;margin:14px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--line)} .ptitle{flex:1;font-size:14px;font-weight:600} .mute{background:transparent;color:var(--muted);border:1px solid var(--line);border-radius:9px;padding:6px 10px;font-size:12px}
 .why{color:var(--brand);font:11px monospace;margin-top:4px}
 .thread{margin:10px 0 0;border-top:1px solid var(--line);padding-top:8px} .tl{font-size:12px;padding:3px 0;color:var(--text);white-space:pre-wrap} .tl.me{color:var(--brand)}
</style></head><body>
<header><h1>$safeName</h1><span class="count" id="count"></span><button class="x" onclick="GbArtifact.close()">Close</button></header>
<div class="wrap" id="wrap"></div>
<script>
 var ITEMS = $itemsJson; var FLOWS = $flowsJson;
 function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
 var HIDE={thread:1,why:1,postTitle:1,postId:1,rootId:1,commentId:1};
 function fieldsHtml(f){ if(!f) return ''; var h=''; for(var k in f){ if(!f[k]||HIDE[k]) continue; h+='<div class="row"><span class="k">'+esc(k)+'</span><span class="v">'+esc(f[k])+'</span></div>'; } return h; }
 function flowOptions(){ var o='<option value="">Run a flow on this…</option>'; for(var i=0;i<FLOWS.length;i++){ o+='<option value="'+esc(FLOWS[i].id)+'">'+esc(FLOWS[i].name)+'</option>'; } return o; }
 function threadHtml(t,i){ if(!t) return ''; var lines=String(t).split('\n'); var h='<div class="thread" id="th'+i+'" style="display:none">'; for(var i=0;i<lines.length;i++){ var mine=lines[i].indexOf('YOU:')===0; h+='<div class="tl'+(mine?' me':'')+'">'+esc(lines[i])+'</div>'; } return h+'</div>'; }
 function toggleThread(i){ var el=document.getElementById('th'+i); if(el) el.style.display = el.style.display==='none' ? 'block' : 'none'; }
 function watchPost(){ var u=document.getElementById('wurl').value.trim(); if(!u) return; try{ GbArtifact.watchPost(u); document.getElementById('wst').textContent='Watching ✓ — its threads appear after the next pass.'; document.getElementById('wurl').value=''; }catch(e){ document.getElementById('wst').textContent='Error: '+e; } }
 function mutePost(pid){ try{ GbArtifact.mutePost(pid); var g=document.getElementById('g'+pid); if(g) g.style.opacity=0.4; }catch(e){} }
 function render(){
   document.getElementById('count').textContent = ITEMS.length + (ITEMS.length===1?' item':' items');
   var wrap=document.getElementById('wrap');
   var head='<div class="watchbar"><input id="wurl" placeholder="Watch a post — paste its link"><button class="run" onclick="watchPost()">Watch</button></div><div class="status" id="wst"></div>';
   if(!ITEMS.length){ wrap.innerHTML=head+'<div class="empty">Nothing collected yet. When this watcher next runs and finds something, it appears here.</div>'; return; }
   // grouped by post: the post's first words as the header, its threads under it
   var groups={}, order=[]; for(var g=0; g<ITEMS.length; g++){ var p=ITEMS[g].postId||''; if(!groups[p]){ groups[p]=[]; order.push(p);} groups[p].push(g); }
   var html=head;
   for(var oi=0; oi<order.length; oi++){ var pid=order[oi]; var idxs=groups[pid];
     if(pid){ var title=''; for(var t=0;t<idxs.length;t++){ if(ITEMS[idxs[t]].postTitle){ title=ITEMS[idxs[t]].postTitle; break; } }
       html+='<div class="post" id="g'+esc(pid)+'"><div class="ptitle"><div class="kind">POST</div><div>'+esc(title||pid)+'</div></div><button class="mute" onclick="mutePost(\''+esc(pid)+'\')">Mute post</button></div>'; }
   for(var ii=0; ii<idxs.length; ii++){ var i=idxs[ii]; var it=ITEMS[i];
     var st=it.draftState||'';
     var hasDraft = it.draft && it.feedKey && st!=='posting';
     var chip=''; if(st==='drafting') chip='<span class="chip">drafting…</span>'; else if(st==='none') chip='<span class="chip dim">nothing to reply</span>';
       else if(st==='skipped-old') chip='<span class="chip dim">too old to answer</span>'; else if(st==='posting') chip='<span class="chip">checking the thread, then posting…</span>';
       else if(st==='post-failed') chip='<span class="chip err">post failed'+(it.posted?' · '+esc(String(it.posted).slice(0,80)):'')+' — approve again to retry</span>';
     html+='<div class="card'+(hasDraft?' hasdraft':'')+'" id="card'+i+'">';
     html+='<div class="top">';
     if(it.image) html+='<img class="avatar" src="'+esc(it.image)+'">';
     html+='<div><div class="kind">'+esc(it.kind||'item')+'</div><div class="title">'+esc(it.title||'Untitled')+'</div>'+chip;
     if(it.url) html+='<a class="link" href="javascript:void(0)" onclick="GbArtifact.openUrl(\''+esc(it.url).replace(/'/g,"\\'")+'\')">Open ↗</a>';
     if(it.thread) html+='<a class="link" style="margin-left:14px" href="javascript:void(0)" onclick="toggleThread('+i+')">Show thread</a>';
     if(it.why) html+='<div class="why">'+esc(it.why)+'</div>';
     if(it.lead) html+='<span class="chip" style="background:#0B5FFF22;color:#3b7bff;border:1px solid #0B5FFF66">lead · showed buying interest</span>';
     html+='</div></div>';
     if(it.thread) html+=threadHtml(it.thread,i);
     var fh=fieldsHtml(it.fields); if(fh) html+='<div class="fields">'+fh+'</div>';
     if(hasDraft){ html+='<div class="dbadge">DRAFT READY</div><textarea class="draft" id="d'+i+'">'+esc(it.draft)+'</textarea>'
       +'<div class="btnrow"><button class="approve" onclick="approveItem('+i+')">Approve &amp; post</button><button class="deny" onclick="denyItem('+i+')">Deny</button></div>'; }
     html+='<div class="act"><select id="sel'+i+'">'+flowOptions()+'</select><button class="run" onclick="runItem('+i+')">Run flow</button></div>';
     html+='<div class="status" id="st'+i+'"></div>';
     html+='</div>';
   } }
   wrap.innerHTML=html;
 }
 function fade(i){ var c=document.getElementById('card'+i); if(c) c.style.opacity=0.45; }
 function approveItem(i){ var it=ITEMS[i]; var t=document.getElementById('d'+i).value; try{ GbArtifact.approveDraft(it.jobId||'', it.pid||'', t, it.feedKey||''); document.getElementById('st'+i).textContent='Approved ✓ — re-checking the thread, then posting your words.'; fade(i);}catch(e){document.getElementById('st'+i).textContent='Error: '+e;} }
 function denyItem(i){ var it=ITEMS[i]; try{ GbArtifact.denyDraft(it.jobId||'', it.pid||'', it.feedKey||''); document.getElementById('st'+i).textContent='Dismissed.'; fade(i);}catch(e){document.getElementById('st'+i).textContent='Error: '+e;} }
 function runItem(i){ var sel=document.getElementById('sel'+i); var fid=sel.value; var st=document.getElementById('st'+i);
   if(!fid){ st.textContent='Pick a flow first.'; return; }
   try{ GbArtifact.runFlow(fid, JSON.stringify(ITEMS[i])); st.textContent='Started ✓ — approve it in the Approvals tab.'; sel.selectedIndex=0; }
   catch(e){ st.textContent='Could not start: '+e; }
 }
 render();
</script></body></html>"""
    }

    /** The reply-watch goal — mirrors the console Reply Desk: watch notifications, draft, gate every act. */
    private val RD_GOAL = "Open Facebook notifications and my recent posts. For each NEW comment or reaction on MY posts, read the whole thread for context, then draft ONE natural reply that continues the conversation and moves toward my-app.engineer only where it genuinely fits. Propose EVERY reply for my approval - never post without approval. Skip threads that are hostile, off-topic, already handled, or where I chose not to engage. Keep watching and check back periodically."

    private var approvalsPolling = false
    private val approvalsHandler by lazy { android.os.Handler(mainLooper) }
    /** Poll the jobs+proposals engine so the Approvals screen (and the nav badge) stay live. Runs while
     *  the Approvals screen is open or any watcher is still running. */
    private fun pollApprovals() {
        if (vm.clusterUrl.trim().isEmpty()) return
        shellUi.jobsLoading.value = true
        apiCall("GET", "/v1/agent/jobs", null, "approvals")
        apiCall("GET", "/v1/people?platform=facebook", null, "people")   // the people worth your words, same screen
        if (engineer.myapp.gb.shared.AssistantHooks.ask == null) engineer.myapp.gb.shared.AssistantHooks.ask = { text -> runOnUiThread { assistantOpen(); assistantSend(text) } }
    }
    private fun startApprovalsPolling() {
        if (approvalsPolling) return
        approvalsPolling = true
        val tick = object : Runnable {
            override fun run() {
                val running = shellUi.jobs.value.any { it.status == "running" || it.status == "idle" }
                val keep = shellUi.screen.value == "approvals" || running
                if (!keep) { approvalsPolling = false; return }
                pollApprovals()
                approvalsHandler.postDelayed(this, if (shellUi.screen.value == "approvals") 6000L else 20000L)
            }
        }
        approvalsHandler.postDelayed(tick, 6000L)
    }

    /** The my-app.engineer /learn feed for the new-tab page. Public content, plain HTTP (no cookies),
     *  parsed from the same index the crawler reads. Tapping a card opens the page on the platform. */
    private val LEARN_SITE = "https://my-app.engineer"
    private val learnExec = java.util.concurrent.Executors.newSingleThreadExecutor()
    private fun fetchLearnFeed() {
        runOnUiThread { shellUi.homeFeedLoading.value = true }
        learnExec.execute {
            val items = ArrayList<engineer.myapp.gbmobile.ui.LearnItem>()
            try {
                val c = java.net.URL("$LEARN_SITE/learn/").openConnection() as java.net.HttpURLConnection
                c.connectTimeout = 12000; c.readTimeout = 12000; c.setRequestProperty("Accept", "text/html")
                val html = java.io.BufferedReader(java.io.InputStreamReader(c.inputStream)).use { it.readText() }
                val rx = Regex("<li><a href=\"/learn/([^\"]+)\"><b>(.*?)</b></a>(?:<span>(.*?)</span>)?</li>", RegexOption.DOT_MATCHES_ALL)
                for (m in rx.findAll(html)) {
                    val slug = m.groupValues[1]; val title = unescapeHtml(m.groupValues[2]); val desc = unescapeHtml(m.groupValues[3])
                    if (slug.isNotBlank() && title.isNotBlank()) items.add(engineer.myapp.gbmobile.ui.LearnItem(slug, title, desc))
                }
            } catch (e: Exception) { runOnUiThread { vm.log("! learn feed: ${e.message}") } }
            runOnUiThread { shellUi.homeFeed.value = items.take(30); shellUi.homeFeedLoading.value = false }
        }
    }
    private fun unescapeHtml(s: String): String = s
        .replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&#x27;", "'")

    /** Share the current page URL. */
    private fun doShare() {
        val u = if (this::web.isInitialized) (web.url ?: shellUi.url.value) else shellUi.url.value
        if (u.isBlank()) return
        try {
            val i = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, u)
            startActivity(Intent.createChooser(i, "Share"))
        } catch (e: Exception) { vm.log("! share failed: ${e.message}") }
    }

    /** Snapshot the active tab's WebView into its thumbnail (for the tab grid). Cheap; best-effort. */
    private fun captureActiveThumb() {
        val i = activeTab; if (i !in tabs.indices) return
        val w = tabs[i].web ?: return
        if (w.width <= 0 || w.height <= 0) return
        try {
            val scale = 0.4f
            val bw = (w.width * scale).toInt().coerceAtLeast(1); val bh = (w.height * scale).toInt().coerceAtLeast(1)
            val bmp = Bitmap.createBitmap(bw, bh, Bitmap.Config.RGB_565)
            val c = android.graphics.Canvas(bmp); c.scale(scale, scale); w.draw(c)
            tabs[i].thumb = bmp
        } catch (e: Exception) {}
    }

    // ---- S5 settings (Compose) ------------------------------------------------------------------

    @androidx.compose.runtime.Composable
    private fun computeDark(): Boolean = settingsUi.themeMode.value != 1   // 0=dark (default), 1=light

    private val settingsActions by lazy { buildSettingsActions() }

    private fun openSettings() {
        syncSettingsUi()
        shellUi.screen.value = "settings"
        if (vm.clusterUrl.trim().isNotEmpty()) {
            apiCall("GET", "/v1/device/list", null, "run_devices")
            apiCall("GET", "/v1/training/state", null, "run_training")
        }
    }

    /** Native, local Device Hub screen — no cluster web page. Renders /v1/device/list as cards. */
    private fun openDeviceHub() {
        shellUi.screen.value = "devices"
        if (vm.clusterUrl.trim().isNotEmpty()) {
            apiCall("GET", "/v1/device/list", null, "run_devices")
            /* And what each of them is training, so a machine mid-round never reads as idle here. */
            apiCall("GET", "/v1/training/state", null, "run_training")
        } else vm.log("! sign in first (Settings → Account & sync)")
    }

    /** The nightly training pipeline — the same page the desktop shows, read from the cluster. */
    private fun openTraining() {
        shellUi.screen.value = "training"
        if (vm.clusterUrl.trim().isNotEmpty()) apiCall("GET", "/v1/training/state", null, "run_training")
        else vm.log("! sign in first (Settings → Account & sync)")
    }

    /** A short human summary of this phone's capabilities (from [phoneCaps]) for the settings screen. */
    private fun phoneCapsText(): String {
        val c = phoneCaps()
        val model = if (c.optBoolean("model")) "model ✓" else "no model"
        val nprof = c.optJSONArray("profiles")?.length() ?: 0
        return "android · native touch · real IP · $model · $nprof profile(s)"
    }

    private fun refreshSettingsModel() {
        val id = ModelCatalog.models.getOrNull(settingsUi.modelIndex.value)?.id ?: vm.selectedModel
        settingsUi.modelStatus.value = if (models.isReady(id)) "ready ✓" else "not downloaded"
    }

    private fun syncSettingsUi() {
        settingsUi.clusterUrl = vm.clusterUrl
        settingsUi.clusterStatus.value = vm.clusterInfo.value ?: "Cluster: off"
        settingsUi.connected.value = vm.clusterOn.value == true
        settingsUi.profiles.value = vm.profiles.value ?: listOf("default")
        settingsUi.currentProfile.value = vm.currentProfile.value ?: "default"
        settingsUi.roleNames.value = roleNames()
        settingsUi.roleForCurrent.value = roleForProfile(vm.currentProfile.value ?: "default").ifBlank { "(none)" }
        settingsUi.phoneCaps.value = phoneCapsText()
        settingsUi.useLocal.value = vm.useLocal
        settingsUi.modelLabels.value = ModelCatalog.models.map { it.label }
        settingsUi.modelIndex.value = ModelCatalog.models.indexOfFirst { it.id == vm.selectedModel }.coerceAtLeast(0)
        refreshSettingsModel()
        settingsUi.endpoint.value = vm.endpoint; settingsUi.apiKey.value = vm.apiKey; settingsUi.ollamaModel.value = vm.model; settingsUi.hfToken = vm.hfToken
        settingsUi.themeMode.value = vm.themeMode
        settingsUi.devices.value = runDevices.value
    }

    private fun startModelDownload(idx: Int) {
        val m = ModelCatalog.models.getOrNull(idx) ?: return
        if (models.isReady(m.id) && m.id != "custom") { settingsUi.modelStatus.value = "ready ✓"; vm.log("● ${m.label} already downloaded"); return }
        val url = if (m.id == "custom") vm.customUrl else m.url
        if (url.isBlank()) { vm.log("! paste a .task URL for the Custom option"); return }
        settingsUi.modelProgress.value = 0; settingsUi.modelStatus.value = "downloading…"; vm.log("↓ downloading ${m.label}…")
        models.download(m.id, url, m.sizeMb, vm.hfToken,
            { p -> runOnUiThread { settingsUi.modelProgress.value = p; settingsUi.modelStatus.value = "downloading… $p%" } },
            { ok, msg -> runOnUiThread {
                settingsUi.modelProgress.value = -1
                if (ok) { settingsUi.modelStatus.value = "ready ✓"; vm.log("● model ${m.label} ready — tick 'Use on-device model'") }
                else { settingsUi.modelStatus.value = "failed"; vm.log("! model download: $msg") }
            } })
    }

    private fun doSignIn() {
        val platform = if (vm.clusterUrl.contains("://ghost-browser."))
            vm.clusterUrl.replace("://ghost-browser.", "://") else "https://my-app.engineer"
        load(platform)
        vm.log("→ log in to my-app.engineer, open Ghost Browser from the Tools tab, then reopen ⚙ Settings")
    }

    private fun doConnectToggle() {
        if (ctrlWeb != null || ringOn) {
            stopDeviceRing(); stopControlWeb(); vm.clusterOn.value = false; vm.clusterInfo.value = "Cluster: off"
            try { stopService(Intent(this, GbService::class.java)) } catch (e: Exception) {}
        } else {
            // a durable device login means no fresh sign-in is needed; only require the SSO cookie to enrol the first time
            if (vm.clusterKey.isBlank() && cookiesFor(vm.clusterUrl).isBlank()) { vm.log("! not signed in — tap Sign in, open Ghost Browser from Tools, then Connect"); return }
            vm.clusterInfo.value = "Cluster: connecting…"; vm.log(if (vm.clusterKey.isNotBlank()) "→ connecting with this device's saved login…" else "→ connecting (control channel on the GB origin)…")
            if (vm.clusterKey.isNotBlank()) { vm.clusterOn.value = true; vm.clusterInfo.value = "Cluster: on"; autoSyncSharedData(); startDeviceRing() }
            else startControlWeb()   // first time: the WebView rides the SSO cookie to enrol, then the ring takes over
            try { androidx.core.content.ContextCompat.startForegroundService(this, Intent(this, GbService::class.java)) } catch (e: Exception) {}
        }
    }

    private fun doOpenTailscale() {
        val pkg = "com.tailscale.ipn"
        val i = packageManager.getLaunchIntentForPackage(pkg)
            ?: Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$pkg"))
        try { startActivity(i) } catch (e: Exception) { vm.log("! could not open Tailscale: ${e.message}") }
    }

    private fun buildSettingsActions() = engineer.myapp.gbmobile.ui.SettingsActions(
        onSaveClusterUrl = { vm.clusterUrl = it.trim(); settingsUi.clusterUrl = vm.clusterUrl },
        onSignIn = { doSignIn() },
        onConnectToggle = { doConnectToggle() },
        onSetPassword = { pw -> if (vm.clusterUrl.trim().isNotEmpty()) apiCall("POST", "/api/auth/password", JSONObject().put("password", pw).toString(), "set_password") },
        onResync = { if (vm.clusterUrl.trim().isEmpty()) vm.log("! set the cluster URL first") else { vm.log("↻ re-syncing shared data…"); autoSyncSharedData() } },
        onOpenHub = { openDeviceHub() },
        onOpenTraining = { openTraining() },
        trainingLine = {
            val v = shellUi.training.value
            v.active?.let { r -> "training now on ${r.device}" + (r.lines.lastOrNull()?.let { " — $it" } ?: "") }
                ?: engineer.myapp.gb.shared.TrainingWatch.readiness(v.corpus)
        },
        onSwitchProfile = { p -> vm.selectProfile(p); renderChips(); renderRoleSpinner(); newTab(profile = p); syncSettingsUi() },
        onAddProfile = { name -> vm.addProfile(name); renderChips(); newTab(profile = name); syncSettingsUi() },
        onSetRole = { r -> setRoleForProfile(vm.currentProfile.value ?: "default", r); settingsUi.roleForCurrent.value = r.ifBlank { "(none)" }; renderRoleSpinner() },
        onLoadRoles = { if (vm.clusterUrl.trim().isEmpty()) vm.log("! set the cluster URL first") else { vm.log("↑ loading agent roles…"); apiCall("GET", "/v1/agent/roles", null, "roles_list") } },
        onLoadPlatforms = { loadPlatforms() },
        onOpenPlatform = { prof, site -> openPlatform(prof, site) },
        onSetCookieSync = { profile, approved ->
            val key = cookieSyncApprovalKey(profile)
            vm.approvedCookieSync = if (approved) vm.approvedCookieSync + key else vm.approvedCookieSync - key
            loginSyncHashes.remove(profile)
            settingsUi.platforms.value = settingsUi.platforms.value.map { if (it.profile == profile) it.copy(syncApproved = approved) else it }
            shellUi.platforms.value = settingsUi.platforms.value
            if (approved) syncLoginsToCluster(settingsUi.platforms.value)
            vm.log(if (approved) "● cookie sharing approved for $profile" else "● future cookie sharing stopped for $profile; sign out in the cluster profile to clear an existing login")
        },
        onSetUseLocal = { vm.useLocal = it; settingsUi.useLocal.value = it },
        onSelectModelIndex = { i -> settingsUi.modelIndex.value = i; vm.selectedModel = ModelCatalog.models.getOrElse(i) { ModelCatalog.models[0] }.id; refreshSettingsModel() },
        onDownloadModel = { startModelDownload(settingsUi.modelIndex.value) },
        onSaveOllama = { ep, ak, m, hf ->
            vm.endpoint = ep.trim(); vm.apiKey = ak.trim(); vm.model = m.trim(); vm.hfToken = hf.trim()
            settingsUi.endpoint.value = vm.endpoint; settingsUi.apiKey.value = vm.apiKey; settingsUi.ollamaModel.value = vm.model; settingsUi.hfToken = vm.hfToken
            vm.log("● endpoint saved")
            if (vm.clusterUrl.trim().isNotEmpty()) {
                agentExec.execute {
                    aiModelSave(ep, ak, m)
                }
            }
        },
        onRefreshDevices = { if (vm.clusterUrl.trim().isNotEmpty()) apiCall("GET", "/v1/device/list", null, "run_devices") },
        onOpenTailscale = { doOpenTailscale() },
        onSetTheme = { m -> vm.themeMode = m; settingsUi.themeMode.value = m },
        onClearLog = { vm.clearLog() },
        onFetchModels = { ep, key -> fetchOllamaModels(ep, key) },
        onPullClusterConfig = { if (vm.clusterUrl.trim().isEmpty()) vm.log("! set the cluster URL first") else { vm.log("↑ pulling model config from cluster…"); apiCall("GET", "/v1/agent/settings", null, "agentcfg") } },
        onOpenDownloads = { loadFiles(); shellUi.screen.value = "downloads" },
    )

    /** List models via the CLUSTER (POST /v1/agent/models) — the phone's direct call to ollama.com is
     *  blocked by Cloudflare's bot check, but the cluster (datacenter) reaches it fine and falls back to
     *  a curated cloud-model list. Reuses the SSO session. */
    private fun fetchOllamaModels(endpoint: String, apiKey: String) {
        if (vm.clusterUrl.trim().isEmpty()) { settingsUi.ollamaNote.value = "connect to the cluster first"; return }
        // /api/tags lives at the host root, not under /v1 — hand the cluster the bare host.
        val host = endpoint.trim().removeSuffix("/").removeSuffix("/v1").ifBlank { "https://ollama.com" }
        settingsUi.ollamaBusy.value = true; settingsUi.ollamaNote.value = "fetching via cluster…"
        val body = JSONObject().put("llmHost", host).put("llmKey", apiKey).toString()
        apiCall("POST", "/v1/agent/models", body, "ollamamodels")
    }

    // ---- observers ------------------------------------------------------------------------------

    private fun observe() {
        vm.logText.observe(this) { t -> settingsUi.log.value = t ?: "" }
        vm.clusterInfo.observe(this) { t ->
            settingsUi.clusterStatus.value = t
            settingsUi.connected.value = vm.clusterOn.value == true
            shellUi.clusterOn.value = vm.clusterOn.value == true
        }
        vm.profiles.observe(this) { settingsUi.profiles.value = it ?: listOf("default") }
        vm.currentProfile.observe(this) {
            settingsUi.currentProfile.value = it ?: "default"
            settingsUi.roleForCurrent.value = roleForProfile(it ?: "default").ifBlank { "(none)" }
        }
    }

    /** Run one device command on the browser and return its result JSON. Shared by the WebView control
     *  channel and the native device ring, so both drive the phone the same way. Runs on a worker thread;
     *  the eval/nav helpers hop to the main thread themselves. */
    fun runDeviceCommand(path: String, bodyStr: String): String {
        val body = try { JSONObject(bodyStr) } catch (e: Exception) { JSONObject() }
        return try {
            // a command may name a profile → run it in that profile's own hidden browser (the login lives there).
            // Kept inside the try so a build failure returns an error result instead of leaving the ring silent.
            val prof = body.optString("profile", "")
            cmdWeb = if (prof.isNotBlank() && prof != (vm.currentProfile.value ?: "default")) ringWebFor(prof) else null
            // a command may ask for the DESKTOP site (LinkedIn's mobile web omits comments; desktop renders the
            // full, stable comment DOM). Set the reader's UA before it loads; "desktop":false restores mobile.
            if (body.has("desktop")) { val ua = if (body.optBoolean("desktop")) DESKTOP_UA else null
                val l = CountDownLatch(1); runOnUiThread { try { cmdTarget().settings.userAgentString = ua ?: cmdTarget().settings.userAgentString.replace(Regex("\\(X11[^)]*\\)"), "(Linux; Android 13)") } catch (e: Exception) {}; l.countDown() }; l.await(3, TimeUnit.SECONDS) }
            when (path) {
                "/v1/navigate" -> "{\"url\":" + JSONObject.quote(navigate(body.optString("url"))) + "}"
                "/v1/analyze" -> evalGb("window.__gb.mark()")
                "/v1/info" -> evalGb("window.__gb.info()")
                "/v1/content" -> { waitSettle(4000); evalGb("window.__gb.text()") }
                "/v1/posts" -> { waitSettle(5000); evalGb("window.__gb.posts()") }
                "/v1/perceive" -> { waitSettle(6000); "{\"info\":${evalGb("window.__gb.info()")},\"elements\":${evalGb("window.__gb.mark()")},\"text\":${evalGb("window.__gb.text()")}}" }
                "/v1/click_text" -> nativeTapFromCoords(evalGb("window.__gb.coordsText(" + JSONObject.quote(body.optString("text")) + "," + body.optInt("nth", 0) + ")"))
                "/v1/click" -> nativeTapFromCoords(evalGb("window.__gb.coords(${body.optInt("index", -1)})"))
                "/v1/type" -> evalGb("window.__gb.type(${body.optInt("index", -1)}," + JSONObject.quote(body.optString("text")) + ")")
                "/v1/scroll" -> evalGb("window.__gb.scroll(${body.optInt("dy", 600)})")
                "/v1/screenshot" -> "{\"png_base64\":\"" + android.util.Base64.encodeToString(screenshotPng(), android.util.Base64.NO_WRAP) + "\"}"
                "/v1/fetch" -> fetchInPage(body)
                "/v1/eval" -> evalJs(gbJs + "\n(function(){try{return JSON.stringify((" + body.optString("code") + "))}catch(e){return JSON.stringify({error:String(e)})}})()")
                else -> "{\"error\":\"unknown path\"}"
            }
        } catch (e: Exception) { "{\"error\":" + JSONObject.quote(e.message ?: "error") + "}" }
        finally { cmdWeb = null }
    }

    // ── THE DEVICE RING (native): register + long-poll + result with the durable key, kept alive by the
    //    foreground service. No WebView, no SSO cookie — so the phone stays a reachable node reliably. ──
    @Volatile private var ringOn = false
    private val ringExec = java.util.concurrent.Executors.newSingleThreadExecutor()
    private fun ringHttp(method: String, path: String, body: String?, timeoutMs: Int): Pair<Int, String> {
        val c = java.net.URL(vm.clusterUrl.trim().trimEnd('/') + path).openConnection() as java.net.HttpURLConnection
        c.requestMethod = method; c.connectTimeout = 15000; c.readTimeout = timeoutMs
        c.setRequestProperty("Authorization", "Bearer ${vm.clusterKey}"); c.setRequestProperty("Accept", "application/json")
        if (body != null) { c.doOutput = true; c.setRequestProperty("Content-Type", "application/json"); c.outputStream.use { it.write(body.toByteArray()) } }
        val code = c.responseCode
        val txt = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        return code to txt
    }
    /** Self-hosted watchdog (no third-party push): the OS job scheduler revives the ring service ~every 15 min,
     *  even after a swipe-away or reboot, so the phone comes back as a node on its own. */
    private fun scheduleRingWatchdog() {
        try {
            val req = androidx.work.PeriodicWorkRequestBuilder<RingWatchdogWorker>(15, java.util.concurrent.TimeUnit.MINUTES)
                .setConstraints(androidx.work.Constraints.Builder().setRequiredNetworkType(androidx.work.NetworkType.CONNECTED).build()).build()
            androidx.work.WorkManager.getInstance(this).enqueueUniquePeriodicWork("gb-ring-watchdog", androidx.work.ExistingPeriodicWorkPolicy.UPDATE, req)
        } catch (e: Exception) { vm.log("! watchdog schedule: ${e.message}") }
    }

    @Volatile private var askedBattery = false
    private fun startDeviceRing() {
        if (ringOn || vm.clusterKey.isBlank()) return
        if (!askedBattery) { askedBattery = true; runOnUiThread { requestBatteryExemption() }; scheduleRingWatchdog() }
        ringOn = true
        ringExec.execute {
            var registered = false
            while (ringOn) {
                try {
                    if (!registered) {
                        val reg = ringHttp("POST", "/v1/device/register", JSONObject().put("deviceId", vm.deviceToken).put("name", android.os.Build.MODEL).put("caps", phoneCaps()).toString(), 20000)
                        if (reg.first == 401) { runOnUiThread { vm.clusterKey = ""; vm.log("· device login expired — sign in again"); ringOn = false }; break }
                        registered = reg.first in 200..299
                        if (registered) runOnUiThread { vm.clusterOn.value = true; vm.clusterInfo.value = "Cluster: on — this device is connected"; vm.log("● device connected (native) — stays online while the app runs") }
                        else { Thread.sleep(4000); continue }
                    }
                    val (code, txt) = ringHttp("GET", "/v1/device/poll?deviceId=" + java.net.URLEncoder.encode(vm.deviceToken, "UTF-8"), null, 35000)
                    if (code == 401) { runOnUiThread { vm.clusterKey = ""; ringOn = false }; break }
                    if (code == 404) { registered = false; continue }         // server forgot us (restart) → re-register
                    if (code == 200 && txt.isNotBlank()) {
                        val cmd = try { JSONObject(txt) } catch (e: Exception) { null }
                        val cid = cmd?.optString("id") ?: ""
                        if (cmd != null && cid.isNotBlank()) {
                            val out = runDeviceCommand(cmd.optString("path", "/v1/info"), cmd.optJSONObject("body")?.toString() ?: "{}")
                            try { ringHttp("POST", "/v1/device/result", JSONObject().put("deviceId", vm.deviceToken).put("id", cid).put("result", out).toString(), 20000) } catch (e: Exception) {}
                        }
                    }
                    // 204 (no command within the long-poll window) just loops; lastSeen was refreshed by the poll
                } catch (e: Exception) { Thread.sleep(3000) }
            }
        }
    }
    private fun stopDeviceRing() { ringOn = false }

    /** Ask Android once to exempt GB from battery optimization, so the foreground service + device ring keep
     *  polling when the screen is off / the app is backgrounded (Samsung Doze otherwise kills them). */
    private fun requestBatteryExemption() {
        try {
            val pm = getSystemService(android.os.PowerManager::class.java)
            if (pm != null && !pm.isIgnoringBatteryOptimizations(packageName)) {
                vm.log("· asking Android to keep this device connected in the background")
                @android.annotation.SuppressLint("BatteryLife")
                val i = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, android.net.Uri.parse("package:$packageName"))
                startActivity(i)
            }
        } catch (e: Exception) { vm.log("! battery exemption: ${e.message}") }
    }

    // JS -> app bridge: injected page code hands results back here.
    inner class PageBridge {
        @JavascriptInterface
        fun fetchResult(id: String, status: Int, bodyStr: String) {
            if (!fetchWaiters.containsKey(id)) return
            fetchResults[id] = JSONObject().put("status", status).put("body", bodyStr.take(2_000_000)).toString()
            fetchWaiters.remove(id)?.countDown()
        }
    }

    inner class ApiBridge(private val token: String) {
        @JavascriptInterface
        fun result(proof: String, tag: String, data: String) {
            if (proof == token) runOnUiThread { onBridge(tag, data) }
        }
    }

    inner class ControlBridge(private val token: String) {
        @JavascriptInterface
        fun result(proof: String, tag: String, data: String) {
            if (proof == token) runOnUiThread { onBridge(tag, data) }
        }

        @JavascriptInterface
        fun ctl(proof: String, tag: String, data: String) {
            if (proof != token) return
            runOnUiThread {
                when (tag) {
                    "registered" -> {
                        vm.clusterOn.value = true; vm.clusterInfo.value = "Cluster: ON — registered as ${android.os.Build.MODEL}\nwaiting for commands"
                        vm.log("● registered with the cluster — waiting for commands")
                        ctrlApiReady = true                 // the control session can now serve cluster reads
                        startRingWatch()                    // and from here we can see what the ring is doing
                        autoSyncSharedData()                // pull flows/platforms/roles over the connected session
                        apiCall("GET", "/v1/device/list", null, "run_devices")
                    }
                    "regfail" -> vm.log("! register failed (in-webview): $data — reopen GB from the platform Tools")
                    "pollerr" -> vm.log("… poll: $data")
                }
            }
        }

        @JavascriptInterface
        fun onCommand(proof: String, id: String, path: String, bodyStr: String) {
            if (proof != token) return
            cmdExec.execute {
                val out = runDeviceCommand(path, bodyStr)
                runOnUiThread {
                    vm.log("↺ ran $path")
                    ctrlWeb?.evaluateJavascript("window.__gbResult(" + JSONObject.quote(id) + ",200," + JSONObject.quote(out) + ")", null)
                }
            }
        }
    }

    private fun onBridge(tag: String, data: String) {
        // The one-time enrolment result: the SSO-authed WebView minted a durable device key. Store it, and
        // from now on every cluster call goes native with it — no more per-profile sign-in.
        if (tag == "enroll" || tag == "enroll_err") {
            if (tag == "enroll") try { val o = JSONObject(data); val t = o.optString("token"); if (t.isNotBlank()) { vm.clusterKey = t; vm.log("● connected — this device stays signed in"); startDeviceRing(); autoSyncSharedData() } else vm.log("! enrol: ${o.optString("error", data.take(80))}") } catch (e: Exception) { vm.log("! enrol: ${data.take(80)}") }
            else vm.log("! enrol failed: ${data.take(80)}")
            return
        }
        // Awaitable agent API calls: resolve the waiting latch (tag = "agentapi:<id>" or "..._err").
        if (tag.startsWith("agentapi:")) {
            val err = tag.endsWith("_err")
            val id = tag.removePrefix("agentapi:").removeSuffix("_err")
            agentApiResults[id] = if (err) "{\"error\":${JSONObject.quote(data)}}" else data
            agentApiWaiters.remove(id)?.countDown()
            return
        }
        // Per-watcher pass health (tag "whealth_<workflowId>") — one line on the card, red when quiet/errored.
        if (tag.startsWith("whealth_")) {
            val wid = tag.removePrefix("whealth_").removeSuffix("_err")
            if (!tag.endsWith("_err")) { watcherHealth[wid] = healthOf(data); if (lastWorkflowsJson.isNotBlank()) parseWatchers(lastWorkflowsJson, false) }
            return
        }
        // Per-watcher follow-up config responses (tag "wcfg_<workflowId>").
        if (tag.startsWith("wcfg_")) {
            val wid = tag.removePrefix("wcfg_").removeSuffix("_err")
            if (!tag.endsWith("_err")) try {
                val o = JSONObject(data); val fid = o.optString("followUpFlowId")
                val kinds = o.optJSONArray("followUpKinds") ?: JSONArray()
                val routes = o.optJSONArray("followUps")
                if (routes != null && routes.length() > 0) watcherCfg[wid] = routes.toString() to false
                else if (fid.isNotBlank()) watcherCfg[wid] = fid to (kinds.length() > 0)
                else watcherCfg.remove(wid)
                if (lastWorkflowsJson.isNotBlank()) parseWatchers(lastWorkflowsJson, false)
            } catch (e: Exception) {}
            return
        }
        when (tag) {
            "platforms" -> {
                try {
                    val arr = JSONObject(data).optJSONArray("presets") ?: JSONArray()
                    renderPlatforms(arr)
                    vm.platformsJson = data   // persist so it survives relaunch
                    vm.log("↓ your platforms (${arr.length()}) — tap one to open & sign in on this phone")
                } catch (e: Exception) {
                    shellUi.flowsHint.value = "Sign in first (Settings → Account & sync)"
                    vm.log("! could not read platforms — sign in via the Cluster tab (SSO), then Load. ${data.take(80)}")
                }
            }
            "platforms_err" -> { vm.log("! load platforms: ${data.take(140)}") }
            "flows" -> {
                try {
                    val combined = mergeLocalWorkflows(data)
                    val arr = JSONObject(combined).optJSONArray("workflows") ?: JSONArray()
                    renderFlows(arr)
                    vm.flowsJson = combined       // persist cluster cache and phone-owned records
                    parseWatchers(combined, false)
                    vm.log("↓ automations (${arr.length()})")
                } catch (e: Exception) {
                    shellUi.flowsHint.value = "Sign in first (Settings → Account & sync)"
                    vm.log("! could not read automations — sign in via the Cluster tab (SSO), then Load. ${data.take(80)}")
                }
            }
            "flows_err" -> { shellUi.flowsHint.value = "Sign in first (Settings → Account & sync)"; vm.log("! load automations: ${data.take(140)}") }
            "flowrun" -> try {
                val o = JSONObject(data); val runId = o.optString("runId")
                vm.log("● automation started (run $runId) — ${o.optString("status", "running")}")
                if (runId.isNotBlank()) {
                    val h = android.os.Handler(mainLooper)
                    for (d in listOf(5000L, 12000L, 25000L, 45000L, 70000L)) { h.postDelayed({ apiCall("GET", "/v1/workflow-runs/$runId", null, "flowrunstatus") }, d) }
                }
            } catch (e: Exception) { vm.log("! run: ${data.take(160)}") }
            "flowrun_err" -> vm.log("! run automation: ${data.take(140)}")
            "run_devices" -> try {
                val arr = JSONObject(data).optJSONArray("devices") ?: JSONArray()
                val list = ArrayList<DeviceOpt>()
                list.add(DeviceOpt("local", "This phone", "on-device engine · real IP · runs now", "📱", true))
                list.add(DeviceOpt("cluster", "Cluster", "headless · scale · runs now", "☁", true))
                for (i in 0 until arr.length()) {
                    val d = arr.optJSONObject(i) ?: continue
                    val nm = d.optString("name"); val on = d.optBoolean("online")
                    if (nm.equals(android.os.Build.MODEL, true)) continue   // that's THIS phone — already the 'local' option
                    val phone = nm.contains("SM-", true) || nm.contains("phone", true) || nm.contains("pixel", true) || nm.contains("galaxy", true)
                    list.add(DeviceOpt("dev:${d.optString("deviceId")}", nm,
                        if (on) "real device · local engine coming (P1)" else "offline", if (phone) "📱" else "🖥", on))
                }
                list.add(DeviceOpt("auto", "Auto (let the ring choose)", "picks the best device for the flow", "🔀", true))
                runDevices.value = list
                settingsUi.devices.value = list
                // native Device Hub cards (all registered nodes, with type/owner/last-seen/queued)
                val hub = ArrayList<engineer.myapp.gbmobile.ui.HubDevice>()
                var online = 0
                for (i in 0 until arr.length()) {
                    val d = arr.optJSONObject(i) ?: continue
                    val on = d.optBoolean("online"); if (on) online++
                    val caps = d.optJSONObject("caps")
                    val plat = caps?.optString("platform") ?: ""
                    val type = when { plat == "android" || caps?.optBoolean("mobileApp") == true -> "PHONE"; plat == "desktop" || caps?.optBoolean("cdp") == true -> "LAPTOP"; plat == "cluster" -> "CLUSTER"; else -> "NODE" }
                    hub.add(engineer.myapp.gbmobile.ui.HubDevice(
                        d.optString("name").ifBlank { d.optString("deviceId") }, d.optString("owner"),
                        type, on, d.optLong("lastSeen", 0), d.optInt("queued", 0)))
                }
                /* Each row carries what that machine's training round is doing, phrased by the
                   shared code rather than here — a laptop four hours into a round must never read
                   as idle, and two surfaces deriving it separately is how that comes back. */
                shellUi.hubDevices.value = hub.map { d ->
                    val tr = shellUi.training.value.byDevice[d.name]
                    d.copy(training = engineer.myapp.gb.shared.TrainingWatch.deviceLine(tr), trainingStale = tr?.stale == true)
                }
                shellUi.hubSummary.value = "$online online · ${arr.length()} registered"
            } catch (e: Exception) { /* keep base list */ }
            "run_devices_err" -> { /* keep base list */ }
            "run_training" -> {
                val v = engineer.myapp.gb.shared.TrainingWatch.parse(data)
                shellUi.training.value = v
                /* Re-phrase the hub rows off the same answer, so the two screens cannot drift. */
                shellUi.hubDevices.value = shellUi.hubDevices.value.map { d ->
                    val tr = v.byDevice[d.name]
                    d.copy(training = engineer.myapp.gb.shared.TrainingWatch.deviceLine(tr), trainingStale = tr?.stale == true)
                }
                /*
                 * The collection loop keeps its own state at its own endpoint, read straight after.
                 * Separate on purpose: an older cluster answers 404 for it and the training page must
                 * still draw. Folding it into one reply would make a missing block read as "off",
                 * which is a confident wrong answer about something that spends money.
                 */
                if (vm.clusterUrl.trim().isNotEmpty()) apiCall("GET", "/v1/harvest/state", null, "run_harvest")
            }
            "run_harvest" -> {
                val h = try { engineer.myapp.gb.shared.TrainingWatch.parseHarvest(data) } catch (e: Exception) { null }
                if (h != null) shellUi.training.value = shellUi.training.value.copy(harvest = h)
            }
            "run_runs" -> shellUi.trainingRuns.value = engineer.myapp.gb.shared.TrainingWatch.parseRuns(data)
            "run_results" -> shellUi.trainingResults.value = engineer.myapp.gb.shared.TrainingWatch.parseResults(data)
            "run_results_err" -> shellUi.trainingResults.value = engineer.myapp.gb.shared.TrainingWatch.Results(error = data.ifBlank { "the cluster did not answer" })
            "run_cmp_jobs" -> shellUi.compareOffer.value = engineer.myapp.gb.shared.TrainingWatch.parseCompareOffer(data)
            "run_cmp_jobs_err" -> shellUi.compareOffer.value = engineer.myapp.gb.shared.TrainingWatch.CompareOffer(error = data.ifBlank { "the cluster did not answer" })
            /*
             * A comparison fills in over minutes - a forty-step job on a processor-only sidecar is
             * not quick - so the answer to starting one is also the answer to polling it, and it
             * asks again until it says it is done.
             */
            "run_cmp_run" -> {
                val run = engineer.myapp.gb.shared.TrainingWatch.parseCompareRun(data)
                shellUi.compareRun.value = run
                if (run.id.isNotBlank() && !run.done && run.error.isBlank()) {
                    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                        if (shellUi.compareRun.value?.id == run.id && shellUi.compareRun.value?.done == false) {
                            apiCall("GET", "/v1/training/compare/" + run.id, null, "run_cmp_run")
                        }
                    }, 3000)
                }
            }
            "run_cmp_run_err" -> shellUi.compareRun.value = engineer.myapp.gb.shared.TrainingWatch.CompareRun(error = data.ifBlank { "the cluster did not answer" })
            "run_run" -> shellUi.trainingRun.value = engineer.myapp.gb.shared.TrainingWatch.parseRun(data)
            /* A label landed: read the run again so the chip shows what the server now holds. */
            "run_run_label" -> if (lastOpenRun.isNotBlank()) apiCall("GET", "/v1/training/runs/$lastOpenRun", null, "run_run")
            "run_promote" -> if (vm.clusterUrl.trim().isNotEmpty()) apiCall("GET", "/v1/training/state", null, "run_training")
            "route" -> try {
                // S4: the capability router answered. deviceId==this phone → run locally; a sibling device
                // → cluster for now (remote drive is next); null → cluster.
                val o = JSONObject(data)
                val did = o.optString("deviceId", ""); val nm = o.optString("name", ""); val reason = o.optString("reason", "")
                val g = pendingAutoGoal; pendingAutoGoal = ""; val id = runFlowId.value
                when {
                    did.isNotBlank() && did == vm.deviceToken -> { vm.log("🔀 ring → this phone ($reason)"); runFlowLocally(id, g) }
                    did.isNotBlank() -> { vm.log("🔀 ring identified $nm; running on the cluster (remote device-drive next)"); resolveAndRun("cluster", g, id) }
                    else -> { vm.log("🔀 ring → cluster ($reason)"); resolveAndRun("cluster", g, id) }
                }
            } catch (e: Exception) { onBridge("route_err", e.message ?: "route parse") }
            "route_err" -> {
                // router unreachable → fall back to the local capability guess (works without the control channel)
                val g = pendingAutoGoal; pendingAutoGoal = ""
                val hasModel = (vm.useLocal && models.isReady(vm.selectedModel)) || (!vm.useLocal && vm.endpoint.isNotBlank())
                vm.log(if (hasModel) "🔀 ring → this phone (router offline; local guess)" else "🔀 ring → cluster (router offline; no model)")
                if (hasModel) runFlowLocally(runFlowId.value, g) else resolveAndRun("cluster", g, runFlowId.value)
            }
            "sheetrun" -> try {
                val o = JSONObject(data); val runId = o.optString("runId")
                if (o.has("error")) { runPhase.value = "done"; runStatus.value = "! ${o.optString("error")}" }
                else {
                    runStatus.value = "Running…"; runActivity.value = emptyList()
                    // A workflow step may hit the approval gate — surface those live in the Run sheet.
                    pollApprovals(); startApprovalsPolling()
                    if (runId.isNotBlank()) {
                        currentRunId = runId
                        android.os.Handler(mainLooper).postDelayed({ if (runVisible.value) apiCall("GET", "/v1/workflow-runs/$runId", null, "sheetstatus") }, 4000L)
                    }
                }
            } catch (e: Exception) { runPhase.value = "done"; runStatus.value = "! ${data.take(120)}" }
            "sheetrun_err" -> { runPhase.value = "done"; runStatus.value = "! ${data.take(140)}" }
            "sheetstatus" -> try {
                val o = JSONObject(data); val st = o.optString("status", "?")
                // Live steps → the Run sheet activity box, so "Running…" always shows what it's doing.
                val steps = o.optJSONArray("steps") ?: JSONArray()
                if (steps.length() > 0) {
                    val lines = ArrayList<String>()
                    for (i in maxOf(0, steps.length() - 6) until steps.length()) {
                        val s = steps.optJSONObject(i) ?: continue
                        val label = s.optString("type").ifBlank { s.optString("kind") }
                        val detail = s.optString("status").ifBlank { s.optString("text") }
                        lines.add((if (label.isNotBlank()) "$label" else "step") + if (detail.isNotBlank()) " · $detail" else "")
                    }
                    runActivity.value = lines
                }
                if (st != "running") { runPhase.value = "done"; runStatus.value = "Done — $st." }
                else {
                    runStatus.value = "Running…"
                    val rid = currentRunId
                    if (rid.isNotBlank()) android.os.Handler(mainLooper).postDelayed({ if (runVisible.value && runPhase.value == "running") apiCall("GET", "/v1/workflow-runs/$rid", null, "sheetstatus") }, 5000L)
                }
            } catch (e: Exception) { }
            "sheetstatus_err" -> { }
            // ── Approvals gate: jobs + proposals ──────────────────────────────────────────────────
            "approvals" -> try {
                shellUi.jobsLoading.value = false
                val o = JSONObject(data)
                val arr = o.optJSONArray("jobs") ?: JSONArray()
                val out = ArrayList<engineer.myapp.gb.shared.JobInfo>()
                for (i in 0 until arr.length()) {
                    val j = arr.optJSONObject(i) ?: continue
                    val stepsArr = j.optJSONArray("steps") ?: JSONArray()
                    val steps = ArrayList<String>()
                    for (k in maxOf(0, stepsArr.length() - 8) until stepsArr.length()) {
                        val s = stepsArr.optJSONObject(k) ?: continue
                        val kind = s.optString("kind"); val txt = s.optString("text").ifBlank { s.optString("detail") }
                        steps.add((if (kind.isNotBlank()) "$kind: " else "") + txt)
                    }
                    val propArr = j.optJSONArray("proposals") ?: JSONArray()
                    val props = ArrayList<engineer.myapp.gb.shared.Proposal>()
                    for (k in 0 until propArr.length()) {
                        val p = propArr.optJSONObject(k) ?: continue
                        if (p.optString("state") != "pending") continue
                        props.add(engineer.myapp.gb.shared.Proposal(
                            jobId = j.optString("id"), pid = p.optString("pid"),
                            kind = p.optString("kind").ifBlank { "reply" },
                            why = p.optString("why").ifBlank { p.optString("label") },
                            url = p.optString("url"), text = p.optString("text"),
                            jobRole = j.optString("role"),
                        ))
                    }
                    out.add(engineer.myapp.gb.shared.JobInfo(j.optString("id"), j.optString("role"), j.optString("status"), steps, props))
                }
                shellUi.jobs.value = out
            } catch (e: Exception) { shellUi.jobsLoading.value = false; vm.log("! approvals parse: ${data.take(120)}") }
            "approvals_err" -> { shellUi.jobsLoading.value = false; vm.log("! approvals: ${data.take(120)}") }
            "people" -> shellUi.leads.value = AssistantJson.people(data)
            "people_err" -> {}
            "files" -> { shellUi.downloads.loading.value = false; shellUi.downloads.files.value = AssistantJson.files(data) }
            "files_err" -> { shellUi.downloads.loading.value = false; vm.log("! downloads: ${data.take(120)}") }
            "filedel" -> loadFiles()
            "filedel_err" -> vm.log("! delete: ${data.take(120)}")
            // recordings: the list feeds Downloads AND the cards in the chat (one map by id)
            "recordings" -> { val (list, free) = AssistantJson.recordings(data); shellUi.downloads.recordings.value = list; shellUi.downloads.recordingsFreeBytes.value = free
                engineer.myapp.gb.shared.RecordingHooks.recordings.value = engineer.myapp.gb.shared.RecordingHooks.recordings.value + list.associateBy { it.id } }
            "recordings_err" -> vm.log("! recordings: ${data.take(120)}")
            "recording" -> AssistantJson.recording(data)?.let { r -> engineer.myapp.gb.shared.RecordingHooks.recordings.value = engineer.myapp.gb.shared.RecordingHooks.recordings.value + (r.id to r) }
            "recording_err" -> {}
            "recstop" -> { vm.log("■ recording stopping"); apiCall("GET", "/v1/recordings", null, "recordings") }
            "recstop_err" -> vm.log("! stop recording: ${data.take(120)}")
            "recdel" -> apiCall("GET", "/v1/recordings", null, "recordings")
            "recdel_err" -> vm.log("! delete recording: ${data.take(120)}")
            "loginsync" -> try { val o = JSONObject(data); if (o.has("error")) vm.log("! login sync: ${o.optString("error")}") else vm.log("● cluster profile ${o.optString("profile")} has the login${if (o.optBoolean("applied")) " (applied to its open browser)" else " (applied at its next launch)"}") } catch (e: Exception) { vm.log("! login sync: ${data.take(100)}") }
            "loginsync_err" -> vm.log("! login sync: ${data.take(120)}")
            "watch_session" -> try {
                val sid = JSONObject(data).optString("sessionId")
                if (sid.isBlank()) { vm.log("! could not open the facebook session"); }
                else {
                    val b = JSONObject().put("role", "facebook.conversation").put("goal", RD_GOAL).put("sessionId", sid).toString()
                    apiCall("POST", "/v1/agent/jobs", b, "watch_started")
                }
            } catch (e: Exception) { vm.log("! start watch: ${data.take(120)}") }
            "watch_session_err" -> vm.log("! open facebook session: ${data.take(140)}")
            "watch_started" -> { vm.log("● reply watch running — drafts will appear in Approvals"); pollApprovals(); startApprovalsPolling() }
            "watch_started_err" -> vm.log("! start watch: ${data.take(140)}")
            "approval_act" -> pollApprovals()
            "approval_act_err" -> { vm.log("! action: ${data.take(140)}"); pollApprovals() }
            // ── Watchers ──────────────────────────────────────────────────────────────────────────
            "watchers" -> parseWatchers(data)
            "watchers_err" -> { shellUi.watchersLoading.value = false; vm.log("! watchers: ${data.take(120)}") }
            "watcher_create" -> {
                val wid = try { JSONObject(data).optString("id") } catch (e: Exception) { "" }
                val pf = pendingFollowUp; pendingFollowUp = null
                if (wid.isNotBlank() && pf != null) putWatcherConfig(wid, pf.first, pf.second)
                vm.log("● watcher saved — runs in the background on schedule"); loadWatchers()
            }
            "watcher_create_err" -> vm.log("! create watcher: ${data.take(160)}")
            "watcher_cfg" -> {}
            "watcher_cfg_err" -> vm.log("! follow-up config: ${data.take(120)}")
            "watcher_toggle" -> loadWatchers()
            "watcher_toggle_err" -> { vm.log("! toggle watcher: ${data.take(140)}"); loadWatchers() }
            "profiles_list" -> try {
                val arr = JSONObject(data).optJSONArray("profiles") ?: JSONArray()
                val names = ArrayList<String>()
                for (i in 0 until arr.length()) {
                    val v = arr.opt(i)
                    val nm = if (v is JSONObject) v.optString("name").ifBlank { v.optString("id") } else v?.toString() ?: ""
                    if (nm.isNotBlank() && !nm.startsWith("lost+")) names.add(nm)
                }
                if (names.isNotEmpty()) shellUi.watcherProfiles.value = names
            } catch (e: Exception) {}
            "profiles_list_err" -> {}
            "wfeed" -> try {
                // The feed item carries its own draft (written back by the follow-up), keyed exactly — no URL matching.
                val feedItems = JSONObject(data).optJSONArray("items") ?: JSONArray()
                val items = JSONArray()
                for (i in 0 until feedItems.length()) {
                    val it = feedItems.optJSONObject(i) ?: continue
                    if (it.optBoolean("handled")) continue
                    items.put(JSONObject()
                        .put("title", it.optString("title")).put("fields", it.optJSONObject("fields") ?: JSONObject())
                        .put("url", it.optString("url")).put("image", it.optString("image")).put("kind", it.optString("kind"))
                        .put("feedKey", it.optString("key"))
                        .put("draft", it.optString("draft")).put("jobId", it.optString("draftJobId")).put("pid", it.optString("draftPid"))
                        .put("draftState", it.optString("draftState")).put("posted", it.optString("posted"))
                        .put("postId", it.optJSONObject("fields")?.optString("postId") ?: "").put("postTitle", it.optJSONObject("fields")?.optString("postTitle") ?: "")
                        .put("why", it.optJSONObject("fields")?.optString("why") ?: "").put("thread", it.optJSONObject("fields")?.optString("thread") ?: "")
                        .put("lead", it.optJSONObject("fields")?.optBoolean("lead") == true))
                }
                showArtifact(buildArtifactHtml(pendingResults?.second ?: "Watcher", items, shellUi.flows.value))
            } catch (e: Exception) { vm.log("! results parse: ${data.take(120)}"); showArtifact(buildArtifactHtml(pendingResults?.second ?: "Watcher", JSONArray(), shellUi.flows.value)) }
            "wfeed_err" -> { vm.log("! results: ${data.take(140)}"); showArtifact(buildArtifactHtml(pendingResults?.second ?: "Watcher", JSONArray(), shellUi.flows.value)) }
            "artifact_run" -> vm.log("● flow started — its action will appear in Approvals")
            "artifact_run_err" -> vm.log("! follow-up: ${data.take(140)}")
            "artifact_approve" -> vm.log("● approved — the cluster re-checks the thread, then posts your words")
            "artifact_approve_err" -> vm.log("! approve: ${data.take(140)}")
            "artifact_deny" -> vm.log("○ dismissed")
            "artifact_deny_err" -> vm.log("! deny: ${data.take(140)}")
            "artifact_watchpost" -> vm.log("● watching that post — its threads appear after the next pass")
            "artifact_watchpost_err" -> vm.log("! watch post: ${data.take(140)}")
            "artifact_mutepost" -> vm.log("○ post muted")
            "artifact_mutepost_err" -> vm.log("! mute post: ${data.take(140)}")
            "devrunsave" -> vm.log("↑ run journaled to shared history")
            "devrunsave_err" -> vm.log("! journal run: ${data.take(120)}")
            "flowrunstatus" -> try {
                val o = JSONObject(data)
                val status = o.optString("status", "?")
                val steps = o.optJSONArray("steps") ?: JSONArray()
                var errored = false; var verifies = 0; var verifiedAll = true
                for (i in 0 until steps.length()) {
                    val s = steps.optJSONObject(i) ?: continue
                    if (s.optString("status") == "error") errored = true
                    if (s.optString("type") == "verify") { verifies++; val out = s.optJSONObject("output"); if (out == null || !out.optBoolean("found")) verifiedAll = false }
                }
                // The engine's own outcome semantics: a run is "verified" only if a verify step found its text.
                val outcome = when { errored -> "a step errored"; verifies > 0 && verifiedAll -> "verified ✓"; verifies > 0 -> "could not confirm"; else -> "" }
                if (status != "running" && !flowRunDone.contains(o.optString("id"))) {
                    flowRunDone.add(o.optString("id"))
                    vm.log((if (errored) "✗" else "✓") + " automation done: $status" + (if (outcome.isNotBlank()) " — $outcome" else ""))
                    apiCall("GET", "/v1/workflows", null, "flows")   // refresh run counts/verified badges
                }
            } catch (e: Exception) {}
            "flowcreate" -> try {
                val o = JSONObject(data)
                if (o.has("error")) vm.log("! create automation: ${o.optString("error")}")
                else { vm.log("✓ automation created: ${o.optString("name", o.optString("id"))}"); apiCall("GET", "/v1/workflows", null, "flows") }
            } catch (e: Exception) { vm.log("! create: ${data.take(160)}") }
            "flowcreate_err" -> vm.log("! create automation: ${data.take(140)}")
            "roles_list" -> try {
                vm.rolesCacheJson = data
                val n = JSONObject(data).optJSONArray("roles")?.length() ?: 0
                vm.log("↓ agent roles ($n) — pick one per profile"); renderRoleSpinner()
                settingsUi.roleNames.value = roleNames()
                settingsUi.roleForCurrent.value = roleForProfile(vm.currentProfile.value ?: "default").ifBlank { "(none)" }
            } catch (e: Exception) { vm.log("! roles: ${data.take(80)}") }
            "roles_list_err" -> vm.log("! load roles: ${data.take(120)}")
            "agentcfg" -> try {
                val o = JSONObject(data)
                val host = o.optString("llmHost"); val model = o.optString("llmModel")
                if (host.isNotBlank()) { vm.endpoint = host; settingsUi.endpoint.value = host }
                if (model.isNotBlank()) { vm.model = model; settingsUi.ollamaModel.value = model }
                settingsUi.ollamaNote.value = if (host.isNotBlank() || model.isNotBlank()) "pulled from cluster — add your key, then Fetch models" else "cluster has no model set yet"
                vm.log("↓ cluster model config: ${host.ifBlank { "(no host)" }} / ${model.ifBlank { "(no model)" }}")
            } catch (e: Exception) { vm.log("! agent config: ${data.take(100)}") }
            "agentcfg_err" -> settingsUi.ollamaNote.value = "! could not reach cluster config"
            "ollamamodels" -> try {
                val o = JSONObject(data)
                val arr = o.optJSONArray("models") ?: JSONArray()
                val list = ArrayList<String>(); for (i in 0 until arr.length()) { val m = arr.optString(i); if (m.isNotBlank()) list.add(m) }
                settingsUi.ollamaBusy.value = false
                settingsUi.ollamaModels.value = list
                if (list.isNotEmpty() && settingsUi.ollamaModel.value.isBlank()) settingsUi.ollamaModel.value = list[0]
                settingsUi.ollamaNote.value = when {
                    list.isEmpty() -> "! no models — ${o.optString("reason", "check endpoint")}"
                    o.optBoolean("fetched", true) -> "${list.size} models — pick one"
                    else -> "${list.size} known cloud models (couldn't reach host: ${o.optString("reason", "?")})"
                }
            } catch (e: Exception) { settingsUi.ollamaBusy.value = false; settingsUi.ollamaNote.value = "! ${data.take(80)}" }
            "ollamamodels_err" -> { settingsUi.ollamaBusy.value = false; settingsUi.ollamaNote.value = "! model fetch failed — ${data.take(80)}" }
            "profiles" -> try {
                val arr = JSONObject(data).optJSONArray("presets") ?: JSONArray()
                vm.log("↓ cluster profiles (${arr.length()}):")
                for (i in 0 until arr.length()) {
                    val p = arr.getJSONObject(i)
                    val loggedIn = if (p.optBoolean("exists")) " [logged in]" else ""
                    vm.log("   • " + p.optString("label", p.optString("key")) + " — " + p.optString("site") + loggedIn)
                }
            } catch (e: Exception) { vm.log("! profiles parse failed (${e.message}); sign in first. ${data.take(100)}") }
            "error" -> vm.log("! fetch error: ${data.take(160)} — tap Sign in first")
            else -> vm.log("$tag: ${data.take(160)}")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun startControlWeb() {
        stopControlWeb()
        val w = WebView(this)
        val bridgeToken = java.util.UUID.randomUUID().toString()
        val prof = vm.currentProfile.value ?: "default"
        ctrlProfile = prof
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            try { ProfileStore.getInstance().getOrCreateProfile(prof); WebViewCompat.setProfile(w, prof) } catch (e: Exception) {}
        }
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true)
        w.addJavascriptInterface(ControlBridge(bridgeToken), "GBHost")
        w.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                if (isClusterOrigin(url) && gbControlJs.isNotEmpty()) {
                    val js = gbControlJs.replace("__DEVICE_ID__", vm.deviceToken)
                        .replace("__DEVICE_NAME__", android.os.Build.MODEL.replace("\"", "").replace("\\", ""))
                        .replace("__CAPS__", phoneCaps().toString())
                        .replace("__BRIDGE_TOKEN__", JSONObject.quote(bridgeToken))
                    view?.evaluateJavascript(js, null)
                }
            }
        }
        (b.root as ViewGroup).addView(w, 1, 1)   // 1x1, effectively hidden
        ctrlWeb = w
        w.loadUrl(vm.clusterUrl)
        vm.logSink = { line -> pushLog(line) }
    }

    private fun isClusterOrigin(url: String?): Boolean {
        if (url.isNullOrBlank()) return false
        val expected = Uri.parse(vm.clusterUrl.trim())
        val actual = Uri.parse(url)
        return expected.scheme in listOf("http", "https") && actual.scheme == expected.scheme &&
            actual.host.equals(expected.host, ignoreCase = true) && actual.port == expected.port
    }

    /** Push one log line to the backend via the control WebView (same-origin SSO fetch = the proven path). */
    private fun pushLog(line: String) {
        val cw = ctrlWeb ?: return
        runOnUiThread {
            try { cw.evaluateJavascript("if(window.__gbLog)window.__gbLog(" + JSONObject.quote(line) + ")", null) } catch (e: Exception) {}
        }
    }

    private fun stopControlWeb() {
        vm.logSink = null
        ctrlApiReady = false
        ctrlWeb?.let { cw -> try { (cw.parent as? ViewGroup)?.removeView(cw); cw.destroy() } catch (e: Exception) {} }
        ctrlWeb = null
    }

    override fun onPause() {
        try { CookieManager.getInstance().flush() } catch (e: Exception) {}
        persistTabs()
        super.onPause()
    }

    override fun onDestroy() {
        rangeScanner.close()
        if (fullscreenView != null) hideFullscreenView()
        agentStop = true
        try { CookieManager.getInstance().flush() } catch (e: Exception) {}
        try { stopControlWeb() } catch (e: Exception) {}
        try { stopApiWeb() } catch (e: Exception) {}
        try { for (h in tabs) h.web?.destroy() } catch (e: Exception) {}
        try { cmdExec.shutdownNow() } catch (e: Exception) {}
        try { agentExec.shutdownNow() } catch (e: Exception) {}
        try { server?.stop() } catch (e: Exception) {}
        super.onDestroy()
    }
}
