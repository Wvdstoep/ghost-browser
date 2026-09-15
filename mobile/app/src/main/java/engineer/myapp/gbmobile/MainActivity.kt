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
import engineer.myapp.gbmobile.ui.DeviceOpt
import engineer.myapp.gbmobile.ui.GbTheme
import engineer.myapp.gbmobile.ui.RunSheet

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
    private var apiWeb: WebView? = null                  // hidden WebView on the GB origin = same-origin authed API channel
    @Volatile private var apiReady = false
    private val apiQueue = mutableListOf<() -> Unit>()
    private var gbControlJs: String = ""
    private val cmdExec = java.util.concurrent.Executors.newSingleThreadExecutor()

    // --- Run sheet (Compose) — the run-anywhere UX shell: pick device → goal → run → progress ---
    private var runHost: ComposeView? = null
    private val runVisible: MutableState<Boolean> = mutableStateOf(false)
    private val runDevices: MutableState<List<DeviceOpt>> = mutableStateOf(emptyList())
    private val runFlowId: MutableState<String?> = mutableStateOf(null)
    private val runFlowName: MutableState<String?> = mutableStateOf(null)
    private val runPhase: MutableState<String> = mutableStateOf("pick")   // pick | running | done
    private val runStatus: MutableState<String> = mutableStateOf("")
    @Volatile private var runUserStopped = false

    // S5: the redesigned Compose settings — reactive state + actions, hosted in its own overlay.
    private var settingsHost: ComposeView? = null
    private val settingsVisible: MutableState<Boolean> = mutableStateOf(false)
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

        // S6: the whole app UI — one Compose host.
        appHost = ComposeView(this).also { host ->
            host.setContent {
                GbTheme(dark = computeDark()) {
                    engineer.myapp.gbmobile.ui.AppShell(shell = shellUi, act = buildShellActions(), webHolder = webHolder)
                }
            }
            (b.root as ViewGroup).addView(host, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }

        // Overlays over the shell: Run sheet + Settings (kept as their own hosts).
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
                    )
                }
            }
            (b.root as ViewGroup).addView(host, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        settingsHost = ComposeView(this).also { host ->
            host.visibility = View.GONE
            host.setContent {
                GbTheme(dark = computeDark()) {
                    engineer.myapp.gbmobile.ui.SettingsScreen(
                        visible = settingsVisible.value, ui = settingsUi, act = buildSettingsActions(),
                        onClose = { settingsVisible.value = false; settingsHost?.visibility = View.GONE },
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
        web = w; activeTab = i
        lastUrl = h.url
        if (h.profile != (vm.currentProfile.value ?: "default")) { vm.selectProfile(h.profile); renderChips() }
        shellUi.url.value = if (h.url == HOME) "" else h.url
        shellUi.screen.value = "browser"
        updateTabCount()
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
            if (settingsVisible.value) { settingsVisible.value = false; settingsHost?.visibility = View.GONE; return true }
            if (runVisible.value && runPhase.value != "running") { runVisible.value = false; runHost?.visibility = View.GONE; return true }
            if (shellUi.urlFocused.value) { shellUi.urlFocused.value = false; return true }
            if (shellUi.menuOpen.value) { shellUi.menuOpen.value = false; return true }
            if (shellUi.agentOpen.value) { shellUi.agentOpen.value = false; return true }
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
     *  (or [tag]_err on failure). */
    private fun apiCall(method: String, path: String, body: String?, tag: String) {
        ensureApiWeb()
        val call: () -> Unit = {
            val bodyJs = if (body == null) "null" else JSONObject.quote(body)
            apiWeb?.evaluateJavascript("window.__gbApi(" + JSONObject.quote(method) + "," + JSONObject.quote(path) + "," + bodyJs + "," + JSONObject.quote(tag) + ")", null)
            Unit
        }
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
            val site = p.optString("site")
            if (key.isBlank() || site.isBlank()) continue
            val prof = "p_" + key.lowercase().replace(Regex("[^a-z0-9_-]"), "")
            // "signed in" ONLY if this phone's profile actually holds a session cookie for the site.
            val signedIn = known.contains(prof) && profileHasSession(prof, site)
            out.add(engineer.myapp.gbmobile.ui.PlatformOpt(label, site, prof, signedIn))
        }
        settingsUi.platforms.value = out
        shellUi.platforms.value = out   // also feed the omnibox shortcuts
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
        settingsVisible.value = false; settingsHost?.visibility = View.GONE   // jump to the browser
    }

    // ---- Flows (automations — the same workflow engine GB runs) ---------------------------------

    /** Push the flows into the Compose shell state. */
    private fun renderFlows(arr: JSONArray) {
        val out = ArrayList<engineer.myapp.gbmobile.ui.FlowInfo>()
        for (i in 0 until arr.length()) {
            val w = arr.optJSONObject(i) ?: continue
            val id = w.optString("id"); if (id.isBlank()) continue
            val name = w.optString("name", id)
            val steps = w.optJSONArray("nodes")?.length() ?: w.optInt("nodes", 0)
            val runs = w.optInt("runs", 0)
            val proof = if (w.optBoolean("verifiedEver")) (if (w.optBoolean("lastVerified")) " · ✓ verified" else " · was verified") else ""
            val last = if (runs > 0) "$runs runs, last ${w.optString("lastRunStatus", "?")}$proof" else "never run"
            out.add(engineer.myapp.gbmobile.ui.FlowInfo(id, name, steps, last))
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
        runPhase.value = "running"
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
        val logStep: (String) -> Unit = { m -> journal.add(m); lastActivity.set(System.currentTimeMillis()); runOnUiThread { vm.log(m) } }
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
            if (vm.endpoint.isBlank()) null else OllamaClient(vm.endpoint, vm.apiKey, vm.model)
        }
    }

    private fun openAgentChat() {
        shellUi.switcherOpen.value = false
        if (agentChat == null) { if (agentChats.length() > 0) agentChat = agentChats.optJSONObject(0) else newAgentChat() }
        refreshAgentMsgs()
        shellUi.agentOpen.value = true
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
            "fetch_url {url,method,body,headers}: authenticated same-origin fetch from the active tab",
            "list_workflows: automations with run counts + verified flags",
            "create_workflow {name,steps:[goal strings],role}: build a trigger->agent automation",
            "run_workflow {id}: run an automation and wait for its outcome",
            "get_run {runId} / workflow_runs {id}: run status/outcome / recent runs",
            "list_profiles / list_platforms / list_roles",
            "list_devices: connected device nodes (phone/laptop)",
            "device_command {deviceId,path,body}: drive another node (path e.g. /v1/navigate,/v1/info,/v1/fetch)"
        ).joinToString("\n") { "- $it" }
        return "You are the Ghost Browser agent — you can hold a normal conversation AND take real actions by calling tools. " +
            "Each turn reply with EXACTLY ONE compact JSON object and nothing else:\n" +
            "  {\"reply\":\"text to the user\"}  — to talk, answer, or report what you did\n" +
            "  {\"tool\":\"<name>\",\"args\":{...}} — to act; you then get TOOL RESULT and continue\n" +
            "Chain tools as needed; when done or you need the user, use reply. Be concise. Never invent tool results. Tools:\n" + tools
    }

    private fun sendAgentMessage(input: String) {
        if (agentBusy) return
        val text = input.trim(); if (text.isEmpty()) return
        val brain = buildBrain()
        if (brain == null) {
            if (agentChat == null) newAgentChat()
            agentPushMsg("assistant", "Set your model first — Settings → Devices & ring: pick/download an on-device model, or set an Ollama endpoint.")
            return
        }
        if (agentChat == null) newAgentChat()
        agentPushMsg("user", text, null)
        // adopt the active profile's role (like the platform's per-profile agent roles)
        val roleName = roleForProfile(vm.currentProfile.value ?: "default")
        val sysPrompt = if (roleName.isNotBlank())
            "ROLE: you are acting as \"$roleName\" — ${roleDescription(roleName)} Stay within this role's remit.\n\n" + agentSystemPrompt()
        else agentSystemPrompt()
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
            "list_profiles" -> apiAwait("GET", "/v1/profiles", null)
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
        onOpenAgent = { openAgentChat() },
        onCloseAgent = { shellUi.agentOpen.value = false },
        onNewAgentChat = { newAgentChat() },
        onSendAgent = { t -> sendAgentMessage(t) },
        onLoadFlows = { if (vm.clusterUrl.trim().isEmpty()) vm.log("! sign in first (Settings → Account & sync)") else { vm.log("↑ loading automations…"); apiCall("GET", "/v1/workflows", null, "flows") } },
        onRunFlow = { id, name -> runFlow(id, name) },
        onCreateFlow = { name, steps -> createFlow(name, steps) },
        onLoadPlatforms = { loadPlatforms() },
        onOpenPlatform = { prof, site -> shellUi.urlFocused.value = false; openPlatform(prof, site) },
        onOpenMenu = { shellUi.desktopMode.value = tabs.getOrNull(activeTab)?.desktop == true; shellUi.menuOpen.value = true },
        onCloseMenu = { shellUi.menuOpen.value = false },
        onBack = { if (this::web.isInitialized && web.canGoBack()) web.goBack() },
        onForward = { if (this::web.isInitialized && web.canGoForward()) web.goForward() },
        onReload = { if (this::web.isInitialized) web.reload() },
        onShare = { doShare() },
        onToggleDesktop = { toggleDesktop(); shellUi.desktopMode.value = tabs.getOrNull(activeTab)?.desktop == true },
        onFindInPage = { try { if (this::web.isInitialized) web.showFindDialog(null, true) } catch (e: Exception) { vm.log("! find in page unavailable") } },
        onOpenHub = { doOpenHub() },
    )

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
        settingsVisible.value = true
        settingsHost?.let { it.visibility = View.VISIBLE; it.bringToFront() }
        if (vm.clusterUrl.trim().isNotEmpty()) apiCall("GET", "/v1/device/list", null, "run_devices")
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
        settingsUi.endpoint = vm.endpoint; settingsUi.apiKey = vm.apiKey; settingsUi.ollamaModel = vm.model; settingsUi.hfToken = vm.hfToken
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

    private fun doOpenHub() {
        val base = vm.clusterUrl.trim().trimEnd('/')
        if (base.isEmpty()) { vm.log("! set the cluster URL first"); return }
        val k = vm.apiKey.trim()
        load(base + "/hub" + (if (k.isNotEmpty()) "#key=" + k else ""))
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
        onOpenHub = { doOpenHub() },
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
            settingsUi.endpoint = vm.endpoint; settingsUi.apiKey = vm.apiKey; settingsUi.ollamaModel = vm.model; settingsUi.hfToken = vm.hfToken
            vm.log("● endpoint saved")
        },
        onRefreshDevices = { if (vm.clusterUrl.trim().isNotEmpty()) apiCall("GET", "/v1/device/list", null, "run_devices") },
        onOpenTailscale = { doOpenTailscale() },
        onSetTheme = { m -> vm.themeMode = m; settingsUi.themeMode.value = m },
        onClearLog = { vm.clearLog() },
    )

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
                "registered" -> { vm.clusterOn.value = true; vm.clusterInfo.value = "Cluster: ON — registered as ${android.os.Build.MODEL}\nwaiting for commands"; vm.log("● registered with the cluster — waiting for commands") }
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
                    runStatus.value = "Running… (run $runId)"
                    if (runId.isNotBlank()) {
                        val h = android.os.Handler(mainLooper)
                        for (dl in listOf(6000L, 15000L, 30000L, 50000L, 75000L, 110000L))
                            h.postDelayed({ if (runVisible.value) apiCall("GET", "/v1/workflow-runs/$runId", null, "sheetstatus") }, dl)
                    }
                }
            } catch (e: Exception) { runPhase.value = "done"; runStatus.value = "! ${data.take(120)}" }
            "sheetrun_err" -> { runPhase.value = "done"; runStatus.value = "! ${data.take(140)}" }
            "sheetstatus" -> try {
                val o = JSONObject(data); val st = o.optString("status", "?")
                if (st != "running") { runPhase.value = "done"; runStatus.value = "Done — $st. See the log for what it did." }
                else runStatus.value = "Running…"
            } catch (e: Exception) { }
            "sheetstatus_err" -> { }
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
