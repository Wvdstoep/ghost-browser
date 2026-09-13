package engineer.myapp.gbmobile

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.MutableLiveData
import java.util.UUID

/**
 * MVVM state for GB Mobile — config, profiles, agent/cluster status and the activity log live here
 * (survive config changes, persist across launches), while the Activity owns the WebView and wiring.
 */
class GbViewModel(app: Application) : AndroidViewModel(app) {

    private val sp = app.getSharedPreferences("gb", Application.MODE_PRIVATE)

    // --- Ollama config (standalone agent) ---
    var endpoint: String get() = sp.getString("endpoint", "") ?: ""
        set(v) { sp.edit().putString("endpoint", v).apply() }
    var apiKey: String get() = sp.getString("key", "") ?: ""
        set(v) { sp.edit().putString("key", v).apply() }
    var model: String get() = sp.getString("model", "glm-4") ?: "glm-4"
        set(v) { sp.edit().putString("model", v).apply() }
    var task: String get() = sp.getString("task", "") ?: ""
        set(v) { sp.edit().putString("task", v).apply() }

    // --- device token (cluster mode) ---
    val deviceToken: String by lazy {
        var t = sp.getString("token", null)
        if (t == null) { t = UUID.randomUUID().toString().replace("-", "").substring(0, 24); sp.edit().putString("token", t).apply() }
        t
    }

    // --- profiles (isolated cookie jars) ---
    val profiles = MutableLiveData<List<String>>(loadProfiles())
    val currentProfile = MutableLiveData(sp.getString("profile", "default") ?: "default")

    private fun loadProfiles(): List<String> {
        val raw = sp.getString("profiles", "default") ?: "default"
        return raw.split(",").map { it.trim() }.filter { it.isNotEmpty() }.distinct()
    }
    fun addProfile(name: String) {
        val clean = name.trim().lowercase().replace(Regex("[^a-z0-9_-]"), "")
        if (clean.isEmpty()) return
        val list = (profiles.value ?: emptyList()).toMutableList()
        if (!list.contains(clean)) { list.add(clean); sp.edit().putString("profiles", list.joinToString(",")).apply(); profiles.value = list }
        selectProfile(clean)
    }
    fun selectProfile(name: String) {
        sp.edit().putString("profile", name).apply(); currentProfile.value = name
    }

    // --- live UI state ---
    val agentRunning = MutableLiveData(false)
    val clusterOn = MutableLiveData(false)
    val clusterInfo = MutableLiveData("Cluster: off")
    val logText = MutableLiveData("")

    fun log(line: String) {
        val cur = logText.value ?: ""
        val next = (cur + line + "\n")
        logText.postValue(if (next.length > 12000) next.takeLast(12000) else next)
    }
    fun clearLog() { logText.value = "" }
}
