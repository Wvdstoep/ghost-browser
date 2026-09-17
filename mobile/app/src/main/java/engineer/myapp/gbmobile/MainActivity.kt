package engineer.myapp.gbmobile

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
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
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.graphics.asImageBitmap
import engineer.myapp.gb.shared.DeviceOpt
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

    // --- tabs ---
    private inner class TabHandle(var url: String, var title: String, val profile: String, var desktop: Boolean = false) {
        var web: WebView? = null
        var thumb: Bitmap? = null   // last snapshot for the tab grid
    }
    private val tabs = mutableListOf<TabHandle>()
    private var activeTab = -1
    private lateinit var web: WebView                     // always the active tab's WebView

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
        b = ActivityMainBinding.inflate(layoutInflater)   // bare root FrameLayout (S6: UI is all Compose)
        setContentView(b.root)
        settingsUi.themeMode.value = vm.themeMode

        gbJs = try { assets.open("gb.js").bufferedReader().use { it.readText() } } catch (e: Exception) { "" }
        gbControlJs = try { assets.open("gb-control.js").bufferedReader().use { it.readText() } } catch (e: Exception) { "" }

        restoreTabs()
        try { agentChats = if (vm.agentChatsJson.isNotBlank()) JSONArray(vm.agentChatsJson) else JSONArray() } catch (e: Exception) { agentChats = JSONArray() }

        // The real browser lives in this FrameLayout, hosted inside the Compose shell via AndroidView.
        webHolder = android.widget.FrameLayout(this)
        // a fold/unfold or rotation changes the holder's size: refit the page to the new width
        webHolder.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, orr, ob -> if (r - l != orr - ol || b - t != ob - ot) web?.let { fitNarrowScreen(it) } }

        // S6: the whole app UI — one Compose host. Settings/Agent/Device Hub are screens INSIDE the
        // shell (bottom nav stays visible); only the run sheet is a modal overlay of its own.
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
        if (vm.flowsJson.isNotBlank()) try { renderFlows(JSONObject(vm.flowsJson).optJSONArray("workflows") ?: JSONArray()) } catch (e: Exception) {}
        if (vm.platformsJson.isNotBlank()) try { renderPlatforms(JSONObject(vm.platformsJson).optJSONArray("presets") ?: JSONArray()) } catch (e: Exception) {}
        renderRoleSpinner()
        observe()
        fetchLearnFeed()   // new-tab home feed (my-app.engineer /learn)

        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            try { requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 101) } catch (e: Exception) {}
        }

        activateTab(activeTab.coerceIn(0, tabs.size - 1))
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
        if (tabs.isEmpty()) tabs.add(TabHandle(HOME, "New tab", vm.currentProfile.value ?: "default"))
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
        val h = tabs[i]
        val w = ensureWeb(h)
        (w.parent as? ViewGroup)?.removeView(w)
        webHolder.removeAllViews()
        webHolder.addView(w)
        w.post { fitNarrowScreen(w) }
        web = w; activeTab = i
        lastUrl = h.url
        try { syncLoginForTab(h, h.url) } catch (e: Exception) { /* a tab already loaded before the update still syncs */ }
        if (h.profile != (vm.currentProfile.value ?: "default")) { vm.selectProfile(h.profile); renderChips() }
        shellUi.url.value = if (h.url == HOME) "" else h.url
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

    private fun newTab(url: String = HOME, activate: Boolean = true) {
        val prof = vm.currentProfile.value ?: "default"
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
                if (gbJs.isNotEmpty()) view?.evaluateJavascript(gbJs, null)
                loadLatch?.countDown()
                syncTabs()
                try { syncLoginForTab(h, h.url) } catch (e: Exception) { /* never in the way of the page */ }
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView?, title: String?) {
                if (!title.isNullOrBlank()) h.title = title
                syncTabs()
            }
        }
        w.addJavascriptInterface(Bridge(), "GBHost")   // lets injected JS hand results back to the app
        w.layoutParams = ViewGroup.LayoutParams(-1, -1)
        return w
    }

    private fun loadInBar() = load(shellUi.url.value)

    private fun load(raw: String) {
        var u = raw.trim(); if (u.isEmpty()) return
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
        val latch = CountDownLatch(1); loadLatch = latch
        val fu = u
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
        val latch = CountDownLatch(1); val holder = arrayOfNulls<String>(1)
        runOnUiThread { web.evaluateJavascript(script) { v -> holder[0] = v; latch.countDown() } }
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
        val prof = vm.currentProfile.value ?: "default"
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            try { ProfileStore.getInstance().getOrCreateProfile(prof); WebViewCompat.setProfile(w, prof) } catch (e: Exception) {}
        }
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true)
        w.addJavascriptInterface(Bridge(), "GBHost")
        w.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, u: String?) {
                if (apiReady) return
                view?.evaluateJavascript(
                    "window.__gbApi=function(m,p,b,t){var o={method:m,credentials:'include',headers:{'Content-Type':'application/json'}};if(b)o.body=b;" +
                    "fetch(p,o).then(function(r){return r.text()}).then(function(x){GBHost.result(t,x)}).catch(function(e){GBHost.result(t+'_err',String(e))})};", null)
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

    private fun stopApiWeb() {
        apiReady = false; apiQueue.clear()
        apiWeb?.let { pw -> try { (pw.parent as? ViewGroup)?.removeView(pw); pw.destroy() } catch (e: Exception) {} }
        apiWeb = null
    }

    /** P0 — the shared brain auto-loads the moment we're logged in (API/SSO session ready): roles,
     *  profiles/platforms and automations pull from the cluster automatically, so the data is just
     *  there. Replaces the manual "fetch" buttons. UI-toolkit-independent — survives the Compose rewrite. */
    private fun autoSyncSharedData() {
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
            out.add(engineer.myapp.gbmobile.ui.PlatformOpt(label, site, prof, signedIn))
        }
        settingsUi.platforms.value = out
        shellUi.platforms.value = out   // also feed the omnibox shortcuts
        vm.log("● signed in on this phone: " + (out.filter { it.signedIn }.map { it.label }.takeIf { it.isNotEmpty() }?.joinToString(", ") ?: "none"))
        syncLoginsToCluster(out)        // a login on this phone is a login on the cluster — by itself
        for (t in tabs) try { syncLoginForTab(t, t.url) } catch (e: Exception) { /* every open tab, once the platform list is here */ }
    }

    /** LOGIN SYNC. Every platform signed in on this phone signs the cluster's matching profile in too:
     *  the site's cookies go to POST /v1/profiles/<key>/cookies whenever they appear or change (hashed,
     *  so nothing is sent twice). No button — the cluster agent simply has what the phone has. */
    private val loginSyncHashes = HashMap<String, Int>()
    private var platformsRequested = false
    private fun apexOf(host: String): String { val parts = host.split("."); return if (parts.size >= 2) parts.takeLast(2).joinToString(".") else host }
    private fun syncLoginsToCluster(list: List<engineer.myapp.gbmobile.ui.PlatformOpt>) {
        if (vm.clusterUrl.trim().isEmpty()) return
        for (p in list) {
            if (!p.signedIn) continue
            val cookieStr = try { if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) ProfileStore.getInstance().getOrCreateProfile(p.profile).cookieManager.getCookie(p.site) ?: "" else "" } catch (e: Exception) { "" }
            pushLoginCookies(p, cookieStr)
        }
    }
    /** Every page that finishes loading, in ANY tab: when its host is one of the platforms, the tab's
     *  cookies for it go to the cluster's matching profile — a LinkedIn signed into from the address bar
     *  counts the same as one opened from the platform chip. Hashed per platform, so nothing goes twice. */
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
        val cookieStr = try {
            if (h.profile != "default" && WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) ProfileStore.getInstance().getOrCreateProfile(h.profile).cookieManager.getCookie(url) ?: ""
            else CookieManager.getInstance().getCookie(url) ?: ""
        } catch (e: Exception) { "" }
        if (cookieStr.isBlank()) { if (loginSyncHashes[p.profile] != 0) { loginSyncHashes[p.profile] = 0; vm.log("· ${p.label}: no cookies yet in this tab's profile (${h.profile}) — sign in here and they sync by themselves") }; return }
        pushLoginCookies(p, cookieStr)
    }
    private fun pushLoginCookies(p: engineer.myapp.gbmobile.ui.PlatformOpt, cookieStr: String) {
        if (cookieStr.isBlank()) return
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
            newTab(site)                 // open a new tab in this platform's isolated profile
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
                }
            }
            val runs = w.optInt("runs", 0)
            val verified = w.optBoolean("lastVerified")
            val proof = if (w.optBoolean("verifiedEver")) (if (verified) " · ✓ verified" else " · was verified") else ""
            val last = if (runs > 0) "$runs runs, last ${w.optString("lastRunStatus", "?")}$proof" else "never run"
            out.add(engineer.myapp.gbmobile.ui.FlowInfo(id, name, steps, last, profile, role, goals, runs, w.optString("lastRunStatus", ""), verified))
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
        runDevices.value = baseRunDevices()
        runVisible.value = true
        runHost?.let { it.visibility = View.VISIBLE; it.bringToFront() }
        if (vm.clusterUrl.trim().isNotEmpty()) apiCall("GET", "/v1/device/list", null, "run_devices")
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

    private fun agentSystemPrompt(): String {
        val tools = listOf(
            "browser_read: read the active tab {url,title,elements:[{i,tag,type,text}],text} — use before click/type",
            "browser_navigate {url}: open a url in the active tab",
            "browser_click {index}: click element i from browser_read",
            "browser_click_text {text}: click the element whose text/label contains this — use on sites without links (Facebook rows/buttons)",
            "browser_posts: read the post-like text blocks of a feed (Facebook groups etc.) — use this to READ a social feed, not browser_read",
            "browser_type {index,text}: type into element i",
            "browser_scroll {dy}: scroll the page",
            "switch_profile {name}: switch the active tab to another on-device profile (e.g. p_facebook) — its cookies/login",
            "fetch_url {url,method,body,headers}: authenticated same-origin fetch from the active tab",
            "list_workflows: automations with run counts + verified flags",
            "create_workflow {name,steps:[goal strings],role}: build a trigger->agent automation",
            "run_workflow {id}: run an automation and wait for its outcome",
            "get_run {runId} / workflow_runs {id}: run status/outcome / recent runs",
            "list_profiles: the ON-DEVICE browser profiles on THIS phone, which is active, and the current tab (url+profile)",
            "list_platforms / list_roles",
            "list_devices: connected device nodes (phone/laptop)",
            "device_command {deviceId,path,body}: drive ANOTHER node — NOT for the user's own signed-in sites on this phone"
        ).joinToString("\n") { "- $it" }
        return "You are the Ghost Browser agent running ON this phone. You DRIVE the phone's own real, " +
            "logged-in browser tab — the user is often already signed in on it (e.g. Facebook in the " +
            "p_facebook profile). To check messages, notifications, feeds or pages on a site the user " +
            "uses, DO IT ON THE ACTIVE TAB: browser_navigate to the site, then browser_read / browser_posts; " +
            "switch_profile first if the login lives in another profile. Do NOT use list_profiles or " +
            "device_command to reach the user's own accounts — those are for cluster data and OTHER devices. " +
            "Each turn reply with EXACTLY ONE compact JSON object and nothing else:\n" +
            "  {\"reply\":\"text to the user\"}  — to talk, answer, or report what you did\n" +
            "  {\"tool\":\"<name>\",\"args\":{...}} — to act; you then get TOOL RESULT and continue\n" +
            "Chain tools as needed; when done or you need the user, use reply. Be concise. Never invent tool results. Tools:\n" + tools
    }

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
        val base = if (roleName.isNotBlank())
            "ROLE: you are acting as \"$roleName\" — ${roleDescription(roleName)} Stay within this role's remit.\n\n" + agentSystemPrompt()
        else agentSystemPrompt()
        val sysPrompt = base + "\n\n" + agentTabContext()
        if (roleName.isNotBlank()) vm.log("▶ agent role: $roleName (profile ${vm.currentProfile.value})")
        agentBusy = true; runOnUiThread { shellUi.agentBusy.value = true }
        agentExec.execute {
            try {
                var toolCalls = 0
                while (toolCalls < 12) {
                    val transcript = buildAgentTranscript()
                    val reply = try { brain.chat(sysPrompt, transcript) } catch (e: Exception) { agentPushMsg("assistant", "⚠ model error: ${e.message}"); break }
                    val obj = extractJsonObj(reply)
                    if (obj == null || (obj.isNull("reply") && !obj.has("tool"))) { agentPushMsg("assistant", reply.trim().ifBlank { "(no reply)" }); break }
                    if (!obj.isNull("reply")) { agentPushMsg("assistant", obj.optString("reply")); break }
                    val name = obj.optString("tool"); val args = obj.optJSONObject("args") ?: JSONObject()
                    agentPushMsg("assistant", JSONObject().put("tool", name).put("args", args).toString(), null)
                    var result = try { runAgentTool(name, args) } catch (e: Exception) { "{\"error\":${JSONObject.quote(e.message ?: "error")}}" }
                    if (result.length > 3500) result = result.take(3500) + "…"
                    agentPushMsg("tool", result, name)
                    toolCalls++
                }
                if (toolCalls >= 12) agentPushMsg("assistant", "(stopped — too many steps in one turn; ask me to continue)")
            } finally { runOnUiThread { agentBusy = false; shellUi.agentBusy.value = false } }
        }
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
                else { runOnUiThread { vm.selectProfile(name); renderChips(); newTab(); shellUi.screen.value = "agent" }; Thread.sleep(600); "{\"ok\":true,\"active\":${JSONObject.quote(name)}}" }
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
            assistantChatId = v.id; ASSIST.chat.value = v; ASSIST.error.value = ""
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
    private fun assistantNew() {
        val v = AssistantJson.chat(apiAwait("POST", "/v1/assistant/chats", "{}"))
        runOnUiThread { if (v != null) { assistantChatId = v.id; ASSIST.chat.value = v; ASSIST.error.value = ""; shellUi.agentBusy.value = false } else ASSIST.error.value = "Could not start a chat — is your Ghost Browser connected?" }
        assistantRefreshChats()
    }
    private fun assistantSend(text: String) {
        if (text.isBlank()) return
        // the owner's words appear at once; the cluster's copy replaces it on the next load
        ASSIST.chat.value?.let { c -> ASSIST.chat.value = c.copy(turns = c.turns + engineer.myapp.gb.shared.AssistantTurn("user", text, System.currentTimeMillis(), spoken = c.live != null)) }
        shellUi.agentBusy.value = true
        agentExec.execute {
            if (assistantChatId.isBlank()) { val v = AssistantJson.chat(apiAwait("POST", "/v1/assistant/chats", "{}")); if (v == null) { runOnUiThread { ASSIST.error.value = "Could not start a chat — is your Ghost Browser connected?"; shellUi.agentBusy.value = false }; return@execute }; assistantChatId = v.id }
            val id = assistantChatId
            val r = try { JSONObject(apiAwait("POST", "/v1/assistant/chats/$id/messages", JSONObject().put("text", text).toString())) } catch (e: Exception) { JSONObject().put("error", "no answer from the cluster") }
            if (r.has("error")) runOnUiThread { ASSIST.error.value = r.optString("error"); shellUi.agentBusy.value = false }
            assistantLoad(id)
        }
    }
    /** A card the assistant handed the owner: a door into results, approvals or a page. */
    private fun assistantCard(c: engineer.myapp.gb.shared.AssistantCard) {
        when (c.kind) {
            "results" -> if (c.watcherId.isNotBlank()) openWatcherResults(c.watcherId)
            "approvals" -> { shellUi.screen.value = "approvals"; pollApprovals(); startApprovalsPolling() }
            "url" -> if (c.url.isNotBlank()) { shellUi.screen.value = "browser"; load(c.url) }
            "choice" -> assistantSend(c.title)   // the agent asked; the tapped option is the answer
        }
    }

    // ---- The AI model: Ghost Browser's own setting, edited from here ----------------------------
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

    // ---- Cluster panel --------------------------------------------------------------------------

    /** Build the shell (browser/flows/agent) actions. */
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
        onNav = { s -> shellUi.screen.value = s; if (s == "flows" && vm.flowsJson.isBlank() && vm.clusterUrl.trim().isNotEmpty()) apiCall("GET", "/v1/workflows", null, "flows") },
        onOpenSettings = { openSettings() },
        onOpenAgent = { assistantOpen() },
        onCloseAgent = { shellUi.screen.value = "browser" },
        assistant = engineer.myapp.gb.shared.AssistantActions(
            onSend = { t -> assistantSend(t) },
            onNew = { agentExec.execute { assistantNew() } },
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
        ),
        onLoadFlows = { if (vm.clusterUrl.trim().isEmpty()) vm.log("! sign in first (Settings → Account & sync)") else { vm.log("↑ loading automations…"); apiCall("GET", "/v1/workflows", null, "flows") } },
        onRunFlow = { id, name -> runFlow(id, name) },
        onCreateFlow = { name, steps -> createFlow(name, steps) },
        onLoadPlatforms = { loadPlatforms() },
        onOpenPlatform = { prof, site -> shellUi.urlFocused.value = false; openPlatform(prof, site) },
        onOpenLearn = { slug -> load("$LEARN_SITE/learn/$slug") },
        onRefreshHome = { fetchLearnFeed() },
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
        if (vm.clusterUrl.trim().isEmpty()) { vm.log("! sign in first (Settings → Account & sync)"); return }
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
        } else {
            val agent = JSONObject().put("id", "n0").put("type", "agent").put("label", "Watch")
                .put("role", role).put("profile", profile).put("goal", goal.ifBlank { DEFAULT_WATCH_GOAL })
            nodes.put(agent); edges.put(JSONObject().put("from", "trigger").put("to", "n0"))
        }
        val body = JSONObject().put("name", name).put("active", true).put("autoApprove", false)
            .put("nodes", nodes).put("edges", edges).toString()
        if (id.isNullOrBlank()) {
            pendingFollowUp = followUpFlowId to followUpRepliesOnly
            vm.log("+ creating watcher \"$name\" (every $intervalMin min)…"); apiCall("POST", "/v1/workflows", body, "watcher_create")
        } else {
            vm.log("✎ saving watcher \"$name\"…"); apiCall("PUT", "/v1/workflows/$id", body, "watcher_create")
            putWatcherConfig(id, followUpFlowId, followUpRepliesOnly)
        }
    }
    private fun toggleWatcher(id: String, active: Boolean) {
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
        vm.log("↑ opening results for \"$name\"…")
        apiCall("GET", "/v1/watchers/$id/feed", null, "wfeed")   // step 1: the deduped feed
    }

    /** Parse GET /v1/workflows → the ones with a schedule trigger are watchers. */
    private fun parseWatchers(data: String, fetchCfg: Boolean = true) {
        lastWorkflowsJson = data
        try {
            val arr = JSONObject(data).optJSONArray("workflows") ?: JSONArray()
            val out = ArrayList<engineer.myapp.gb.shared.Watcher>()
            watcherRaw.clear()
            for (i in 0 until arr.length()) {
                val w = arr.optJSONObject(i) ?: continue
                val nodes = w.optJSONArray("nodes") ?: JSONArray()
                var trig: JSONObject? = null; var agent: JSONObject? = null; var steps = 0
                for (j in 0 until nodes.length()) {
                    val n = nodes.optJSONObject(j) ?: continue
                    if (n.optString("type") == "trigger") trig = n.optJSONObject("trigger")
                    else { steps++; if (n.optString("type") == "agent" && agent == null) agent = n }
                }
                val cfg = trig ?: w.optJSONObject("trigger")
                if (cfg == null || cfg.optString("type") != "schedule") continue   // only scheduled = a watcher
                val id = w.optString("id"); if (id.isBlank()) continue
                watcherRaw[id] = w
                val n = maxOf(1, cfg.optInt("n", 1))
                val runs = w.optInt("runs", 0)
                val last = if (runs > 0) "$runs runs, last ${w.optString("lastRunStatus", "?")}" else "never run"
                out.add(engineer.myapp.gb.shared.Watcher(
                    id = id, name = w.optString("name", id), role = agent?.optString("role") ?: "general",
                    profile = agent?.optString("profile") ?: "", intervalMin = n, active = w.optBoolean("active"),
                    lastRun = last, resultCount = 0, goal = agent?.optString("goal") ?: "",
                    mode = if (steps > 1) "automation" else "role", stepCount = steps,
                    followUpFlowId = watcherCfg[id]?.first?.takeIf { !it.startsWith("[") } ?: "", followUpRepliesOnly = watcherCfg[id]?.second ?: true,
                    followUps = watcherCfg[id]?.first?.takeIf { it.startsWith("[") }?.let { routesOf(it) } ?: emptyList(),
                    health = watcherHealth[id]?.line ?: "", stale = watcherHealth[id]?.stale ?: false, running = watcherHealth[id]?.running ?: false,
                ))
            }
            shellUi.watchers.value = out
            if (fetchCfg) out.forEach { apiCall("GET", "/v1/watchers/${it.id}/config", null, "wcfg_${it.id}"); apiCall("GET", "/v1/watchers/${it.id}/health", null, "whealth_${it.id}") }
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
        if (vm.clusterUrl.trim().isNotEmpty()) apiCall("GET", "/v1/device/list", null, "run_devices")
    }

    /** Native, local Device Hub screen — no cluster web page. Renders /v1/device/list as cards. */
    private fun openDeviceHub() {
        shellUi.screen.value = "devices"
        if (vm.clusterUrl.trim().isNotEmpty()) apiCall("GET", "/v1/device/list", null, "run_devices")
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
        if (ctrlWeb != null) {
            stopControlWeb(); vm.clusterOn.value = false; vm.clusterInfo.value = "Cluster: off"
            try { stopService(Intent(this, GbService::class.java)) } catch (e: Exception) {}
        } else {
            if (cookiesFor(vm.clusterUrl).isBlank()) { vm.log("! not signed in — tap Sign in, open Ghost Browser from Tools, then Connect"); return }
            vm.clusterInfo.value = "Cluster: connecting…"; vm.log("→ connecting (control channel on the GB origin)…")
            startControlWeb()
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
        onResync = { if (vm.clusterUrl.trim().isEmpty()) vm.log("! set the cluster URL first") else { vm.log("↻ re-syncing shared data…"); autoSyncSharedData() } },
        onOpenHub = { openDeviceHub() },
        onSwitchProfile = { p -> vm.selectProfile(p); renderChips(); renderRoleSpinner(); newTab(); syncSettingsUi() },
        onAddProfile = { name -> vm.addProfile(name); renderChips(); newTab(); syncSettingsUi() },
        onSetRole = { r -> setRoleForProfile(vm.currentProfile.value ?: "default", r); settingsUi.roleForCurrent.value = r.ifBlank { "(none)" }; renderRoleSpinner() },
        onLoadRoles = { if (vm.clusterUrl.trim().isEmpty()) vm.log("! set the cluster URL first") else { vm.log("↑ loading agent roles…"); apiCall("GET", "/v1/agent/roles", null, "roles_list") } },
        onLoadPlatforms = { loadPlatforms() },
        onOpenPlatform = { prof, site -> openPlatform(prof, site) },
        onSetUseLocal = { vm.useLocal = it; settingsUi.useLocal.value = it },
        onSelectModelIndex = { i -> settingsUi.modelIndex.value = i; vm.selectedModel = ModelCatalog.models.getOrElse(i) { ModelCatalog.models[0] }.id; refreshSettingsModel() },
        onDownloadModel = { startModelDownload(settingsUi.modelIndex.value) },
        onSaveOllama = { ep, ak, m, hf ->
            vm.endpoint = ep.trim(); vm.apiKey = ak.trim(); vm.model = m.trim(); vm.hfToken = hf.trim()
            settingsUi.endpoint.value = vm.endpoint; settingsUi.apiKey.value = vm.apiKey; settingsUi.ollamaModel.value = vm.model; settingsUi.hfToken = vm.hfToken
            vm.log("● endpoint saved")
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

    // JS -> app bridge: injected page code hands results back here.
    inner class Bridge {
        @JavascriptInterface
        fun result(tag: String, data: String) { runOnUiThread { onBridge(tag, data) } }

        @JavascriptInterface
        fun ctl(tag: String, data: String) = runOnUiThread {
            when (tag) {
                "registered" -> {
                    vm.clusterOn.value = true; vm.clusterInfo.value = "Cluster: ON — registered as ${android.os.Build.MODEL}\nwaiting for commands"
                    vm.log("● registered with the cluster — waiting for commands")
                    ctrlApiReady = true                 // the control session can now serve cluster reads
                    autoSyncSharedData()                // pull flows/platforms/roles over the connected session
                    apiCall("GET", "/v1/device/list", null, "run_devices")
                }
                "regfail" -> vm.log("! register failed (in-webview): $data — reopen GB from the platform Tools")
                "pollerr" -> vm.log("… poll: $data")
            }
        }

        @JavascriptInterface
        fun fetchResult(id: String, status: Int, bodyStr: String) {
            fetchResults[id] = JSONObject().put("status", status).put("body", bodyStr.take(2_000_000)).toString()
            fetchWaiters.remove(id)?.countDown()
        }

        @JavascriptInterface
        fun onCommand(id: String, path: String, bodyStr: String) {
            cmdExec.execute {
                val body = try { JSONObject(bodyStr) } catch (e: Exception) { JSONObject() }
                val out = try {
                    when (path) {
                        "/v1/navigate" -> "{\"url\":" + JSONObject.quote(navigate(body.optString("url"))) + "}"
                        "/v1/analyze" -> evalGb("window.__gb.mark()")
                        "/v1/info" -> evalGb("window.__gb.info()")
                        "/v1/content" -> { waitSettle(4000); evalGb("window.__gb.text()") }
                        "/v1/posts" -> { waitSettle(5000); evalGb("window.__gb.posts()") }
                        "/v1/perceive" -> {   // one reliable look: settle, then url+title+elements+text together
                            waitSettle(6000)
                            "{\"info\":${evalGb("window.__gb.info()")},\"elements\":${evalGb("window.__gb.mark()")},\"text\":${evalGb("window.__gb.text()")}}"
                        }
                        "/v1/click_text" -> nativeTapFromCoords(evalGb("window.__gb.coordsText(" + JSONObject.quote(body.optString("text")) + "," + body.optInt("nth", 0) + ")"))
                        "/v1/click" -> nativeTapFromCoords(evalGb("window.__gb.coords(${body.optInt("index", -1)})"))
                        "/v1/type" -> evalGb("window.__gb.type(${body.optInt("index", -1)}," + JSONObject.quote(body.optString("text")) + ")")
                        "/v1/scroll" -> evalGb("window.__gb.scroll(${body.optInt("dy", 600)})")
                        "/v1/screenshot" -> "{\"png_base64\":\"" + android.util.Base64.encodeToString(screenshotPng(), android.util.Base64.NO_WRAP) + "\"}"
                        "/v1/fetch" -> fetchInPage(body)
                        // Embed the code as an expression (NOT eval()) so a page's CSP (e.g. Facebook's) can't block it.
                        "/v1/eval" -> evalJs(gbJs + "\n(function(){try{return JSON.stringify((" + body.optString("code") + "))}catch(e){return JSON.stringify({error:String(e)})}})()")
                        else -> "{\"error\":\"unknown path\"}"
                    }
                } catch (e: Exception) { "{\"error\":" + JSONObject.quote(e.message ?: "error") + "}" }
                runOnUiThread {
                    vm.log("↺ ran $path")
                    ctrlWeb?.evaluateJavascript("window.__gbResult(" + JSONObject.quote(id) + ",200," + JSONObject.quote(out) + ")", null)
                }
            }
        }
    }

    private fun onBridge(tag: String, data: String) {
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
                    val arr = JSONObject(data).optJSONArray("workflows") ?: JSONArray()
                    renderFlows(arr)
                    vm.flowsJson = data       // persist so it survives relaunch
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
                shellUi.hubDevices.value = hub
                shellUi.hubSummary.value = "$online online · ${arr.length()} registered"
            } catch (e: Exception) { /* keep base list */ }
            "run_devices_err" -> { /* keep base list */ }
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
        val prof = vm.currentProfile.value ?: "default"
        ctrlProfile = prof
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            try { ProfileStore.getInstance().getOrCreateProfile(prof); WebViewCompat.setProfile(w, prof) } catch (e: Exception) {}
        }
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true)
        w.addJavascriptInterface(Bridge(), "GBHost")
        w.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                if (url != null && url.contains("ghost-browser") && gbControlJs.isNotEmpty()) {
                    val js = gbControlJs.replace("__DEVICE_ID__", vm.deviceToken)
                        .replace("__DEVICE_NAME__", android.os.Build.MODEL.replace("\"", "").replace("\\", ""))
                        .replace("__CAPS__", phoneCaps().toString())
                    view?.evaluateJavascript(js, null)
                }
            }
        }
        (b.root as ViewGroup).addView(w, 1, 1)   // 1x1, effectively hidden
        ctrlWeb = w
        w.loadUrl(vm.clusterUrl)
        vm.logSink = { line -> pushLog(line) }
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
