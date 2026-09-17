package engineer.myapp.gb.desktop

import androidx.compose.ui.graphics.toComposeImageBitmap
import engineer.myapp.gb.shared.*
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * THE ASSISTANT on the desktop — the same thin client as the phone: the owner's words go to Ghost
 * Browser over the authed control channel (Cluster.authed), the chat is polled while a turn runs, and
 * the shared AssistantScreen renders it. No model runs here and no key lives here.
 */
object AssistantD {
    @Volatile private var chatId = ""
    @Volatile private var polling = false

    private fun bg(block: () -> Unit) = thread(isDaemon = true) { block() }

    fun open(st: DesktopState) {
        st.assistant.connected.value = Cluster.connected
        // a picture in the chat saves into ~/Downloads with one tap
        if (AssistantHooks.saveImage == null) AssistantHooks.saveImage = { data, name ->
            try {
                val mime = data.substringAfter("data:", "image/jpeg").substringBefore(";"); val ext = when { mime.contains("png") -> "png"; mime.contains("webp") -> "webp"; else -> "jpg" }
                val bytes = java.util.Base64.getDecoder().decode(data.substringAfter("base64,", ""))
                val fname = (if (name.contains('.')) name else "$name.$ext").replace(Regex("[^A-Za-z0-9._-]"), "_")
                val dir = java.io.File(System.getProperty("user.home"), "Downloads").also { it.mkdirs() }
                java.io.File(dir, fname).writeBytes(bytes); st.activity.value = "saved ${dir.resolve(fname)}"
            } catch (e: Exception) { st.activity.value = "save failed: ${e.message}" }
        }
        // a song or a clip: saved into ~/Downloads and opened with the system player
        if (AssistantHooks.playMedia == null) AssistantHooks.playMedia = { downloadUrl, name, mime ->
            val id = Regex("/v1/files/([^/]+)/").find(downloadUrl)?.groupValues?.get(1)
            if (id != null) bg { try {
                val o = JSONObject(Cluster.authed("GET", "/v1/files/$id/b64", null)); if (o.has("error")) { st.activity.value = "play: ${o.optString("error")}"; return@bg }
                val data = o.optString("data"); val fname = (name.ifBlank { o.optString("name") }).replace(Regex("[^A-Za-z0-9._-]"), "_")
                val dir = java.io.File(System.getProperty("user.home"), "Downloads").also { it.mkdirs() }; val f = java.io.File(dir, fname)
                f.writeBytes(java.util.Base64.getDecoder().decode(data.substringAfter("base64,", "")))
                java.awt.Desktop.getDesktop().open(f); st.activity.value = "playing $fname"
            } catch (e: Exception) { st.activity.value = "play failed: ${e.message}" } }
        }
        // any captured FILE: fetched as base64 from Ghost Browser, saved into ~/Downloads like a picture
        if (AssistantHooks.saveFile == null) AssistantHooks.saveFile = { downloadUrl, name ->
            val id = Regex("/v1/files/([^/]+)/").find(downloadUrl)?.groupValues?.get(1)
            if (id != null) bg { try { val o = JSONObject(Cluster.authed("GET", "/v1/files/$id/b64", null)); if (o.has("error")) st.activity.value = "save $name: ${o.optString("error")}" else AssistantHooks.saveImage?.invoke(o.optString("data"), name.ifBlank { o.optString("name") }) } catch (e: Exception) { st.activity.value = "save failed: ${e.message}" } }
        }
        if (st.assistant.decodeImage == null) st.assistant.decodeImage = { data ->
            try { val bytes = java.util.Base64.getDecoder().decode(data.substringAfter("base64,", "")); org.jetbrains.skia.Image.makeFromEncoded(bytes).toComposeImageBitmap() } catch (e: Throwable) { null }
        }
        if (!Cluster.connected) return
        bg {
            loadModel(st)
            if (chatId.isBlank()) {
                val list = AssistantJson.chats(Cluster.authed("GET", "/v1/assistant/chats", null)); st.assistant.chats.value = list
                val first = list.firstOrNull { !it.running } ?: list.firstOrNull()
                if (first != null) load(st, first.id) else newChat(st)
            } else load(st, chatId)
        }
    }
    private fun refreshChats(st: DesktopState) { st.assistant.chats.value = AssistantJson.chats(Cluster.authed("GET", "/v1/assistant/chats", null)) }
    /** The live frame of the browser the agent works in, decoded off the UI thread, onto the backdrop. */
    private fun frame(st: DesktopState, v: AssistantChatView?) {
        val d = v?.live?.backdrop?.takeIf { it.isNotBlank() } ?: return
        val bmp = try { st.assistant.decodeImage?.invoke(d) } catch (e: Throwable) { null } ?: return
        st.assistant.backdrop.value = bmp; st.assistant.backdropProfile.value = v.live?.backdropProfile ?: ""
    }
    private fun load(st: DesktopState, id: String) {
        val raw = Cluster.authed("GET", "/v1/assistant/chats/$id", null)
        val v = AssistantJson.chat(raw)
        if (v == null) { st.assistant.error.value = "Could not reach your Ghost Browser (${raw.take(80)})"; st.agentBusy.value = false; return }
        frame(st, v)
        chatId = v.id; st.assistant.chat.value = v; st.assistant.error.value = ""; st.agentBusy.value = v.live != null
        if (v.live != null && !polling) { polling = true; bg { try { while (true) { Thread.sleep(2500); val cur = AssistantJson.chat(Cluster.authed("GET", "/v1/assistant/chats/$chatId", null)) ?: break; frame(st, cur); st.assistant.chat.value = cur; st.agentBusy.value = cur.live != null; if (cur.live == null) break } } finally { polling = false } } }
    }
    private fun newChat(st: DesktopState) {
        val v = AssistantJson.chat(Cluster.authed("POST", "/v1/assistant/chats", "{}"))
        if (v != null) { chatId = v.id; st.assistant.chat.value = v; st.assistant.error.value = ""; st.agentBusy.value = false } else st.assistant.error.value = "Could not start a chat — is your Ghost Browser connected?"
        refreshChats(st)
    }
    private fun send(st: DesktopState, text: String) {
        if (text.isBlank()) return
        st.assistant.chat.value?.let { c -> st.assistant.chat.value = c.copy(turns = c.turns + AssistantTurn("user", text, System.currentTimeMillis(), spoken = c.live != null)) }
        st.agentBusy.value = true
        bg {
            if (chatId.isBlank()) { val v = AssistantJson.chat(Cluster.authed("POST", "/v1/assistant/chats", "{}")); if (v == null) { st.assistant.error.value = "Could not start a chat — is your Ghost Browser connected?"; st.agentBusy.value = false; return@bg }; chatId = v.id }
            val id = chatId
            val r = try { JSONObject(Cluster.authed("POST", "/v1/assistant/chats/$id/messages", JSONObject().put("text", text).toString())) } catch (e: Exception) { JSONObject().put("error", "no answer from the cluster") }
            if (r.has("error")) { st.assistant.error.value = r.optString("error"); st.agentBusy.value = false }
            load(st, id)
        }
    }

    fun actions(st: DesktopState, openUrl: (String) -> Unit, openApprovals: () -> Unit, openSettings: () -> Unit, close: () -> Unit, connect: () -> Unit) = AssistantActions(
        onSend = { send(st, it) },
        onNew = { bg { newChat(st) } },
        onOpen = { id -> bg { load(st, id) } },
        onDelete = { id -> bg { Cluster.authed("DELETE", "/v1/assistant/chats/$id", null); refreshChats(st); if (id == chatId) { chatId = ""; st.assistant.chat.value = null } } },
        onStop = { bg { val id = chatId; if (id.isNotBlank()) { Cluster.authed("POST", "/v1/assistant/chats/$id/stop", "{}"); load(st, id) } } },
        onCard = { c -> when (c.kind) { "results" -> if (c.watcherId.isNotBlank()) openWatcherResultsD(st, c.watcherId); "approvals" -> openApprovals(); "url" -> if (c.url.isNotBlank()) openUrl(c.url); "choice" -> send(st, c.title) } },
        onRefreshChats = { bg { refreshChats(st) } },
        onSettings = openSettings, onClose = close, onOpenUrl = openUrl, onConnect = connect,
    )

    /* ── the AI model: Ghost Browser's own setting ── */
    private fun loadModel(st: DesktopState) {
        st.aiModel.loading.value = true
        val info = AssistantJson.model(Cluster.authed("GET", "/v1/agent/settings", null))
        st.aiModel.loading.value = false
        if (info != null) { st.aiModel.info.value = info; st.assistant.model.value = info.model } else st.aiModel.note.value = "could not read the model from your Ghost Browser"
    }
    private fun body(host: String, key: String, model: String? = null): String {
        val b = JSONObject(); if (host.isNotBlank()) b.put("llmHost", host.trim().removeSuffix("/").removeSuffix("/v1")); if (key.isNotBlank()) b.put("llmKey", key.trim()); if (model != null && model.isNotBlank()) b.put("llmModel", model.trim()); return b.toString()
    }
    fun modelActions(st: DesktopState) = AiModelActions(
        onLoad = { bg { loadModel(st) } },
        onList = { host, key -> bg { st.aiModel.busy.value = true; st.aiModel.note.value = "asking your Ghost Browser…"; val (list, note) = AssistantJson.models(Cluster.authed("POST", "/v1/agent/models", body(host, key))); st.aiModel.busy.value = false; st.aiModel.models.value = list; st.aiModel.note.value = note } },
        onTest = { host, key, model -> bg { st.aiModel.busy.value = true; st.aiModel.note.value = "testing $model…"; val r = try { JSONObject(Cluster.authed("POST", "/v1/agent/test", body(host, key, model))) } catch (e: Exception) { JSONObject().put("error", "no answer") }; st.aiModel.busy.value = false; st.aiModel.note.value = if (r.has("error")) "✗ ${r.optString("error").take(120)}" else "✓ $model answers" } },
        onSave = { host, key, model -> bg { val r = try { JSONObject(Cluster.authed("PUT", "/v1/agent/settings", body(host, key, model))) } catch (e: Exception) { JSONObject().put("error", "no answer") }; st.aiModel.note.value = if (r.has("error")) "✗ ${r.optString("error").take(120)}" else "✓ saved — the agent now runs on ${r.optString("llmModel", model)}"; loadModel(st) } },
    )
}
