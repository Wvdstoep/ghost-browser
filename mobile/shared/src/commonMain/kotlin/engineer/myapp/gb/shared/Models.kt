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

/**
 * The approval gate as data. A running watcher (e.g. the Facebook reply watch) drafts an action —
 * a reply, a comment, a message — and it sits here as a [Proposal] until the owner approves or denies
 * it. Nothing the outside world sees is sent without that yes. [JobInfo] is one running watcher with
 * its recent activity (so a run is never a silent "Running…") and its pending proposals.
 */
data class Proposal(
    val jobId: String, val pid: String,
    val kind: String,      // reply | comment | message | join | follow | like | other
    val why: String,       // what this is for, in one line ("replied to your post: …")
    val url: String,       // WHERE it came from — the thread/post link
    val text: String,      // the DRAFT the owner reviews and can edit before it posts
    val jobRole: String,   // which watcher produced it
)
data class JobInfo(
    val id: String, val role: String, val status: String,   // running | idle | done | failed
    val steps: List<String>,                                 // recent activity lines (kind: text)
    val proposals: List<Proposal>,                           // pending approvals from this job
)

/**
 * A [Watcher] — a background task that runs a chosen role on a schedule (every 1/5/10 min) on the
 * always-on cluster, so it keeps watching even when the app is closed. It is an ACTIVE scheduled
 * workflow underneath; the role decides WHAT it watches (notifications, a site, leads…). Its runs
 * store results the user can open as an interactive artifact.
 */
data class Watcher(
    val id: String, val name: String, val role: String, val profile: String,
    val intervalMin: Int,          // 1 | 5 | 10
    val active: Boolean,           // scheduled + firing, or paused
    val lastRun: String,           // human "3 runs, last ok" / "never run"
    val resultCount: Int,          // items collected on the latest run
    val goal: String = "",         // the specific instruction (role mode), for edit pre-fill
    val mode: String = "role",     // "role" (role+goal) | "automation" (runs a saved flow)
    val stepCount: Int = 1,        // how many steps it runs (automation mode > 1)
)

/** One collected item in a watcher's results — schema-agnostic: whatever fields it has, plus an
 *  optional image and link. Rendered by the results view; a follow-up flow can run on it. */
data class ResultItem(
    val title: String,
    val fields: List<Pair<String, String>>,
    val url: String,
    val image: String,
    val kind: String,
)
