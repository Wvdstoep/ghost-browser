package engineer.myapp.gbmobile

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
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
import fi.iki.elonen.NanoHTTPD
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * GB Mobile — Ghost Browser as a real on-device browser (MVVM). One shared WebView, two ways to drive
 * it: a STANDALONE on-device agent (your Ollama key) and CLUSTER mode (the backend drives it via the
 * GB API over the tailnet). Profiles give each identity its own isolated cookie jar.
 */
class MainActivity : AppCompatActivity(), Agent.DeviceBrowser, GbServer.Browser {

    private lateinit var b: ActivityMainBinding
    private val vm: GbViewModel by viewModels()

    private lateinit var web: WebView
    private var gbJs: String = ""
    @Volatile private var lastUrl: String = ""
    @Volatile private var loadLatch: CountDownLatch? = null

    private var server: GbServer? = null
    private var agentThread: Thread? = null
    @Volatile private var agentStop: Boolean = false
    private var pollThread: Thread? = null
    @Volatile private var pollStop: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        gbJs = try { assets.open("gb.js").bufferedReader().use { it.readText() } } catch (e: Exception) { "" }

        web = buildWebView(vm.currentProfile.value ?: "default")
        b.webHolder.addView(web)

        // top bar
        b.go.setOnClickListener { loadInBar() }
        b.home.setOnClickListener { load("file:///android_asset/home.html") }
        b.tools.setOnClickListener { b.panel.visibility = if (b.panel.visibility == View.GONE) View.VISIBLE else View.GONE }
        b.url.setOnEditorActionListener { _, id, ev ->
            if (id == EditorInfo.IME_ACTION_GO || (ev != null && ev.keyCode == KeyEvent.KEYCODE_ENTER && ev.action == KeyEvent.ACTION_DOWN)) { loadInBar(); true } else false
        }

        // tabs -> flipper
        b.tabs.addOnTabSelectedListener(object : TabLayout.OnTabSelectedListener {
            override fun onTabSelected(tab: TabLayout.Tab) { b.flipper.displayedChild = tab.position }
            override fun onTabUnselected(tab: TabLayout.Tab) {}
            override fun onTabReselected(tab: TabLayout.Tab) {}
        })

        wireAgent()
        wireProfiles()
        wireCluster()
        observe()

        load("file:///android_asset/home.html")
    }

    // ---- WebView (per-profile for isolated cookies) ----------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(profile: String): WebView {
        val w = WebView(this)
        // Attach an isolated profile BEFORE any load, if the platform WebView supports multi-profile.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            try {
                ProfileStore.getInstance().getOrCreateProfile(profile)
                WebViewCompat.setProfile(w, profile)
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
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true)
        w.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) { lastUrl = url ?: ""; b.url.setText(lastUrl) }
            override fun onPageFinished(view: WebView?, url: String?) {
                lastUrl = url ?: lastUrl
                if (gbJs.isNotEmpty()) view?.evaluateJavascript(gbJs, null)
                loadLatch?.countDown()
            }
        }
        w.webChromeClient = WebChromeClient()
        w.addJavascriptInterface(Bridge(), "GBHost")   // lets injected JS hand results back to the app
        w.layoutParams = android.view.ViewGroup.LayoutParams(-1, -1)
        return w
    }

    private fun loadInBar() = load(b.url.text.toString())

    private fun load(raw: String) {
        var u = raw.trim(); if (u.isEmpty()) return
        if (!u.startsWith("http") && !u.startsWith("file:")) {
            u = if (u.contains(".") && !u.contains(" ")) "https://$u" else "https://www.google.com/search?q=" + Uri.encode(u)
        }
        b.url.setText(u); web.loadUrl(u)
        b.panel.visibility = View.GONE   // collapse the tools sheet so the page is visible after navigating
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && this::web.isInitialized && web.canGoBack()) { web.goBack(); return true }
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

    // ---- Agent panel ----------------------------------------------------------------------------

    private fun wireAgent() {
        b.endpoint.setText(vm.endpoint); b.apiKey.setText(vm.apiKey); b.model.setText(vm.model); b.task.setText(vm.task)
        b.run.setOnClickListener {
            if (vm.agentRunning.value == true) { vm.log("… agent already running"); return@setOnClickListener }
            vm.endpoint = b.endpoint.text.toString(); vm.apiKey = b.apiKey.text.toString()
            vm.model = b.model.text.toString(); vm.task = b.task.text.toString()
            val goal = vm.task.trim()
            if (goal.isEmpty()) { vm.log("! enter a task first"); return@setOnClickListener }
            val llm = OllamaClient(vm.endpoint, vm.apiKey, vm.model)
            agentStop = false; vm.agentRunning.value = true; vm.log("▶ goal: $goal")
            agentThread = Thread {
                Agent(this, llm, { m -> vm.log(m) }, { agentStop }).run(goal)
                runOnUiThread { vm.agentRunning.value = false; vm.log("— agent finished —") }
            }.also { it.start() }
        }
        b.stop.setOnClickListener { agentStop = true; vm.log("… stopping") }
    }

    // ---- Profiles panel (isolated cookie jars) --------------------------------------------------

    private fun wireProfiles() {
        renderChips()
        b.addProfile.setOnClickListener {
            val name = b.newProfile.text.toString()
            if (name.isBlank()) return@setOnClickListener
            vm.addProfile(name); b.newProfile.setText("")
            renderChips(); switchProfile(vm.currentProfile.value ?: "default")
        }
    }

    private fun renderChips() {
        b.profileChips.removeAllViews()
        val cur = vm.currentProfile.value
        for (p in vm.profiles.value ?: emptyList()) {
            val chip = Chip(this).apply {
                text = p; isCheckable = true; isChecked = (p == cur)
                setOnClickListener { switchProfile(p) }
            }
            b.profileChips.addView(chip)
        }
        b.currentProfileLabel.text = "Active: ${vm.currentProfile.value}"
    }

    private fun switchProfile(name: String) {
        if (name == vm.currentProfile.value && this::web.isInitialized && web.parent != null) return
        vm.selectProfile(name)
        try { web.destroy() } catch (e: Exception) {}
        b.webHolder.removeAllViews()
        web = buildWebView(name)
        b.webHolder.addView(web)
        b.currentProfileLabel.text = "Active: $name"
        vm.log("↺ switched to profile \"$name\" (isolated cookies)")
        load("file:///android_asset/home.html")
    }

    // ---- Cluster panel --------------------------------------------------------------------------

    private fun wireCluster() {
        b.clusterUrl.setText(vm.clusterUrl)
        // Sign in to the cluster via SSO — GB Mobile is a real browser, so it does the my-app.engineer
        // login in its own WebView (passes SSO/Cloudflare), and the session cookie then authorizes API calls.
        b.signin.setOnClickListener {
            vm.clusterUrl = b.clusterUrl.text.toString().trim()
            // The GB tool page is SSO-only (no password there). You sign in on the PLATFORM and open
            // Ghost Browser from its Tools tab — so open the workspace, not the ghost-browser subdomain.
            val platform = if (vm.clusterUrl.contains("://ghost-browser."))
                vm.clusterUrl.replace("://ghost-browser.", "://") else "https://my-app.engineer"
            load(platform)
            vm.log("→ log in to my-app.engineer, open Ghost Browser from the Tools tab, then reopen ⚙ → Fetch profiles")
        }
        // Once signed in (WebView is on the cluster origin), a same-origin authed fetch pulls the profiles.
        b.fetchProfiles.setOnClickListener {
            val js = "fetch('/v1/profiles/presets',{credentials:'include'})" +
                ".then(function(r){return r.text()})" +
                ".then(function(t){GBHost.result('profiles',t)})" +
                ".catch(function(e){GBHost.result('error',String(e))})"
            web.evaluateJavascript(js, null)
            vm.log("↑ fetching cluster profiles…")
        }
        b.cluster.setOnClickListener {
            if (pollThread?.isAlive == true) {
                pollStop = true; vm.clusterOn.value = false; vm.clusterInfo.value = "Cluster: off"
            } else {
                vm.clusterUrl = b.clusterUrl.text.toString().trim()
                val cookies = try { CookieManager.getInstance().getCookie(vm.clusterUrl) ?: "" } catch (e: Exception) { "" }
                if (cookies.isBlank()) { vm.log("! not signed in — tap Sign in (SSO), open Ghost Browser from Tools, then Connect"); return@setOnClickListener }
                pollStop = false; vm.clusterOn.value = true
                vm.clusterInfo.value = "Cluster: connecting… device \"${android.os.Build.MODEL}\""
                val client = PollClient(
                    vm.clusterUrl, vm.deviceToken, android.os.Build.MODEL,
                    { try { CookieManager.getInstance().getCookie(vm.clusterUrl) ?: "" } catch (e: Exception) { "" } },
                    this, { screenshotPng() }, { m -> vm.log(m) }, { pollStop }
                )
                pollThread = Thread {
                    client.run()
                    runOnUiThread { vm.clusterOn.value = false; vm.clusterInfo.value = "Cluster: off" }
                }.also { it.start() }
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

    // JS -> app bridge: injected page code hands results back here (e.g. the fetched cluster profiles).
    inner class Bridge {
        @JavascriptInterface
        fun result(tag: String, data: String) { runOnUiThread { onBridge(tag, data) } }
    }

    private fun onBridge(tag: String, data: String) {
        when (tag) {
            "profiles" -> try {
                val arr = JSONObject(data).optJSONArray("presets") ?: JSONArray()
                vm.log("↓ cluster profiles (${arr.length()}):")
                for (i in 0 until arr.length()) {
                    val p = arr.getJSONObject(i)
                    val loggedIn = if (p.optBoolean("exists")) " [logged in]" else ""
                    vm.log("   • " + p.optString("label", p.optString("key")) + " — " + p.optString("site") + loggedIn)
                }
            } catch (e: Exception) { vm.log("! profiles parse failed (${e.message}); sign in first. ${data.take(100)}") }
            "error" -> vm.log("! fetch error: ${data.take(160)} — tap Sign in (SSO) first")
            else -> vm.log("$tag: ${data.take(160)}")
        }
    }

    override fun onDestroy() {
        agentStop = true; pollStop = true
        try { server?.stop() } catch (e: Exception) {}
        super.onDestroy()
    }
}
