package engineer.myapp.gb.desktop

import engineer.myapp.gb.shared.*
import org.json.JSONArray
import org.json.JSONObject

/** GET /v1/assistant/chats/:id â†’ the shared view; GET /v1/assistant/chats â†’ summaries. (org.json; the shared module has no JSON.) */
object AssistantJson {
    private fun steps(a: JSONArray?): List<AssistantStep> {
        val out = ArrayList<AssistantStep>(); if (a == null) return out
        for (i in 0 until a.length()) { val s = a.optJSONObject(i) ?: continue; out.add(AssistantStep(s.optString("name"), s.optString("label", s.optString("name")), s.optString("args"), s.optString("text"))) }
        return out
    }
    private fun cards(a: JSONArray?): List<AssistantCard> {
        val out = ArrayList<AssistantCard>(); if (a == null) return out
        for (i in 0 until a.length()) { val c = a.optJSONObject(i) ?: continue; out.add(AssistantCard(c.optString("kind"), c.optString("title"), c.optString("watcherId"), c.optString("url"))) }
        return out
    }
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
                AssistantLive(l.optString("jobId"), l.optString("status"), l.optInt("iterations"), tasks, steps(l.optJSONArray("steps")), l.optLong("startedAt"))
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
    fun models(json: String): Pair<List<String>, String> = try {
        val o = JSONObject(json); val a = o.optJSONArray("models") ?: JSONArray(); val list = ArrayList<String>()
        for (i in 0 until a.length()) { val m = a.optString(i); if (m.isNotBlank()) list.add(m) }
        list to (if (list.isEmpty()) "no models â€” ${o.optString("reason", "check the host")}" else if (o.optBoolean("fetched", true)) "${list.size} models on ${o.optString("host")}" else "${list.size} known models (host not reachable: ${o.optString("reason")})")
    } catch (e: Exception) { emptyList<String>() to "could not read the model list" }
}
