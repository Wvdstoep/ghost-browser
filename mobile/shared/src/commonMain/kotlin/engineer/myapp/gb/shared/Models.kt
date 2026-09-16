package engineer.myapp.gb.shared

/**
 * Toolkit-independent data models shared by phone and desktop. These are the shapes the run
 * experience, the ring, the tab grid, the flows list and the device hub all speak — plain Kotlin
 * that survives every UI move.
 */
data class TabInfo(val index: Int, val title: String, val host: String, val profile: String, val active: Boolean)
data class FlowInfo(val id: String, val name: String, val steps: Int, val sub: String,
                    val profile: String = "", val role: String = "", val goals: List<String> = emptyList(),
                    val runs: Int = 0, val lastStatus: String = "", val verified: Boolean = false)
data class ChatMsg(val role: String, val content: String, val tool: String? = null)   // user | assistant | tool
data class PlatformOpt(val label: String, val site: String, val profile: String, val signedIn: Boolean)
data class HubDevice(val name: String, val owner: String, val type: String, val online: Boolean, val lastSeenMs: Long, val queued: Int)
data class LearnItem(val slug: String, val title: String, val description: String)
data class DeviceOpt(val id: String, val name: String, val sub: String, val emoji: String, val online: Boolean)
