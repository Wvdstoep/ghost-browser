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
/**
 * THE ASSISTANT — one chat, one agent, living inside Ghost Browser on the cluster. The app is a thin
 * client: it sends the owner's words, polls the chat while a turn runs, and renders what comes back.
 * These are the shapes of GET /v1/assistant/chats/:id.
 */
data class AssistantStep(val name: String, val label: String, val args: String, val text: String,
                         val image: String = "",      // a picture the tool took (server path), if any
                         val imageData: String = "",  // …inlined as a data: url for the last few (the app decodes it)
                         val download: String = "",   // a captured file behind this step (server download url)
                         val fileName: String = "")
data class AssistantCard(val kind: String, val title: String, val watcherId: String = "", val url: String = "")   // results | approvals | url
data class AssistantTurn(
    val role: String,                 // user | assistant
    val text: String,
    val t: Long,
    val status: String = "",          // assistant: done | blocked | stopped | error
    val details: String = "",         // evidence / what it did, behind a fold
    val cards: List<AssistantCard> = emptyList(),
    val steps: List<AssistantStep> = emptyList(),
    val spoken: Boolean = false,      // a user message spoken INTO a running turn
    val iterations: Int = 0,
)
data class AssistantTask(val title: String, val done: Boolean, val note: String)
data class AssistantLive(val jobId: String, val status: String, val iterations: Int, val tasks: List<AssistantTask>, val steps: List<AssistantStep>, val startedAt: Long,
                         val backdrop: String = "",          // a live frame of the browser the agent works in (data: url), while the turn runs
                         val backdropProfile: String = "")
data class AssistantChatView(val id: String, val title: String, val turns: List<AssistantTurn>, val live: AssistantLive?)
data class ChatSummary(val id: String, val title: String, val updatedAt: Long, val turns: Int, val running: Boolean)

/** A person the watchers see you talk with (people memory): the leads view shows the ones worth your words. */
data class PersonInfo(val name: String, val platform: String, val worth: Int, val lead: Boolean, val repliedBack: Int, val exchanges: Int, val posts: Int,
                      val signals: List<String>, val promises: List<String>, val lastSeen: Long)

/** The model the agent runs on (GB's own settings, never the key): what the AI sheet shows. */
data class AiModelInfo(val model: String, val host: String, val keySet: Boolean, val keyHint: String, val keyState: String = "")

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
    val followUpFlowId: String = "",       // legacy single follow-up (kept for older configs)
    val followUpRepliesOnly: Boolean = true, // legacy
    val followUps: List<FollowUpRoute> = emptyList(), // the engine: each notification kind → its own flow
    val health: String = "",       // last pass, in one line ("12 min ago · 34 messages · 2 waiting · 3 verified, 1 corrected")
    val stale: Boolean = false,    // active but no pass for too long — the watcher has gone quiet
    val running: Boolean = false,  // a pass is in progress right now
)

/** One routing rule of a watcher: items of these kinds run this flow. Empty kinds = any kind. */
data class FollowUpRoute(val kinds: List<String>, val flowId: String)

/** The notification kinds a watcher can route on (what `collect` puts in fields.type). */
val FOLLOW_UP_KINDS = listOf("comment", "reply", "mention", "tag", "share", "invite", "message", "reaction", "other")

/** The routes that ship with Ghost Browser (roadmap Phase 2): a toggle each in the watcher editor. */
data class DefaultRoute(val label: String, val kinds: List<String>, val flowId: String)
val DEFAULT_ROUTES = listOf(
    DefaultRoute("mention/tag → context reply", listOf("mention", "tag"), "reply-draft-context-aware"),
    DefaultRoute("invite → vet & join", listOf("invite"), "invite-vet-join"),
    DefaultRoute("share → thank-you", listOf("share"), "share-thank-you"),
)

/** Serialize routes as the JSON the cluster stores (`followUps`), without a JSON library in commonMain. */
fun routesToJson(routes: List<FollowUpRoute>): String {
    val q = { s: String -> "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"" }
    return routes.filter { it.flowId.isNotBlank() }.joinToString(",", "[", "]") { r ->
        "{\"kinds\":" + r.kinds.joinToString(",", "[", "]") { q(it) } + ",\"flowId\":" + q(r.flowId) + "}"
    }
}

/** One collected item in a watcher's results — schema-agnostic: whatever fields it has, plus an
 *  optional image and link. Rendered by the results view; a follow-up flow can run on it. */
data class ResultItem(
    val title: String,
    val fields: List<Pair<String, String>>,
    val url: String,
    val image: String,
    val kind: String,
    val draft: String = "",        // a ready draft (from a follow-up flow), editable + approvable in place
    val jobId: String = "",        // the job holding the draft proposal (for approve/deny)
    val pid: String = "",          // the pending proposal id (approve = post, deny = skip)
    val feedKey: String = "",      // this item's key in the watcher feed (to mark handled)
    val handled: Boolean = false,
    val draftState: String = "",   // "" | drafting | drafted | none | skipped-old | posting | post-failed | handled
    val postId: String = "",       // the post this item belongs to (cards group by it)
    val postTitle: String = "",    // first words of that post
    val why: String = "",          // why this is (or is not) yours: "replied to you", "mentions you", …
    val thread: String = "",       // the branch as a transcript ("YOU: …\nJoe: …"), what you'd open Facebook to read
    val lead: Boolean = false,     // this person showed buying interest somewhere (people memory) — a lead
)
