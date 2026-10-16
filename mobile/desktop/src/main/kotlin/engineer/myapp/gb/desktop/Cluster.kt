package engineer.myapp.gb.desktop

import org.cef.browser.CefBrowser

/**
 * The desktop's authed cluster client. Every read/write rides the SSO session in the hidden control
 * browser on the GB origin (same session the node registers with), so the desktop app talks to the
 * cluster exactly like the phone does — no API keys pasted, one account.
 *
 * The control browser is loaded at startup BEFORE sign-in, so GB redirects it to the my-app login page;
 * [ensureOnCluster] brings it back to the GB origin (where it is authed after sign-in) before each call,
 * so relative fetches always hit GB — this is what makes registration/poll work automatically.
 */
object Cluster {
    @Volatile var control: CefBrowser? = null
    @Volatile var clusterUrl = "https://ghost-browser.mavicpro-fan.my-app.engineer"
    @Volatile var connected = false

    private fun origin(): String = clusterUrl.trimEnd('/')

    /* Where the chosen instance is remembered between starts, beside the Chromium cache. */
    private val file = java.io.File(System.getProperty("user.home"), ".ghostbrowser/cluster.txt")
    private val instance = Regex("^https?://[a-zA-Z0-9.-]+(:[0-9]+)?$")

    /** The instance remembered from last time, if any; otherwise the one built in. */
    fun load(): String {
        try { val s = file.readText().trim(); if (instance.matches(s)) clusterUrl = s } catch (e: Exception) { /* first run */ }
        return clusterUrl
    }

    /**
     * A page loaded somewhere in the app. If it is a Ghost Browser instance and not the one the
     * control browser sits on, that is the person's instance: switch to it, remember it, and put the
     * control browser on it so registration rides the session they just signed into.
     */
    fun noticeOrigin(url: String) {
        if (url.isBlank()) return
        val o = try { val u = java.net.URI(url); if ((u.scheme != "https" && u.scheme != "http") || u.host == null) return; u.scheme + "://" + u.host + (if (u.port > 0 && u.port != 80 && u.port != 443) ":" + u.port else "") } catch (e: Exception) { return }
        if (!instance.matches(o) || o == origin()) return
        clusterUrl = o
        connected = false
        try { file.parentFile?.mkdirs(); file.writeText(o) } catch (e: Exception) { /* remembered next time */ }
        try { control?.loadURL(controlUrl()) } catch (e: Exception) { /* ensureOnCluster does it before the next call */ }
    }

    /** The lightest page on the cluster's origin: a JSON answer, no canvas, no scripts. */
    fun controlUrl(): String = origin() + "/api/auth/state"

    /** Make sure the control browser is sitting on the GB origin (not the login page) before we fetch. */
    fun ensureOnCluster() {
        val c = control ?: return
        try {
            val cur = c.url ?: ""
            if (!cur.startsWith(origin())) { c.loadURL(controlUrl()); Thread.sleep(2500) }
        } catch (e: Exception) {}
    }

    /** Same-origin authed fetch inside the control browser; returns the response body text ("" on 204). */
    fun authed(method: String, path: String, body: String?): String {
        val c = control ?: return "{\"error\":\"not connected\"}"
        ensureOnCluster()
        val opt = StringBuilder("{method:").append(jsonStr(method)).append(",credentials:'include',headers:{'Content-Type':'application/json'}")
        if (body != null) opt.append(",body:").append(jsonStr(body))
        opt.append("}")
        /* A cluster call can be the model's answer (POST /v1/agent/chat), which a slower model gives
           after more than the 30 s every other DevTools call gets. See Cef.cdp. */
        return Cef.evalJs(c, "fetch(${jsonStr(path)},$opt).then(function(r){return r.text()})", 180)
    }
}
