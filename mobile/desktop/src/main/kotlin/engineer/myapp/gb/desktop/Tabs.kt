package engineer.myapp.gb.desktop

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.cef.browser.CefBrowser

/**
 * Desktop multi-tab: each tab is its own real Chromium (CefBrowser). The active tab is shown in the
 * window and is the one the node/agent drive — so the phone's "run on the active tab" model holds on
 * desktop too. New tabs open on the native home; navigating leaves home.
 */
class DeskTab(val browser: CefBrowser) {
    var home by mutableStateOf(true)
}

object Tabs {
    val list = mutableStateListOf<DeskTab>()
    var active by mutableStateOf(0)

    fun activeTab(): DeskTab? = list.getOrNull(active)
    fun activeBrowser(): CefBrowser? = activeTab()?.browser

    /** Open a tab. url=null → a home tab (native new-tab page); a url → load it. */
    fun open(url: String?) {
        val b = Cef.newBrowser(url ?: "about:blank")
        val t = DeskTab(b)
        if (!url.isNullOrBlank()) t.home = false
        list.add(t); active = list.size - 1
    }

    fun select(i: Int) { if (i in list.indices) active = i }

    fun close(i: Int) {
        if (i !in list.indices) return
        val t = list.removeAt(i)
        try { t.browser.close(true) } catch (e: Throwable) {}
        if (list.isEmpty()) open(null)
        if (active >= list.size) active = list.size - 1
    }

    /** Navigate the active tab (leaves the home page). */
    fun go(url: String) { activeTab()?.let { it.home = false; it.browser.loadURL(url) } }

    fun hostLabel(i: Int): String {
        val t = list.getOrNull(i) ?: return "New tab"
        if (t.home) return "New tab"
        val u = try { t.browser.url ?: "" } catch (e: Exception) { "" }
        return try { java.net.URI(u).host?.removePrefix("www.") ?: "Tab" } catch (e: Exception) { "Tab" }
    }
}
