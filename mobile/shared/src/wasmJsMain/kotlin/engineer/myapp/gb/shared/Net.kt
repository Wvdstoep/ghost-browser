package engineer.myapp.gb.shared

import kotlinx.coroutines.await
import kotlinx.serialization.json.*
import kotlin.js.Promise

/**
 * The web console's cluster client. The bundle is served BY the cluster GB tool, so it runs on the GB
 * origin: a same-origin fetch with `credentials:'include'` rides the SSO cookie exactly like the desktop's
 * hidden control browser does — one account, no key pasted. Relative paths ("/v1/…") hit GB directly.
 */
private fun jsFetchText(method: String, path: String, body: String): Promise<JsString> =
    js("fetch(path,{method:method,credentials:'include',headers:{'Content-Type':'application/json'},body:(method==='GET'||method==='DELETE'||body.length===0)?undefined:body}).then(function(r){return r.text()}).catch(function(e){return JSON.stringify({error:String(e)})})")

/** Same-origin authed call; returns the response body text ("{\"error\":…}" on transport failure). */
suspend fun api(method: String, path: String, body: String = ""): String =
    try { val r: JsString = jsFetchText(method, path, body).await(); r.toString() } catch (e: Throwable) { "{\"error\":\"no answer from the cluster\"}" }

// ── JSON read helpers (org.json-style, over kotlinx JsonElement — no compiler plugin needed) ──────────
private val JSON = Json { ignoreUnknownKeys = true; isLenient = true }

fun jparse(s: String): JsonObject? = try { JSON.parseToJsonElement(s) as? JsonObject } catch (e: Throwable) { null }
fun jparseArray(s: String): JsonArray? = try { JSON.parseToJsonElement(s) as? JsonArray } catch (e: Throwable) { null }

fun JsonObject?.str(key: String, def: String = ""): String {
    val p = this?.get(key) as? JsonPrimitive ?: return def
    if (p is JsonNull) return def
    return p.contentOrNull ?: def
}
fun JsonObject?.int(key: String, def: Int = 0): Int = (this?.get(key) as? JsonPrimitive)?.intOrNull ?: def
fun JsonObject?.long(key: String, def: Long = 0L): Long = (this?.get(key) as? JsonPrimitive)?.longOrNull ?: def
fun JsonObject?.bool(key: String, def: Boolean = false): Boolean = (this?.get(key) as? JsonPrimitive)?.booleanOrNull ?: def
fun JsonObject?.obj(key: String): JsonObject? = this?.get(key) as? JsonObject
fun JsonObject?.arr(key: String): JsonArray? = this?.get(key) as? JsonArray
fun JsonObject.hasError(): Boolean = this["error"] != null
fun JsonArray.objs(): List<JsonObject> = this.mapNotNull { it as? JsonObject }
fun JsonArray.strings(): List<String> = this.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.filter { it.isNotBlank() }

// ── JSON write helper for request bodies ──────────────────────────────────────────────────────────
fun jbody(build: JsonObjectBuilder.() -> Unit): String = buildJsonObject(build).toString()

/** Escape a string as a JSON string literal (quotes included), for the hand-built request bodies. */
fun jsonStr(s: String): String {
    val sb = StringBuilder("\"")
    for (c in s) when (c) {
        '\\' -> sb.append("\\\\"); '"' -> sb.append("\\\"")
        '\n' -> sb.append("\\n"); '\r' -> sb.append("\\r"); '\t' -> sb.append("\\t")
        else -> if (c < ' ') sb.append("\\u").append(c.code.toString(16).padStart(4, '0')) else sb.append(c)
    }
    return sb.append("\"").toString()
}

// ── Assistant JSON (GET /v1/assistant/chats[/:id]) → the shared view shapes ───────────────────────
private fun stepsOf(a: JsonArray?): List<AssistantStep> = (a?.objs() ?: emptyList()).map { s ->
    AssistantStep(s.str("name"), s.str("label", s.str("name")), s.str("args"), s.str("text"), s.str("image"),
        s.str("imageData"), s.str("download"), s.str("fileName"), s.str("fileKind"), s.str("fileMime"), s.str("recording"))
}
private fun cardsOf(a: JsonArray?): List<AssistantCard> = (a?.objs() ?: emptyList()).map { c ->
    AssistantCard(c.str("kind"), c.str("title"), c.str("watcherId"), c.str("url"), c.str("id"))
}
fun parseChats(o: JsonObject?): List<ChatSummary> = (o.arr("chats")?.objs() ?: emptyList()).map { c ->
    ChatSummary(c.str("id"), c.str("title"), c.long("updatedAt"), c.int("turns"), c.bool("running"))
}
fun parseChat(json: String): AssistantChatView? {
    val o = jparse(json) ?: return null
    if (o.hasError() && o["id"] == null) return null
    val turns = (o.arr("turns")?.objs() ?: emptyList()).map { t ->
        AssistantTurn(t.str("role"), t.str("text"), t.long("t"), t.str("status"), t.str("details"),
            cardsOf(t.arr("cards")), stepsOf(t.arr("steps")), t.bool("spoken"), t.int("iterations"))
    }
    val lv = o.obj("live")
    val live = lv?.let { l ->
        val tasks = (l.arr("tasks")?.objs() ?: emptyList()).map { x -> AssistantTask(x.str("title"), x.bool("done"), x.str("note")) }
        AssistantLive(l.str("jobId"), l.str("status"), l.int("iterations"), tasks, stepsOf(l.arr("steps")),
            l.long("startedAt"), l.str("backdrop"), l.str("backdropProfile"))
    }
    return AssistantChatView(o.str("id"), o.str("title"), turns, live)
}
