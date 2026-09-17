package engineer.myapp.gbmobile

import engineer.myapp.gb.shared.*
import org.json.JSONArray
import org.json.JSONObject

/** GET /v1/assistant/chats/:id → the shared view; GET /v1/assistant/chats → summaries. (org.json; the shared module has no JSON.) */
object AssistantJson {
    private fun steps(a: JSONArray?): List<AssistantStep> {
        val out = ArrayList<AssistantStep>(); if (a == null) return out
        for (i in 0 until a.length()) { val s = a.optJSONObject(i) ?: continue; out.add(AssistantStep(s.optString("name"), s.optString("label", s.optString("name")), s.optString("args"), s.optString("text"), s.optString("image"), s.optString("imageData"), s.optString("download"), s.optString("fileName"), s.optString("fileKind"), s.optString("fileMime"), s.optString("recording"))) }
        return out
    }
    private fun cards(a: JSONArray?): List<AssistantCard> {
        val out = ArrayList<AssistantCard>(); if (a == null) return out
        for (i in 0 until a.length()) { val c = a.optJSONObject(i) ?: continue; out.add(AssistantCard(c.optString("kind"), c.optString("title"), c.optString("watcherId"), c.optString("url"), c.optString("id"))) }
        return out
    }
    /** One recording (GET /v1/recordings/:id, or an item of the list). */
    fun recording(o: JSONObject): RecordingInfo = RecordingInfo(o.optString("id"), o.optString("url"), o.optString("title"), o.optString("pageTitle"), o.optString("state"), o.optString("until"), o.optInt("maxMinutes"),
        o.optInt("seconds"), o.optLong("bytes"), o.optInt("segments"), o.optLong("startedAt"), o.optLong("endedAt"), o.optString("reason"), o.optString("error"), o.optBoolean("live"), o.optString("playlist"), o.optString("mp4"),
        o.optString("thumb"), o.optJSONArray("chapters")?.length() ?: 0, o.optString("mode"))
    fun recording(json: String): RecordingInfo? = try { val o = JSONObject(json); if (o.has("error") && !o.has("id")) null else recording(o) } catch (e: Exception) { null }
    /** GET /v1/recordings → every recording, live ones first, then newest first; plus the free bytes on the recordings volume. */
    fun recordings(json: String): Pair<List<RecordingInfo>, Long> = try {
        val o = JSONObject(json); val a = o.optJSONArray("recordings") ?: JSONArray(); val out = ArrayList<RecordingInfo>()
        for (i in 0 until a.length()) { val r = a.optJSONObject(i) ?: continue; out.add(recording(r)) }
        out.sortedWith(compareByDescending<RecordingInfo> { it.running }.thenByDescending { it.startedAt }) to o.optLong("freeBytes")
    } catch (e: Exception) { emptyList<RecordingInfo>() to 0L }
    fun chat(json: String): AssistantChatView? = try {
        val o = JSONObject(json); if (o.has("error") && !o.has("id")) null else {
            val turns = ArrayList<AssistantTurn>(); val ta = o.optJSONArray("turns") ?: JSONArray()
            for (i in 0 until ta.length()) {
                val t = ta.optJSONObject(i) ?: continue
                turns.add(AssistantTurn(t.optString("role"), t.optString("text"), t.optLong("t"), t.optString("status"), t.optString("details"), cards(t.optJSONArray("cards")), steps(t.optJSONArray("steps")), t.optBoolean("spoken"), t.optInt("iterations")))
            }
            val lv = o.optJSONObject("live")
            val live = lv?.let { l ->
                val tasks = ArrayList<AssistantTask>(); val tk = l.optJSONArray("tasks") ?: JSONArray()
                for (i in 0 until tk.length()) { val x = tk.optJSONObject(i) ?: continue; tasks.add(AssistantTask(x.optString("title"), x.optBoolean("done"), x.optString("note"))) }
                AssistantLive(l.optString("jobId"), l.optString("status"), l.optInt("iterations"), tasks, steps(l.optJSONArray("steps")), l.optLong("startedAt"), l.optString("backdrop"), l.optString("backdropProfile"))
            }
            AssistantChatView(o.optString("id"), o.optString("title"), turns, live)
        }
    } catch (e: Exception) { null }
    fun chats(json: String): List<ChatSummary> = try {
        val a = JSONObject(json).optJSONArray("chats") ?: JSONArray(); val out = ArrayList<ChatSummary>()
        for (i in 0 until a.length()) { val c = a.optJSONObject(i) ?: continue; out.add(ChatSummary(c.optString("id"), c.optString("title"), c.optLong("updatedAt"), c.optInt("turns"), c.optBoolean("running"))) }
        out
    } catch (e: Exception) { emptyList() }
    fun model(json: String): AiModelInfo? = try {
        val o = JSONObject(json); if (o.has("error")) null else {
            val ks = o.optJSONObject("keyState"); val state = ks?.let { k -> val u = k.optInt("usable", -1); if (u >= 0) "$u key(s) usable" else "" } ?: ""
            AiModelInfo(o.optString("llmModel"), o.optString("llmHost"), o.optBoolean("keySet"), o.optString("keyHint"), state)
        }
    } catch (e: Exception) { null }
    /** GET /v1/files → what the cluster browser captured (newest first). */
    fun files(json: String): List<FileInfo> = try {
        val a = JSONObject(json).optJSONArray("files") ?: JSONArray(); val out = ArrayList<FileInfo>()
        fun millis(v: Any?): Long = when (v) { is Number -> v.toLong(); is String -> try { java.time.Instant.parse(v).toEpochMilli() } catch (e: Exception) { v.toLongOrNull() ?: 0L }; else -> 0L }
        for (i in 0 until a.length()) { val f = a.optJSONObject(i) ?: continue
            out.add(FileInfo(f.optString("id"), f.optString("name").ifBlank { f.optString("id") }, f.optString("kind"), f.optString("mime"), f.optLong("size"), millis(f.opt("at")), f.optString("source"))) }
        out.sortedByDescending { it.at }
    } catch (e: Exception) { emptyList() }
    /** GET /v1/people → the people worth your words (people memory). */
    fun people(json: String): List<PersonInfo> = try {
        val a = JSONObject(json).optJSONArray("people") ?: JSONArray(); val out = ArrayList<PersonInfo>()
        fun strs(x: JSONArray?): List<String> { val l = ArrayList<String>(); if (x != null) for (i in 0 until x.length()) x.optString(i).takeIf { it.isNotBlank() }?.let { l.add(it) }; return l }
        for (i in 0 until a.length()) { val p = a.optJSONObject(i) ?: continue
            out.add(PersonInfo(p.optString("name"), p.optString("platform"), p.optInt("worth"), p.optBoolean("lead"), p.optInt("repliedBack"), p.optInt("exchanges"), p.optInt("posts"), strs(p.optJSONArray("signals")), strs(p.optJSONArray("promises")), p.optLong("lastSeen"))) }
        out.filter { it.lead || it.worth >= 20 }
    } catch (e: Exception) { emptyList() }
    fun models(json: String): Pair<List<String>, String> = try {
        val o = JSONObject(json); val a = o.optJSONArray("models") ?: JSONArray(); val list = ArrayList<String>()
        for (i in 0 until a.length()) { val m = a.optString(i); if (m.isNotBlank()) list.add(m) }
        list to (if (list.isEmpty()) "no models — ${o.optString("reason", "check the host")}" else if (o.optBoolean("fetched", true)) "${list.size} models on ${o.optString("host")}" else "${list.size} known models (host not reachable: ${o.optString("reason")})")
    } catch (e: Exception) { emptyList<String>() to "could not read the model list" }
}
