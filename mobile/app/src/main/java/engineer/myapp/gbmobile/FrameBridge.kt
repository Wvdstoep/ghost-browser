package engineer.myapp.gbmobile

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/*
 * THE PAGES INSIDE A PAGE.
 *
 * Measured 2026-11-10: a Claude session on the owner's phone opened Google's "Edit profile" for a business
 * and could not see or type into it — the form is a frame from another Google domain, and evaluateJavascript
 * only ever reaches the top page. Every number, click and keystroke stopped at the frame's edge.
 *
 * Now gb.js plus a small agent is injected at document start into EVERY frame, and each frame talks to the
 * app over its own WebMessageListener channel ("GBFrame") — not through the page above it, so a page cannot
 * read or steer a frame of another site through us. The top page tells each frame where it sits (gb.js
 * postGeo), so a frame's elements get numbers after the top page's, screen positions the native tap can hit,
 * and their text is read with the page.
 */
class FrameBridge private constructor() {
    private class Frame(val proxy: JavaScriptReplyProxy, val origin: String)

    private val frames = ConcurrentHashMap<String, Frame>()
    private val waiters = ConcurrentHashMap<String, Pair<CountDownLatch, MutableList<JSONObject>>>()
    private val main = Handler(Looper.getMainLooper())

    companion object {
        private val bridges = WeakHashMap<WebView, FrameBridge>()

        /** The agent each frame runs (never the top page). It answers only the app, over its own channel. */
        const val FRAME_JS = """(function(){
  if (window === window.top || window.__gbFrameAgent) return; window.__gbFrameAgent = 1;
  var fid = Math.random().toString(36).slice(2, 12) + Date.now().toString(36), ch = null;
  function run(m) {
    var g = window.__gb; if (!g) return { error: 'no-gb' };
    var f = g.frame();
    switch (m.op) {
      case 'where': return f;
      case 'mark': if (!f.off) return { hidden: true, url: f.url }; return { off: f.off, url: f.url, els: g.mark(m.draw !== false, m.base || 0) };
      case 'coords': return g.coords(m.i);
      case 'coordsText': return g.coordsText(m.text, m.nth || 0);
      case 'type': return g.type(m.i, m.text);
      case 'scroll': return g.scroll(m.dy);
      case 'clear': return g.clear();
      case 'text': if (!f.off) return { hidden: true }; return { url: f.url, text: String(g.text()).slice(0, 60000) };
    }
    return { error: 'unknown-op' };
  }
  function hello() {
    var b = (typeof GBFrame !== 'undefined') ? GBFrame : null; if (!b || ch === b) return;
    ch = b;
    b.addEventListener('message', function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || !m.rid || (m.fid && m.fid !== fid)) return;
      var r; try { r = run(m); } catch (e) { r = { error: String(e) }; }
      b.postMessage(JSON.stringify({ rid: m.rid, fid: fid, result: r === undefined ? null : r }));
    });
    b.postMessage(JSON.stringify({ hello: 1, fid: fid, url: location.href }));
  }
  hello();
  if (!ch) { document.addEventListener('DOMContentLoaded', hello); window.addEventListener('load', hello); }
})();"""

        fun supported(): Boolean = try {
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
                WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        } catch (e: Throwable) { false }

        /** Call on the UI thread, once per WebView, before it loads anything. No-op where WebView is too old. */
        fun attach(w: WebView, ctx: Context) {
            if (!supported()) return
            synchronized(bridges) { if (bridges.containsKey(w)) return }
            val gbJs = try { ctx.assets.open("gb.js").bufferedReader().use { it.readText() } } catch (e: Exception) { return }
            val fb = FrameBridge()
            try {
                WebViewCompat.addWebMessageListener(w, "GBFrame", setOf("*")) { _, msg, origin, isMainFrame, proxy ->
                    if (!isMainFrame) msg.data?.let { fb.onMessage(it, origin.toString(), proxy) }
                }
                WebViewCompat.addDocumentStartJavaScript(w, gbJs + "\n" + FRAME_JS, setOf("*"))
                synchronized(bridges) { bridges[w] = fb }
            } catch (e: Throwable) { /* the top page still works as before */ }
        }

        fun of(w: WebView?): FrameBridge? = if (w == null) null else synchronized(bridges) { bridges[w] }
    }

    private fun onMessage(data: String, origin: String, proxy: JavaScriptReplyProxy) {
        val m = try { JSONObject(data) } catch (e: Exception) { return }
        val fid = m.optString("fid"); if (fid.isBlank()) return
        if (m.optInt("hello") == 1) { frames[fid] = Frame(proxy, origin); return }
        // An answer counts only from the channel that frame said hello on.
        val known = frames[fid] ?: return
        if (known.proxy !== proxy) return
        val w = waiters[m.optString("rid")] ?: return
        synchronized(w.second) { w.second.add(m.put("origin", known.origin)) }
        w.first.countDown()
    }

    /** Ask [fids] (all known frames when null) and wait up to [ms]; a frame that does not answer is gone. */
    fun ask(cmd: JSONObject, fids: Collection<String>? = null, ms: Long = 700): List<JSONObject> {
        val targets = (fids ?: frames.keys.toList()).mapNotNull { id -> frames[id]?.let { id to it } }
        if (targets.isEmpty()) return emptyList()
        val rid = "r" + System.nanoTime()
        val got = mutableListOf<JSONObject>()
        val latch = CountDownLatch(targets.size)
        waiters[rid] = latch to got
        main.post {
            for ((id, f) in targets) {
                try { f.proxy.postMessage(JSONObject(cmd.toString()).put("rid", rid).put("fid", id).toString()) }
                catch (e: Throwable) { frames.remove(id); latch.countDown() }
            }
        }
        latch.await(ms, TimeUnit.MILLISECONDS)
        waiters.remove(rid)
        val answered = synchronized(got) { got.toList() }
        val ids = answered.map { it.optString("fid") }.toSet()
        for ((id, _) in targets) if (id !in ids) frames.remove(id)
        return answered
    }

    fun one(fid: String, cmd: JSONObject, ms: Long = 1500): JSONObject? =
        ask(cmd, listOf(fid), ms).firstOrNull()?.optJSONObject("result")

    val count: Int get() = frames.size
}

/**
 * The ring's perceive/act commands over the top page AND its frames. Both device browsers (the service's
 * invisible one and the app's) run their commands through this, so they answer alike.
 * [evalGb] runs an expression in the top page with gb.js, [tap] makes a native tap from {x,y,iw,ih}.
 */
class FrameOps(private val target: () -> WebView?, private val evalGb: (String) -> String, private val tap: (String) -> String) {
    /** Global index → (frame, its own index), from the last analyze. */
    @Volatile private var map: Map<Int, Pair<String, Int>> = emptyMap()

    private fun bridge(): FrameBridge? = FrameBridge.of(target())?.takeIf { it.count > 0 }

    /** Tell frames where they are, then return the top viewport ({iw, ih}). */
    private fun geo(): JSONObject? {
        val g = try { JSONObject(evalGb("window.__gb.geo()")) } catch (e: Exception) { return null }
        if (g.optInt("frames") > 0) Thread.sleep(180)
        return g
    }

    fun analyze(): String {
        val top = try { JSONArray(evalGb("window.__gb.mark()")) } catch (e: Exception) { map = emptyMap(); return evalGb("window.__gb.mark()") }
        val b = bridge(); val m = HashMap<Int, Pair<String, Int>>()
        if (b != null) {
            val vp = geo()
            if (vp != null && vp.optInt("frames") > 0) {
                val ih = vp.optDouble("ih", 0.0)
                val visible = b.ask(JSONObject().put("op", "where"), ms = 500)
                    .filter { it.optJSONObject("result")?.optJSONObject("off") != null }.map { it.optString("fid") }
                for (fid in visible) {
                    val r = b.one(fid, JSONObject().put("op", "mark").put("base", top.length())) ?: continue
                    val off = r.optJSONObject("off") ?: continue
                    val els = r.optJSONArray("els") ?: continue
                    val host = try { android.net.Uri.parse(r.optString("url")).host ?: "" } catch (e: Exception) { "" }
                    for (k in 0 until els.length()) {
                        val o = els.optJSONObject(k) ?: continue
                        val y = o.optInt("y") + off.optDouble("y").toInt()
                        if (ih > 0 && (y > ih + 400 || y + o.optInt("h") < 0)) continue
                        val i = top.length()
                        m[i] = fid to o.optInt("i")
                        o.put("i", i).put("x", o.optInt("x") + off.optDouble("x").toInt()).put("y", y).put("frame", host)
                        top.put(o)
                    }
                }
            }
        }
        map = m
        return top.toString()
    }

    /** {x,y,iw,ih} in top-page pixels for something a frame found ([cmd] = coords / coordsText). */
    private fun frameCoords(fid: String, cmd: JSONObject): String {
        val b = bridge() ?: return "{\"err\":\"frame-gone\"}"
        val c = b.one(fid, cmd) ?: return "{\"err\":\"frame-gone\"}"
        if (c.has("err")) return c.toString()
        val vp = geo() ?: return "{\"err\":\"nocoords\"}"   // the frame may have scrolled the page: ask again
        val off = b.one(fid, JSONObject().put("op", "where"))?.optJSONObject("off") ?: return "{\"err\":\"frame-hidden\"}"
        return JSONObject().put("x", c.optDouble("x") + off.optDouble("x")).put("y", c.optDouble("y") + off.optDouble("y"))
            .put("iw", vp.optDouble("iw")).put("ih", vp.optDouble("ih")).toString()
    }

    fun click(index: Int): String {
        val f = map[index] ?: return tap(evalGb("window.__gb.coords($index)"))
        evalGb("window.__gb.clear()")
        return tap(frameCoords(f.first, JSONObject().put("op", "coords").put("i", f.second)))
    }

    fun clickText(text: String, nth: Int): String {
        val top = evalGb("window.__gb.coordsText(" + JSONObject.quote(text) + "," + nth + ")")
        if (!top.contains("notfound")) return tap(top)
        val b = bridge() ?: return tap(top)
        geo()
        for (r in b.ask(JSONObject().put("op", "where"), ms = 500)) {
            if (r.optJSONObject("result")?.optJSONObject("off") == null) continue
            val c = frameCoords(r.optString("fid"), JSONObject().put("op", "coordsText").put("text", text).put("nth", nth))
            if (!c.contains("\"err\"")) return tap(c)
        }
        return tap(top)
    }

    fun type(index: Int, text: String): String {
        val f = map[index] ?: return evalGb("window.__gb.type($index," + JSONObject.quote(text) + ")")
        val r = bridge()?.ask(JSONObject().put("op", "type").put("i", f.second).put("text", text), listOf(f.first), 1500)?.firstOrNull()
            ?: return JSONObject.quote("frame-gone")
        return JSONObject.quote(r.optString("result", "ok"))
    }

    /** Scroll the page, and a frame that fills most of the screen (a dialog's form) with it. */
    fun scroll(dy: Int): String {
        val r = evalGb("window.__gb.scroll($dy)")
        val b = bridge() ?: return r
        val vp = geo() ?: return r
        val area = vp.optDouble("iw") * vp.optDouble("ih")
        val big = b.ask(JSONObject().put("op", "where"), ms = 500).filter {
            val f = it.optJSONObject("result"); f?.optJSONObject("off") != null && area > 0 && f.optDouble("iw") * f.optDouble("ih") >= area * 0.35
        }.map { it.optString("fid") }
        if (big.isNotEmpty()) b.ask(JSONObject().put("op", "scroll").put("dy", dy), big, 800)
        return r
    }

    /** The top page's text, then each visible frame's (JSON-encoded string, like __gb.text()). */
    fun text(): String {
        val raw = evalGb("window.__gb.text()")
        val b = bridge() ?: return raw
        if ((geo()?.optInt("frames") ?: 0) == 0) return raw
        val top = try { JSONObject("{\"v\":$raw}").optString("v") } catch (e: Exception) { return raw }
        val sb = StringBuilder(top)
        for (r in b.ask(JSONObject().put("op", "text"), ms = 900)) {
            val t = r.optJSONObject("result")?.optString("text") ?: continue
            if (t.isBlank()) continue
            sb.append("\n\n── frame ").append(r.optString("origin")).append(" ──\n").append(t)
        }
        return JSONObject.quote(sb.toString())
    }
}
