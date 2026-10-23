package engineer.myapp.gbmobile

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class PublicRangePreset(val name: String, val cidr: String) {
    companion object {
        fun create(name: String, cidr: String): PublicRangePreset? {
            val plan = RangePlan.parse(cidr) ?: return null
            if (plan.scope != RangePlan.Scope.PUBLIC) return null
            val title = name.trim().take(40)
            if (title.isBlank()) return null
            return PublicRangePreset(title, plan.cidr)
        }
    }
}

/** User-defined public ranges stay on this phone; no Internet-wide list is bundled. */
object PublicRangePresets {
    private const val KEY = "public_range_presets"

    fun load(context: Context): List<PublicRangePreset> = try {
        val raw = context.getSharedPreferences("gb_local_recon", Context.MODE_PRIVATE).getString(KEY, "[]") ?: "[]"
        val array = JSONArray(raw)
        (0 until array.length()).mapNotNull { i -> array.optJSONObject(i)?.let {
            PublicRangePreset.create(it.optString("name"), it.optString("cidr"))
        } }.distinctBy { it.cidr }.take(32)
    } catch (_: Exception) { emptyList() }

    fun save(context: Context, presets: List<PublicRangePreset>) {
        val array = JSONArray()
        presets.take(32).forEach { array.put(JSONObject().put("name", it.name).put("cidr", it.cidr)) }
        context.getSharedPreferences("gb_local_recon", Context.MODE_PRIVATE).edit().putString(KEY, array.toString()).apply()
    }
}
