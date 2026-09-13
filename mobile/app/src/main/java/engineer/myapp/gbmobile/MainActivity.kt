package engineer.myapp.gbmobile

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.os.Bundle
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText

/**
 * GB Mobile — prototype of Ghost Browser as a native app running a REAL on-device Chromium WebView.
 *
 * Why this exists: a browser on a VPS is detectable as automated (datacenter IP, virtual display,
 * DevTools control). Running on the actual phone gives a real residential IP, real device hardware
 * fingerprint, and real touch input — the things a server can never fake. This is the first scaffold:
 * an address bar + a full-screen WebView that presents as ordinary mobile Chrome. The agent-control
 * layer (evaluate JS, read the DOM, act) is a WebView.evaluateJavascript / JS-bridge hook to add next.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var urlBar: EditText

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        web = findViewById(R.id.web)
        urlBar = findViewById(R.id.url)
        val go = findViewById<Button>(R.id.go)

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
        // Present as real mobile Chrome. The default WebView UA contains "; wv", which is itself a
        // detection signal; strip it so we look like the ordinary Chrome the device already is.
        s.userAgentString = s.userAgentString.replace("; wv", "")

        // Cookies (incl. third-party) matter: Cloudflare's clearance cookie must persist or a
        // challenge loops forever.
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

        web.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                urlBar.setText(url ?: "")
            }
        }
        web.webChromeClient = WebChromeClient()

        go.setOnClickListener { load(urlBar.text.toString()) }
        urlBar.setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_GO ||
                (event != null && event.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN)) {
                load(urlBar.text.toString()); true
            } else false
        }

        val start = intent?.dataString ?: "https://dashboard.rapyd.net/sign-up"
        urlBar.setText(start)
        load(start)
    }

    private fun load(raw: String) {
        var u = raw.trim()
        if (u.isEmpty()) return
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "https://$u"
        web.loadUrl(u)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && this::web.isInitialized && web.canGoBack()) {
            web.goBack(); return true
        }
        return super.onKeyDown(keyCode, event)
    }
}
