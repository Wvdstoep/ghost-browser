package engineer.myapp.gbmobile

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.ScrollView
import android.widget.TextView
import fi.iki.elonen.NanoHTTPD
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * GB Mobile — Ghost Browser as a real on-device browser. Two ways to drive it, sharing one WebView:
 *   1) STANDALONE — an on-device agent (perceive/act loop) that runs on YOUR Ollama key, no cluster.
 *   2) CLUSTER — expose the GB API so the hosted backend/master can drive this phone for a hunt.
 * Either way the browsing happens on the real device: real IP, real hardware — it beats detection.
 */
class MainActivity : Activity(), Agent.DeviceBrowser, GbServer.Browser {

    private lateinit var web: WebView
    private lateinit var urlBar: EditText
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var panel: View

    private var gbJs: String = ""
    @Volatile private var lastUrl: String = ""
    @Volatile private var loadLatch: CountDownLatch? = null

    private var server: GbServer? = null
    private var agentThread: Thread? = null
    @Volatile private var agentStop: Boolean = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        web = findViewById(R.id.web)
        urlBar = findViewById(R.id.url)
        logView = findViewById(R.id.log)
        logScroll = findViewById(R.id.logScroll)
        panel = findViewById(R.id.panel)

        gbJs = try { assets.open("gb.js").bufferedReader().use { it.readText() } } catch (e: Exception) { "" }

        val s = web.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.databaseEnabled = true
        s.loadWithOverviewMode = true
        s.useWideViewPort = true
        s.setSupportZoom(true)
        s.builtInZoomControls = true
        s.displayZoomControls = false
        s.mediaPlaybackRequiresUserGesture = false
        s.userAgentString = s.userAgentString.replace("; wv", "")   // present as real mobile Chrome
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

        web.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                lastUrl = url ?: ""; urlBar.setText(lastUrl)
            }
            override fun onPageFinished(view: WebView?, url: String?) {
                lastUrl = url ?: lastUrl
                if (gbJs.isNotEmpty()) view?.evaluateJavascript(gbJs, null)   // ensure perceive/act is present
                loadLatch?.countDown()
            }
        }
        web.webChromeClient = WebChromeClient()

        findViewById<Button>(R.id.go).setOnClickListener { loadInBar() }
        findViewById<Button>(R.id.home).setOnClickListener { load("file:///android_asset/home.html") }
        findViewById<Button>(R.id.tools).setOnClickListener {
            panel.visibility = if (panel.visibility == View.GONE) View.VISIBLE else View.GONE
        }
        urlBar.setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_GO ||
                (event != null && event.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN)) {
                loadInBar(); true
            } else false
        }

        wireAgentPanel()
        wireClusterPanel()

        load("file:///android_asset/home.html")
    }

    // ---- browser plumbing -----------------------------------------------------------------------

    private fun loadInBar() = load(urlBar.text.toString())

    private fun load(raw: String) {
        var u = raw.trim()
        if (u.isEmpty()) return
        if (!u.startsWith("http") && !u.startsWith("file:")) u = "https://$u"
        urlBar.setText(u); web.loadUrl(u)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && this::web.isInitialized && web.canGoBack()) { web.goBack(); return true }
        return super.onKeyDown(keyCode, event)
    }

    // ---- Agent.DeviceBrowser + GbServer.Browser (called off the UI thread) -----------------------

    override fun navigate(url: String): String {
        var u = url.trim(); if (u.isEmpty()) return currentUrl()
        if (!u.startsWith("http") && !u.startsWith("file:")) u = "https://$u"
        val latch = CountDownLatch(1); loadLatch = latch
        val fu = u
        runOnUiThread { urlBar.setText(fu); web.loadUrl(fu) }
        latch.await(25, TimeUnit.SECONDS)
        Thread.sleep(400)
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

    // ---- standalone agent panel -----------------------------------------------------------------

    private fun wireAgentPanel() {
        val sp = getSharedPreferences("gb", MODE_PRIVATE)
        val endpoint = findViewById<EditText>(R.id.endpoint)
        val key = findViewById<EditText>(R.id.key)
        val model = findViewById<EditText>(R.id.model)
        val task = findViewById<EditText>(R.id.task)
        endpoint.setText(sp.getString("endpoint", ""))
        key.setText(sp.getString("key", ""))
        model.setText(sp.getString("model", "glm-4"))

        findViewById<Button>(R.id.run).setOnClickListener {
            if (agentThread?.isAlive == true) { appendLog("… agent already running"); return@setOnClickListener }
            sp.edit().putString("endpoint", endpoint.text.toString())
                .putString("key", key.text.toString())
                .putString("model", model.text.toString()).apply()
            val goal = task.text.toString().trim()
            if (goal.isEmpty()) { appendLog("! enter a task first"); return@setOnClickListener }
            val llm = OllamaClient(endpoint.text.toString(), key.text.toString(), model.text.toString())
            agentStop = false
            appendLog("▶ goal: $goal")
            agentThread = Thread {
                Agent(this, llm, { m -> runOnUiThread { appendLog(m) } }, { agentStop }).run(goal)
                runOnUiThread { appendLog("— agent finished —") }
            }.also { it.start() }
        }
        findViewById<Button>(R.id.stop).setOnClickListener { agentStop = true; appendLog("… stopping") }
    }

    private fun appendLog(line: String) {
        logView.append(line + "\n")
        logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
    }

    // ---- cluster connect (backend drives this device) -------------------------------------------

    private fun wireClusterPanel() {
        val status = findViewById<TextView>(R.id.clusterStatus)
        val btn = findViewById<Button>(R.id.cluster)
        btn.setOnClickListener {
            if (server == null) {
                val token = apiToken()
                try {
                    server = GbServer(8471, token, this).apply { start(NanoHTTPD.SOCKET_READ_TIMEOUT, false) }
                    status.text = "Cluster: ON — GB API on :8471\ntoken: $token\nJoin this device to the tailnet; the backend can then drive it."
                    btn.text = "Disconnect"
                } catch (e: Exception) { status.text = "Cluster: failed — ${e.message}" }
            } else {
                server?.stop(); server = null
                status.text = "Cluster: off"; btn.text = "Connect to cluster"
            }
        }
    }

    private fun apiToken(): String {
        val sp = getSharedPreferences("gb", MODE_PRIVATE)
        var t = sp.getString("token", null)
        if (t == null) { t = UUID.randomUUID().toString().replace("-", "").substring(0, 24); sp.edit().putString("token", t).apply() }
        return t
    }

    override fun onDestroy() {
        agentStop = true
        try { server?.stop() } catch (e: Exception) {}
        super.onDestroy()
    }
}
