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
    private val fetchWaiters = java.util.concurrent.ConcurrentHashMap<String, CountDownLatch>()
    private val fetchResults = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val models by lazy { ModelManager(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        gbJs = try { assets.open("gb.js").bufferedReader().use { it.readText() } } catch (e: Exception) { "" }
        gbControlJs = try { assets.open("gb-control.js").bufferedReader().use { it.readText() } } catch (e: Exception) { "" }

        restoreTabs()

        // Chrome-like top bar
        b.home.setOnClickListener { load(HOME) }
        b.newTab.setOnClickListener { newTab() }
        b.tabCount.setOnClickListener { openSwitcher() }
        b.menuBtn.setOnClickListener { showMenu() }
        b.url.setOnEditorActionListener { _, id, ev ->
            if (id == EditorInfo.IME_ACTION_GO || (ev != null && ev.keyCode == KeyEvent.KEYCODE_ENTER && ev.action == KeyEvent.ACTION_DOWN)) { loadInBar(); true } else false
        }

        // tab switcher overlay
        b.newTabInSwitcher.setOnClickListener { newTab(); closeSwitcher() }
        b.closeSwitcher.setOnClickListener { closeSwitcher() }

        // tabs -> flipper
        b.tabs.addOnTabSelectedListener(object : TabLayout.OnTabSelectedListener {
            override fun onTabSelected(tab: TabLayout.Tab) { b.flipper.displayedChild = tab.position }
            override fun onTabUnselected(tab: TabLayout.Tab) {}
            override fun onTabReselected(tab: TabLayout.Tab) {}
        })

        wireAgent()
        wireProfiles()
        wireFlows()
        wireCluster()
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
        b.webHolder.removeAllViews()
        b.webHolder.addView(w)
        web = w; activeTab = i
        lastUrl = h.url
        if (h.profile != (vm.currentProfile.value ?: "default")) { vm.selectProfile(h.profile); renderChips() }
        b.url.setText(if (h.url == HOME) "" else h.url)
        updateTabCount()
    }

    private fun newTab(url: String = HOME, activate: Boolean = true) {
        val prof = vm.currentProfile.value ?: "default"
        tabs.add(TabHandle(url, if (url == HOME) "New tab" else url, prof))
        if (activate) activateTab(tabs.size - 1) else updateTabCount()
        b.panel.visibility = View.GONE
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
        if (b.tabSwitcher.visibility == View.VISIBLE) renderTabList()
    }

    private fun updateTabCount() { b.tabCount.text = if (tabs.size > 99) "99" else tabs.size.toString() }

    private fun showMenu() {
        val pm = PopupMenu(this, b.menuBtn)
        val desk = tabs.getOrNull(activeTab)?.desktop == true
        pm.menu.add(0, 1, 0, "Tools · Agent · Profiles · Flows · Cluster")
        pm.menu.add(0, 2, 1, "New tab")
        pm.menu.add(0, 3, 2, "Reload")
        pm.menu.add(0, 5, 3, if (desk) "Request mobile site" else "Request desktop site")
        pm.menu.add(0, 4, 4, "Close this tab")
        pm.setOnMenuItemClickListener {
            when (it.itemId) {
                1 -> b.panel.visibility = if (b.panel.visibility == View.GONE) View.VISIBLE else View.GONE
                2 -> newTab()
                3 -> if (this::web.isInitialized) web.reload()
                4 -> closeTab(activeTab)
                5 -> toggleDesktop()
            }
            true
        }
        pm.show()
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

    // ---- tab switcher -----------------------------------------------------------------------------

    private fun openSwitcher() { renderTabList(); b.tabSwitcher.visibility = View.VISIBLE }
    private fun closeSwitcher() { b.tabSwitcher.visibility = View.GONE }

    private fun renderTabList() {
        b.tabList.removeAllViews()
        fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
        for (idx in tabs.indices) {
            val h = tabs[idx]
            val active = idx == activeTab
            val row = android.widget.LinearLayout(this).apply {
                orientation = android.widget.LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(14), dp(13), dp(8), dp(13))
                background = getDrawable(R.drawable.bg_card_ripple)
                val lp = android.widget.LinearLayout.LayoutParams(-1, -2); lp.bottomMargin = dp(10); layoutParams = lp
            }
            val col = android.widget.LinearLayout(this).apply {
                orientation = android.widget.LinearLayout.VERTICAL
                layoutParams = android.widget.LinearLayout.LayoutParams(0, -2, 1f)
            }
            col.addView(android.widget.TextView(this).apply {
                text = if (h.title.isBlank()) "New tab" else h.title
                setTextColor(getColor(if (active) R.color.accent else R.color.text)); textSize = 15f
                typeface = resources.getFont(R.font.manrope_bold); maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
            })
            col.addView(android.widget.TextView(this).apply {
                text = hostLabel(h.url) + (if (h.profile != "default") "  ·  ${h.profile}" else "")
                setTextColor(getColor(R.color.muted)); textSize = 12f
                typeface = resources.getFont(R.font.manrope_regular); maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                setPadding(0, dp(2), 0, 0)
            })
            row.addView(col)
            row.addView(android.widget.ImageButton(this).apply {
                setImageResource(R.drawable.ic_close); setColorFilter(getColor(R.color.muted))
                background = getDrawable(R.drawable.bg_icon_ripple)
                layoutParams = android.widget.LinearLayout.LayoutParams(dp(38), dp(38))
                setPadding(dp(9), dp(9), dp(9), dp(9))
                setOnClickListener { closeTab(idx) }
            })
            row.setOnClickListener { activateTab(idx); closeSwitcher() }
            b.tabList.addView(row)
        }
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
                if (isActive(h)) { lastUrl = h.url; b.url.setText(if (h.url == HOME) "" else h.url) }
            }
            override fun onPageFinished(view: WebView?, url: String?) {
                h.url = url ?: h.url
                if (isActive(h)) lastUrl = h.url
                if (gbJs.isNotEmpty()) view?.evaluateJavascript(gbJs, null)
                loadLatch?.countDown()
                if (b.tabSwitcher.visibility == View.VISIBLE) renderTabList()
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView?, title: String?) {
                if (!title.isNullOrBlank()) h.title = title
                if (b.tabSwitcher.visibility == View.VISIBLE) renderTabList()
            }
        }
        w.addJavascriptInterface(Bridge(), "GBHost")   // lets injected JS hand results back to the app
        w.layoutParams = ViewGroup.LayoutParams(-1, -1)
        return w
    }

    private fun loadInBar() = load(b.url.text.toString())

    private fun load(raw: String) {
        var u = raw.trim(); if (u.isEmpty()) return
        if (!u.startsWith("http") && !u.startsWith("file:")) {
            u = if (u.contains(".") && !u.contains(" ")) "https://$u" else "https://www.google.com/search?q=" + Uri.encode(u)
        }
        b.url.setText(if (u == HOME) "" else u)
        if (this::web.isInitialized) web.loadUrl(u)
        b.panel.visibility = View.GONE
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (b.tabSwitcher.visibility == View.VISIBLE) { closeSwitcher(); return true }
            if (b.panel.visibility == View.VISIBLE) { b.panel.visibility = View.GONE; return true }
            if (this::web.isInitialized && web.canGoBack()) { web.goBack(); return true }
        }
        return super.onKeyDown(keyCode, event)
    }

    // ---- Agent.DeviceBrowser + GbServer.Browser (off the UI thread) ------------------------------

    override fun navigate(url: String): String {
        var u = url.trim(); if (u.isEmpty()) return currentUrl()
        if (!u.startsWith("http") && !u.startsWith("file:")) u = "https://$u"
        val latch = CountDownLatch(1); loadLatch = latch
        val fu = u
        runOnUiThread { b.url.setText(fu); web.loadUrl(fu) }
        latch.await(25, TimeUnit.SECONDS); Thread.sleep(400)
        return currentUrl()
    }

    override fun evalGb(expr: String): String = evalJs(gbJs + "\n" + expr)
    override fun currentUrl(): String = lastUrl

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

    // ---- Agent panel ----------------------------------------------------------------------------

    private fun wireAgent() {
        b.endpoint.setText(vm.endpoint); b.apiKey.setText(vm.apiKey); b.model.setText(vm.model); b.task.setText(vm.task)
        b.customUrl.setText(vm.customUrl); b.useLocal.isChecked = vm.useLocal

        val labels = ModelCatalog.models.map { it.label }
        b.modelSpinner.adapter = android.widget.ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, labels)
        b.modelSpinner.setSelection(ModelCatalog.models.indexOfFirst { it.id == vm.selectedModel }.coerceAtLeast(0))
        fun selModel() = ModelCatalog.models[b.modelSpinner.selectedItemPosition]
        fun refreshModel() {
            val m = selModel(); vm.selectedModel = m.id
            b.modelNote.text = m.note
            b.modelStatus.text = if (models.isReady(m.id)) "ready ✓" else "not downloaded"
        }
        b.modelSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: android.widget.AdapterView<*>?, v: View?, pos: Int, id: Long) = refreshModel()
            override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
        }
        refreshModel()

        b.downloadModel.setOnClickListener {
            val m = selModel(); vm.customUrl = b.customUrl.text.toString().trim()
            if (models.isReady(m.id) && m.id != "custom") { b.modelStatus.text = "ready ✓"; vm.log("● ${m.label} already downloaded"); return@setOnClickListener }
            val url = if (m.id == "custom") vm.customUrl else m.url
            if (url.isBlank()) { vm.log("! paste a .task URL for the Custom option"); return@setOnClickListener }
            b.modelProgress.visibility = View.VISIBLE; b.modelProgress.progress = 0
            b.modelStatus.text = "downloading…"; b.downloadModel.isEnabled = false
            vm.log("↓ downloading ${m.label}…")
            models.download(m.id, url, m.sizeMb, b.hfToken.text.toString(),
                { p -> runOnUiThread { b.modelProgress.progress = p; b.modelStatus.text = "downloading… $p%" } },
                { ok, msg -> runOnUiThread {
                    b.downloadModel.isEnabled = true; b.modelProgress.visibility = View.GONE
                    if (ok) { b.modelStatus.text = "ready ✓"; vm.log("● model ${m.label} ready — tick 'Use on-device model'") }
                    else { b.modelStatus.text = "failed"; vm.log("! model download: $msg") }
                } })
        }

        b.run.setOnClickListener {
            if (vm.agentRunning.value == true) { vm.log("… agent already running"); return@setOnClickListener }
            vm.endpoint = b.endpoint.text.toString(); vm.apiKey = b.apiKey.text.toString()
            vm.model = b.model.text.toString(); vm.task = b.task.text.toString()
            vm.useLocal = b.useLocal.isChecked; vm.selectedModel = selModel().id
            val goal = vm.task.trim()
            if (goal.isEmpty()) { vm.log("! enter a task first"); return@setOnClickListener }
            val brain: Llm = if (vm.useLocal) {
                if (!models.isReady(vm.selectedModel)) { vm.log("! on-device model not downloaded — tap Download first"); return@setOnClickListener }
                vm.log("▶ brain: on-device (${vm.selectedModel})"); LocalLlm(this, models.path(vm.selectedModel), ModelCatalog.byId(vm.selectedModel).family)
            } else {
                if (vm.endpoint.isBlank()) { vm.log("! set an Ollama endpoint, or tick 'Use on-device model'"); return@setOnClickListener }
                vm.log("▶ brain: Ollama (${vm.model})"); OllamaClient(vm.endpoint, vm.apiKey, vm.model)
            }
            agentStop = false; vm.agentRunning.value = true; vm.log("▶ goal: $goal")
            agentThread = Thread {
                Agent(this, brain, { m -> vm.log(m) }, { agentStop }).run(goal)
                runOnUiThread { vm.agentRunning.value = false; vm.log("— agent finished —") }
            }.also { it.start() }
        }
        b.stop.setOnClickListener { agentStop = true; vm.log("… stopping") }
    }

    // ---- Profiles panel -------------------------------------------------------------------------

    private fun wireProfiles() {
        renderChips()
        b.addProfile.setOnClickListener {
            val name = b.newProfile.text.toString()
            if (name.isBlank()) return@setOnClickListener
            vm.addProfile(name); b.newProfile.setText("")
            renderChips(); newTab()
        }
        b.loadPlatforms.setOnClickListener { loadPlatforms() }
        // show the last fetched platforms immediately (persisted), so they don't vanish on relaunch
        if (vm.platformsJson.isNotBlank()) try { renderPlatforms(JSONObject(vm.platformsJson).optJSONArray("presets") ?: JSONArray()) } catch (e: Exception) {}
    }

    private fun renderChips() {
        b.profileChips.removeAllViews()
        val cur = vm.currentProfile.value
        for (p in vm.profiles.value ?: emptyList()) {
            val chip = Chip(this).apply {
                text = p; isCheckable = true; isChecked = (p == cur)
                setOnClickListener { vm.selectProfile(p); renderChips(); newTab() }
            }
            b.profileChips.addView(chip)
        }
        b.currentProfileLabel.text = "Active: ${vm.currentProfile.value}"
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

    // ---- "Your platforms" — mirror the cluster's platform list; sign in once per platform on-device --

    private fun loadPlatforms() {
        if (vm.clusterUrl.trim().isEmpty()) { vm.log("! set the cluster URL on the Cluster tab first"); return }
        b.platformsHint.text = "loading…"
        apiCall("GET", "/v1/profiles/presets", null, "platforms")
    }

    private fun renderPlatforms(arr: JSONArray) {
        b.platformCards.removeAllViews()
        if (arr.length() == 0) { b.platformsHint.text = "no platforms on the cluster yet"; return }
        b.platformsHint.text = "${arr.length()} platforms — tap to open & sign in here"
        val known = (vm.profiles.value ?: emptyList()).toSet()
        for (i in 0 until arr.length()) {
            val p = arr.optJSONObject(i) ?: continue
            val key = p.optString("key")
            val label = p.optString("label", key).ifBlank { key }
            val site = p.optString("site")
            if (key.isBlank() || site.isBlank()) continue
            val prof = "p_" + key.lowercase().replace(Regex("[^a-z0-9_-]"), "")
            // "signed in" ONLY if this phone's profile actually holds a session cookie for the site —
            // not merely because the profile exists (the phone is a separate browser from the cluster).
            val signedIn = known.contains(prof) && profileHasSession(prof, site)
            b.platformCards.addView(platformCard(label, site, prof, signedIn))
        }
    }

    private fun profileHasSession(prof: String, site: String): Boolean {
        return try {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return false
            val cm = ProfileStore.getInstance().getOrCreateProfile(prof).cookieManager
            (cm.getCookie(site) ?: "").isNotBlank()
        } catch (e: Exception) { false }
    }

    private fun platformCard(label: String, site: String, prof: String, onPhone: Boolean): View {
        fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
        val row = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(12), dp(12), dp(12))
            background = getDrawable(R.drawable.bg_card_ripple)
            val lp = android.widget.LinearLayout.LayoutParams(-1, -2); lp.bottomMargin = dp(10); layoutParams = lp
            setOnClickListener { openPlatform(prof, site) }
        }
        val col = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            layoutParams = android.widget.LinearLayout.LayoutParams(0, -2, 1f)
        }
        col.addView(android.widget.TextView(this).apply {
            text = label; setTextColor(getColor(R.color.text)); textSize = 15f
            typeface = resources.getFont(R.font.manrope_bold)
        })
        val host = try { Uri.parse(site).host ?: site } catch (e: Exception) { site }
        col.addView(android.widget.TextView(this).apply {
            text = host + (if (onPhone) "   ·  signed in ✓" else "   ·  not signed in yet")
            setTextColor(getColor(if (onPhone) R.color.accent else R.color.muted)); textSize = 12f
            typeface = resources.getFont(R.font.manrope_regular); setPadding(0, dp(2), 0, 0)
        })
        row.addView(col)
        row.addView(com.google.android.material.button.MaterialButton(
            this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle
        ).apply {
            text = if (onPhone) "Open" else "Open & sign in"
            isAllCaps = false
            typeface = resources.getFont(R.font.manrope_semibold)
            setOnClickListener { openPlatform(prof, site) }
        })
        return row
    }

    private fun openPlatform(prof: String, site: String) {
        vm.addProfile(prof)              // creates it if new and selects it
        renderChips()
        val host = try { Uri.parse(site).host } catch (e: Exception) { null }
        val existing = tabs.indexOfFirst { it.profile == prof && host != null && (try { Uri.parse(it.url).host } catch (e: Exception) { null }) == host }
        if (existing >= 0) {             // don't spawn duplicates — focus the platform's own tab
            activateTab(existing); b.panel.visibility = View.GONE
            vm.log("↺ switched to the \"$prof\" tab for $host")
        } else {
            newTab(site)                 // open a new tab in this platform's isolated profile
            vm.log("→ opened \"$prof\" — sign in once here; the session stays in this profile")
        }
    }

    // ---- Flows panel (automations — the same workflow engine GB runs) ---------------------------

    private fun wireFlows() {
        b.loadFlows.setOnClickListener {
            if (vm.clusterUrl.trim().isEmpty()) { vm.log("! set the cluster URL on the Cluster tab first"); return@setOnClickListener }
            b.flowsHint.text = "loading…"; apiCall("GET", "/v1/workflows", null, "flows")
        }
        b.createFlow.setOnClickListener { createFlow() }
        // show the last fetched automations immediately (persisted)
        if (vm.flowsJson.isNotBlank()) try { renderFlows(JSONObject(vm.flowsJson).optJSONArray("workflows") ?: JSONArray()) } catch (e: Exception) {}
    }

    private fun renderFlows(arr: JSONArray) {
        b.flowCards.removeAllViews()
        if (arr.length() == 0) { b.flowsHint.text = "no automations yet — build one below"; return }
        b.flowsHint.text = "${arr.length()} automations — tap Run to fire one"
        for (i in 0 until arr.length()) {
            val w = arr.optJSONObject(i) ?: continue
            val id = w.optString("id"); if (id.isBlank()) continue
            val name = w.optString("name", id)
            val steps = w.optJSONArray("nodes")?.length() ?: w.optInt("nodes", 0)
            val last = w.optString("lastRunStatus", "").ifBlank { "never run" }
            b.flowCards.addView(flowCard(id, name, steps, last))
        }
    }

    private fun flowCard(id: String, name: String, steps: Int, last: String): View {
        fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
        val row = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(12), dp(12), dp(12))
            background = getDrawable(R.drawable.bg_card)
            val lp = android.widget.LinearLayout.LayoutParams(-1, -2); lp.bottomMargin = dp(10); layoutParams = lp
        }
        val col = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            layoutParams = android.widget.LinearLayout.LayoutParams(0, -2, 1f)
        }
        col.addView(android.widget.TextView(this).apply {
            text = name; setTextColor(getColor(R.color.text)); textSize = 15f
            typeface = resources.getFont(R.font.manrope_bold)
        })
        col.addView(android.widget.TextView(this).apply {
            text = "$steps steps  ·  $last"
            setTextColor(getColor(R.color.muted)); textSize = 12f
            typeface = resources.getFont(R.font.manrope_regular); setPadding(0, dp(2), 0, 0)
        })
        row.addView(col)
        row.addView(com.google.android.material.button.MaterialButton(
            this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle
        ).apply {
            text = "Run"; isAllCaps = false
            typeface = resources.getFont(R.font.manrope_semibold)
            setOnClickListener { runFlow(id, name) }
        })
        return row
    }

    private fun runFlow(id: String, name: String) {
        vm.log("▶ running automation \"$name\"…")
        apiCall("POST", "/v1/workflows/$id/run", "{}", "flowrun")
    }

    private fun createFlow() {
        val name = b.flowName.text.toString().trim()
        val stepLines = b.flowSteps.text.toString().split("\n").map { it.trim() }.filter { it.isNotEmpty() }
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

    // ---- Cluster panel --------------------------------------------------------------------------

    private fun wireCluster() {
        b.clusterUrl.setText(vm.clusterUrl)
        b.signin.setOnClickListener {
            vm.clusterUrl = b.clusterUrl.text.toString().trim()
            val platform = if (vm.clusterUrl.contains("://ghost-browser."))
                vm.clusterUrl.replace("://ghost-browser.", "://") else "https://my-app.engineer"
            load(platform)
            vm.log("→ log in to my-app.engineer, open Ghost Browser from the Tools tab, then reopen ⚙ → Fetch")
        }
        b.fetchProfiles.setOnClickListener {
            val js = "fetch('/v1/profiles/presets',{credentials:'include'})" +
                ".then(function(r){return r.text()})" +
                ".then(function(t){GBHost.result('profiles',t)})" +
                ".catch(function(e){GBHost.result('error',String(e))})"
            web.evaluateJavascript(js, null)
            vm.log("↑ fetching cluster profiles…")
        }
        b.cluster.setOnClickListener {
            if (ctrlWeb != null) {
                stopControlWeb(); vm.clusterOn.value = false; vm.clusterInfo.value = "Cluster: off"
                try { stopService(Intent(this, GbService::class.java)) } catch (e: Exception) {}
            } else {
                vm.clusterUrl = b.clusterUrl.text.toString().trim()
                val cookies = cookiesFor(vm.clusterUrl)
                if (cookies.isBlank()) { vm.log("! not signed in — tap Sign in, open Ghost Browser from Tools, then Connect"); return@setOnClickListener }
                vm.clusterInfo.value = "Cluster: connecting…"; vm.log("→ connecting (control channel on the GB origin)…")
                startControlWeb()
                try { androidx.core.content.ContextCompat.startForegroundService(this, Intent(this, GbService::class.java)) } catch (e: Exception) {}
            }
        }
        b.tailscaleBtn.setOnClickListener {
            val pkg = "com.tailscale.ipn"
            val i = packageManager.getLaunchIntentForPackage(pkg)
                ?: Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$pkg"))
            try { startActivity(i) } catch (e: Exception) { vm.log("! could not open Tailscale: ${e.message}") }
        }
    }

    // ---- observers ------------------------------------------------------------------------------

    private fun observe() {
        vm.logText.observe(this) { t -> b.log.text = t; b.logScroll.post { b.logScroll.fullScroll(View.FOCUS_DOWN) } }
        vm.clusterInfo.observe(this) { t ->
            b.clusterStatus.text = t
            b.cluster.text = if (vm.clusterOn.value == true) "Disconnect" else "Connect to cluster"
        }
        vm.agentRunning.observe(this) { running -> b.run.isEnabled = !running }
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
                        "/v1/content" -> evalGb("window.__gb.text()")
                        "/v1/click" -> evalGb("window.__gb.click(${body.optInt("index", -1)})")
                        "/v1/type" -> evalGb("window.__gb.type(${body.optInt("index", -1)}," + JSONObject.quote(body.optString("text")) + ")")
                        "/v1/scroll" -> evalGb("window.__gb.scroll(${body.optInt("dy", 600)})")
                        "/v1/screenshot" -> "{\"png_base64\":\"" + android.util.Base64.encodeToString(screenshotPng(), android.util.Base64.NO_WRAP) + "\"}"
                        "/v1/fetch" -> fetchInPage(body)
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
        when (tag) {
            "platforms" -> {
                try {
                    val arr = JSONObject(data).optJSONArray("presets") ?: JSONArray()
                    renderPlatforms(arr)
                    vm.platformsJson = data   // persist so it survives relaunch
                    vm.log("↓ your platforms (${arr.length()}) — tap one to open & sign in on this phone")
                } catch (e: Exception) {
                    b.platformsHint.text = "sign in on the Cluster tab first"
                    vm.log("! could not read platforms — sign in via the Cluster tab (SSO), then Load. ${data.take(80)}")
                }
            }
            "platforms_err" -> { b.platformsHint.text = "sign in on the Cluster tab first"; vm.log("! load platforms: ${data.take(140)}") }
            "flows" -> {
                try {
                    val arr = JSONObject(data).optJSONArray("workflows") ?: JSONArray()
                    renderFlows(arr)
                    vm.flowsJson = data       // persist so it survives relaunch
                    vm.log("↓ automations (${arr.length()})")
                } catch (e: Exception) {
                    b.flowsHint.text = "sign in on the Cluster tab first"
                    vm.log("! could not read automations — sign in via the Cluster tab (SSO), then Load. ${data.take(80)}")
                }
            }
            "flows_err" -> { b.flowsHint.text = "sign in on the Cluster tab first"; vm.log("! load automations: ${data.take(140)}") }
            "flowrun" -> try {
                val o = JSONObject(data); val runId = o.optString("runId")
                vm.log("● automation started (run $runId) — ${o.optString("status", "running")}")
                if (runId.isNotBlank()) {
                    val h = android.os.Handler(mainLooper)
                    for (d in listOf(6000L, 15000L, 30000L)) { h.postDelayed({ apiCall("GET", "/v1/workflow-runs/$runId", null, "flowrunstatus") }, d) }
                }
            } catch (e: Exception) { vm.log("! run: ${data.take(160)}") }
            "flowrun_err" -> vm.log("! run automation: ${data.take(140)}")
            "flowrunstatus" -> try {
                val o = JSONObject(data)
                vm.log("· run ${o.optString("id")}: ${o.optString("status", "?")}" + (o.optString("outcome", "").let { if (it.isNotBlank()) " — $it" else "" }))
            } catch (e: Exception) {}
            "flowcreate" -> try {
                val o = JSONObject(data)
                if (o.has("error")) vm.log("! create automation: ${o.optString("error")}")
                else { vm.log("✓ automation created: ${o.optString("name", o.optString("id"))}"); b.flowName.setText(""); b.flowSteps.setText(""); apiCall("GET", "/v1/workflows", null, "flows") }
            } catch (e: Exception) { vm.log("! create: ${data.take(160)}") }
            "flowcreate_err" -> vm.log("! create automation: ${data.take(140)}")
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
        try { server?.stop() } catch (e: Exception) {}
        super.onDestroy()
    }
}
