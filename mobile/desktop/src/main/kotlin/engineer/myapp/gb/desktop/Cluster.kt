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

    /** Make sure the control browser is sitting on the GB origin (not the login page) before we fetch. */
    fun ensureOnCluster() {
        val c = control ?: return
        try {
            val cur = c.url ?: ""
            if (!cur.startsWith(origin())) { c.loadURL(clusterUrl); Thread.sleep(2500) }
        } catch (e: Exception) {}
    }

    /** Same-origin authed fetch inside the control browser; returns the response body text ("" on 204). */
    fun authed(method: String, path: String, body: String?): String {
        val c = control ?: return "{\"error\":\"not connected\"}"
        ensureOnCluster()
        val opt = StringBuilder("{method:").append(jsonStr(method)).append(",credentials:'include',headers:{'Content-Type':'application/json'}")
        if (body != null) opt.append(",body:").append(jsonStr(body))
        opt.append("}")
        return Cef.evalJs(c, "fetch(${jsonStr(path)},$opt).then(function(r){return r.text()})")
    }
}
