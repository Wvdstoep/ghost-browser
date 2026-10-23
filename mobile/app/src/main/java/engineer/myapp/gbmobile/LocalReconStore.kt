package engineer.myapp.gbmobile

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Phone-owned security workflow data. Cluster data never overwrites these records. */
object LocalReconStore {
    private const val PREFS = "gb_local_recon"
    private const val FLOWS = "flows"
    private const val RESULTS = "results"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun array(context: Context, key: String): JSONArray = try {
        JSONArray(prefs(context).getString(key, "[]") ?: "[]")
    } catch (_: Exception) { JSONArray() }

    @Synchronized fun flows(context: Context): JSONArray = array(context, FLOWS)

    @Synchronized fun get(context: Context, id: String): JSONObject? {
        val items = flows(context)
        for (i in 0 until items.length()) items.optJSONObject(i)?.let { if (it.optString("id") == id) return it }
        return null
    }

    @Synchronized fun save(context: Context, record: JSONObject): JSONObject {
        val id = record.optString("id").ifBlank { "local-recon-${UUID.randomUUID()}" }
        record.put("id", id).put("kind", "security").put("local", true)
        val old = flows(context)
        val next = JSONArray()
        for (i in 0 until old.length()) old.optJSONObject(i)?.let { if (it.optString("id") != id) next.put(it) }
        next.put(record)
        prefs(context).edit().putString(FLOWS, next.toString()).apply()
        return record
    }

    @Synchronized fun setActive(context: Context, id: String, active: Boolean): Boolean {
        val record = get(context, id) ?: return false
        record.put("active", active)
        save(context, record)
        return true
    }

    @Synchronized fun results(context: Context, id: String): JSONArray = try {
        array(context, RESULTS).let { records ->
            for (i in 0 until records.length()) {
                val entry = records.optJSONObject(i) ?: continue
                if (entry.optString("id") == id) return entry.optJSONArray("items") ?: JSONArray()
            }
            JSONArray()
        }
    } catch (_: Exception) { JSONArray() }

    @Synchronized fun allResults(context: Context): JSONArray {
        val groups = array(context, RESULTS)
        val items = ArrayList<JSONObject>()
        for (i in 0 until groups.length()) {
            val results = groups.optJSONObject(i)?.optJSONArray("items") ?: continue
            for (j in 0 until results.length()) results.optJSONObject(j)?.let { items.add(it) }
        }
        return JSONArray().also { output ->
            items.sortedByDescending { it.optJSONObject("fields")?.optLong("recordedAt", 0) ?: 0 }
                .take(1000).forEach { output.put(it) }
        }
    }

    @Synchronized fun addResult(context: Context, id: String, item: JSONObject) {
        val records = array(context, RESULTS)
        val next = JSONArray()
        var items = JSONArray()
        for (i in 0 until records.length()) {
            val entry = records.optJSONObject(i) ?: continue
            if (entry.optString("id") == id) items = entry.optJSONArray("items") ?: JSONArray()
            else next.put(entry)
        }
        val recent = JSONArray().put(item)
        for (i in 0 until minOf(items.length(), 99)) recent.put(items.get(i))
        next.put(JSONObject().put("id", id).put("items", recent))
        prefs(context).edit().putString(RESULTS, next.toString()).apply()
        get(context, id)?.let { flow ->
            flow.put("runs", flow.optInt("runs") + 1)
                .put("lastRunStatus", item.optJSONObject("fields")?.optString("status") ?: "done")
                .put("lastRun", System.currentTimeMillis())
            save(context, flow)
        }
    }

    fun firstRecon(record: JSONObject): JSONObject? {
        val nodes = record.optJSONArray("nodes") ?: return null
        for (i in 0 until nodes.length()) nodes.optJSONObject(i)?.let { if (it.optString("type") == "recon") return it }
        return null
    }

    fun isScheduled(record: JSONObject): Boolean {
        val nodes = record.optJSONArray("nodes") ?: return false
        for (i in 0 until nodes.length()) {
            val node = nodes.optJSONObject(i) ?: continue
            if (node.optString("type") == "trigger" && node.optJSONObject("trigger")?.optString("type") == "schedule") return true
        }
        return false
    }
}
