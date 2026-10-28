package engineer.myapp.gb.shared

import androidx.compose.runtime.mutableStateOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * The web console's reactive state + cluster repository — the same job DesktopState + the loaders in
 * DesktopScreens/AssistantD do on the desktop, ported to same-origin fetch + coroutines. No JCEF, no
 * threads, no org.json: the screens read this state; the repo fills it from GB's /v1 API.
 */
class WebState {
    val connected = mutableStateOf(false)
    // browser/home
    val platforms = mutableStateOf<List<PlatformOpt>>(emptyList())
    val feed = mutableStateOf(HOME_FEED)
    val homeLoading = mutableStateOf(false)
    // accounts panel — connected/sign-in/live summary + per-platform state
    val platformsSummary = mutableStateOf<PlatformsSummary?>(null)
    // flows
    val flows = mutableStateOf<List<FlowInfo>>(emptyList())
    val flowsLoading = mutableStateOf(false)
    val actionRecordings = mutableStateOf<List<ActionRecordingInfo>>(emptyList())
    val recordingsError = mutableStateOf("")
    // watchers (scheduled background tasks) + their results artifact
    val watchers = mutableStateOf<List<Watcher>>(emptyList())
    val watchersLoading = mutableStateOf(false)
    val watcherRoles = mutableStateOf<List<String>>(emptyList())
    val watcherProfiles = mutableStateOf(listOf("facebook"))
    val watcherRaw = HashMap<String, String>()   // id -> raw workflow JSON, for the toggle
    val artifactVisible = mutableStateOf(false)
    val artifactName = mutableStateOf("")
    val artifactWid = mutableStateOf("")
    val artifactLoading = mutableStateOf(false)
    val artifactItems = mutableStateOf<List<ResultItem>>(emptyList())
    // approvals
    val jobs = mutableStateOf<List<JobInfo>>(emptyList())
    val jobsLoading = mutableStateOf(false)
    val leads = mutableStateOf<List<PersonInfo>>(emptyList())
    // live browser session (the Browser tab drives the cluster's real Chromium)
    val sessionId = mutableStateOf("")
    val sessionProfile = mutableStateOf("")
    val sessionUrl = mutableStateOf("")
    val sessionBusy = mutableStateOf(false)
    val sessionError = mutableStateOf("")
    // assistant (shared UI holder) + AI-model editor + downloads
    val assistant = AssistantUi()
    val aiModel = AiModelUi()
    val apiTokens = ApiTokensUi()
    val downloads = DownloadsUi()
    // last activity line (surfaced in Settings)
    val activity = mutableStateOf("")
    fun log(s: String) { activity.value = (s + "\n" + activity.value).take(4000) }
}

/** Curated home feed (the desktop scrapes my-app.engineer/learn/, blocked cross-origin here — keep it real + local). */
private val HOME_FEED = listOf(
    LearnItem("no-api", "Work where there is no API", "Ghost Browser drives the real browser behind logins and Cloudflare."),
    LearnItem("watchers", "Watchers that never sleep", "Background roles run on the cluster and draft actions for your yes."),
    LearnItem("approvals", "Nothing sent without your yes", "Every outward action waits in the approval gate first."),
    LearnItem("flows", "Automations you can run", "Save a browser workflow once, fire it on the cluster any time."),
)

/** The reply-desk watch goal: watch this platform, draft, and gate every outward act on approval. */
private const val WATCH_GOAL = "Open this platform's notifications and my recent posts. For each NEW comment, reply or message that is genuinely mine to answer, read the whole thread for context and draft ONE natural reply. Propose EVERY reply for my approval — never post without approval. Skip threads that are hostile, off-topic, or already handled. Keep watching and check back periodically."

/** Default goal for a role-mode watcher created without a specific instruction. */
private const val DEFAULT_WATCH_GOAL = "Run your watch now: carry out this role's task and record what you find with collect (or save_lead). Propose any action that others would see for my approval — never act without it. If nothing needs doing, finish."

class WebRepo(private val scope: CoroutineScope, val st: WebState) {

    private fun ok(o: JsonObject?): Boolean { if (o != null && !o.hasError()) { st.connected.value = true; st.assistant.connected.value = true }; return o != null && !o.hasError() }

    // ── Home ────────────────────────────────────────────────────────────────────────────────────
    /* ── who is signed in, and the password that opens the instance without the platform ─────── */
    fun authState(onDone: (signedIn: Boolean, hasPassword: Boolean, username: String) -> Unit) = scope.launch {
        val o = jparse(api("GET", "/api/auth/state"))
        onDone(o.bool("signedIn"), o.bool("hasPassword"), o.str("username"))
    }
    fun login(email: String, password: String, onDone: (ok: Boolean, message: String) -> Unit) = scope.launch {
        val o = jparse(api("POST", "/api/auth/login", buildJsonObject { put("username", email); put("password", password) }.toString()))
        val ok = o != null && !o.hasError() && o.str("username").isNotBlank()
        onDone(ok, if (ok) "signed in as ${o.str("username")}" else "sign-in failed: ${o.str("error", "no answer from the cluster")}")
    }
    fun setPassword(password: String, onDone: (ok: Boolean, message: String) -> Unit) = scope.launch {
        val o = jparse(api("POST", "/api/auth/password", buildJsonObject { put("password", password) }.toString()))
        val ok = o != null && !o.hasError() && o.bool("ok")
        onDone(ok, if (ok) "password set — your email and this password open this Ghost Browser on any device" else "not set: ${o.str("error", "no answer from the cluster")}")
    }

    fun loadHome() = scope.launch {
        st.homeLoading.value = true
        val o = jparse(api("GET", "/v1/profiles/presets"))
        if (ok(o)) {
            st.platforms.value = (o.arr("presets")?.objs() ?: emptyList()).mapNotNull { p ->
                val key = p.str("key"); val site = p.str("site")
                if (key.isBlank() || site.isBlank()) null
                // profile = the preset key (what POST /v1/sessions expects), NOT a p_ display id
                else PlatformOpt(p.str("label", key).ifBlank { key }, site, key.lowercase(), false)
            }
        }
        st.homeLoading.value = false
    }

    // ── Accounts panel (connected/sign-in/live + per-platform Watch) ──────────────────────────────
    fun loadPlatformState() = scope.launch {
        val po = jparse(api("GET", "/v1/platforms"))
        if (!ok(po)) return@launch
        val so = jparse(api("GET", "/v1/sessions"))
        /* The console is served every session on the install, so the Live tile can name what holds a
           profile instead of only counting. */
        val sess = (so.arr("sessions")?.objs() ?: emptyList()).map { s ->
            SessionState(
                id = s.str("sessionId").ifBlank { s.str("id") },
                profile = s.str("profile"),
                url = s.str("url"),
                owner = s.str("owner"),
                yours = s.bool("yours"),
                job = s.str("job"),
            )
        }
        val live = sess.size
        val plats = (po.arr("platforms")?.objs() ?: emptyList()).map { p ->
            val roles = p.obj("roles")
            val watchRole = roles.str("dm").ifBlank { roles.str("reply") }.ifBlank { roles.str("scout") }
            PlatformState(p.str("key"), p.str("label", p.str("key")).ifBlank { p.str("key") }, p.str("site"), p.bool("signedIn"), watchRole)
        }
        st.platformsSummary.value = PlatformsSummary(plats.count { it.signedIn }, plats.count { !it.signedIn }, live, plats, sess)
    }

    /** Close one session and free its profile — the way out of "that profile is busy". */
    fun stopSession(s: SessionState) = scope.launch {
        st.log("stopping ${s.profile.ifBlank { s.id }}…")
        api("DELETE", "/v1/sessions/${s.id}")
        loadPlatformState()
    }
    fun watchPlatform(p: PlatformState) = scope.launch {
        if (p.watchRole.isBlank()) return@launch
        st.log("opening ${p.label}…")
        val s = jparse(api("POST", "/v1/sessions", jbody {
            put("reuse", kotlinx.serialization.json.JsonPrimitive(true)); put("profile", kotlinx.serialization.json.JsonPrimitive(p.key))
        }))
        val sid = s.str("sessionId").ifBlank { s.str("id") }
        if (sid.isBlank()) { st.log("watch ${p.label}: could not open a session"); return@launch }
        api("POST", "/v1/agent/jobs", jbody {
            put("role", kotlinx.serialization.json.JsonPrimitive(p.watchRole))
            put("goal", kotlinx.serialization.json.JsonPrimitive(WATCH_GOAL))
            put("sessionId", kotlinx.serialization.json.JsonPrimitive(sid))
        })
        st.log("● watching ${p.label} — drafts land in Approvals")
        loadPlatformState()
    }

    // ── Flows ───────────────────────────────────────────────────────────────────────────────────
    fun loadFlows() = scope.launch {
        st.flowsLoading.value = true
        val o = jparse(api("GET", "/v1/workflows"))
        if (ok(o)) st.flows.value = (o.arr("workflows")?.objs() ?: emptyList()).mapNotNull { w ->
            val id = w.str("id"); if (id.isBlank()) return@mapNotNull null
            val nodes = w.arr("nodes")?.objs() ?: emptyList()
            var profile = ""; var role = ""; val goals = ArrayList<String>()
            nodes.forEach { n -> if (n.str("type") == "recon") goals.add("${n.str("scan", "exposure")}: ${n.str("target")}") else if (n.str("type") == "agent") {
                if (profile.isBlank()) profile = n.str("profile")
                if (role.isBlank()) role = n.str("role")
                n.str("goal").takeIf { it.isNotBlank() }?.let { goals.add(it) }
            } }
            val runs = w.int("runs")
            val last = if (runs > 0) "$runs runs, last ${w.str("lastRunStatus", "?")}" else "never run"
            FlowInfo(id, w.str("name", id).ifBlank { id }, nodes.size, last, profile, role, goals, runs, w.str("lastRunStatus"), w.bool("lastVerified"), w.str("kind", "browser"))
        }
        st.flowsLoading.value = false
    }

    fun runFlow(id: String, goal: String) = scope.launch {
        val body = if (goal.isBlank()) "{}" else jbody { put("input", kotlinx.serialization.json.buildJsonObject { put("goal", kotlinx.serialization.json.JsonPrimitive(goal)) }) }
        val r = jparse(api("POST", "/v1/workflows/$id/run", body))
        st.log(if (r != null && !r.hasError()) "▶ run started — its action lands in Approvals" else "! run failed")
        loadApprovals()
    }

    fun createFlow(name: String, steps: String) = scope.launch {
        val goals = steps.split("\n").map { it.trim() }.filter { it.isNotEmpty() }
        val nodes = buildString {
            append("[{\"id\":\"trigger\",\"type\":\"trigger\",\"label\":\"Manual\"}")
            goals.forEachIndexed { i, g -> append(",{\"id\":\"n$i\",\"type\":\"agent\",\"label\":\"Step ${i + 1}\",\"goal\":${jsonStr(g)}}") }
            append("]")
        }
        val edges = buildString {
            append("["); var prev = "trigger"
            goals.forEachIndexed { i, _ -> if (i > 0) append(","); append("{\"from\":${jsonStr(prev)},\"to\":\"n$i\"}"); prev = "n$i" }
            append("]")
        }
        api("POST", "/v1/workflows", "{\"name\":${jsonStr(name)},\"nodes\":$nodes,\"edges\":$edges}")
        st.log("+ created automation: $name"); loadFlows()
    }

    fun createSecurityFlow(name: String, target: String, scan: String, prompt: String) = scope.launch {
        val nodes = buildJsonArray {
            add(buildJsonObject { put("id", "trigger"); put("type", "trigger"); put("label", "Manual") })
            add(buildJsonObject { put("id", "recon"); put("type", "recon"); put("label", "Security recon"); put("target", target); put("scan", scan); put("prompt", prompt) })
        }
        val edges = buildJsonArray { add(buildJsonObject { put("from", "trigger"); put("to", "recon") }) }
        api("POST", "/v1/workflows", buildJsonObject { put("name", name); put("nodes", nodes); put("edges", edges) }.toString())
        st.log("+ created security automation: $name"); loadFlows()
    }

    // ── Live browser session ──────────────────────────────────────────────────────────────────────
    /** Open (or reuse) a real cluster Chromium session for a profile; the Browser tab live-views it. */
    fun openSession(profile: String, startUrl: String = "") = scope.launch {
        st.sessionBusy.value = true; st.sessionError.value = ""
        val o = jparse(api("POST", "/v1/sessions", jbody {
            put("reuse", kotlinx.serialization.json.JsonPrimitive(true))
            put("profile", kotlinx.serialization.json.JsonPrimitive(profile))
        }))
        val sid = o.str("sessionId").ifBlank { o.str("id") }
        if (sid.isBlank()) { st.sessionError.value = o.str("error").ifBlank { "could not open the session — sign in on this origin" }; st.sessionBusy.value = false; return@launch }
        ok(o); st.sessionProfile.value = profile; st.sessionId.value = sid
        if (startUrl.isNotBlank()) navigateNow(sid, startUrl)
        st.sessionBusy.value = false
    }
    fun navigate(url: String) = scope.launch { val sid = st.sessionId.value; if (sid.isNotBlank() && url.isNotBlank()) navigateNow(sid, normalizeUrl(url)) }
    private suspend fun navigateNow(sid: String, url: String) { api("POST", "/v1/sessions/$sid/navigate", "{\"url\":${jsonStr(url)}}") }
    fun closeSession() { st.sessionId.value = ""; st.sessionProfile.value = ""; st.sessionUrl.value = "" }
    private fun normalizeUrl(raw: String): String {
        val u = raw.trim()
        return when {
            u.startsWith("http://") || u.startsWith("https://") -> u
            u.contains(".") && !u.contains(" ") -> "https://$u"
            else -> "https://www.google.com/search?q=" + u.replace(" ", "+")
        }
    }

    // ── Watchers (scheduled workflows) ────────────────────────────────────────────────────────────
    fun loadWatchers() = scope.launch {
        st.watchersLoading.value = true
        jparse(api("GET", "/v1/agent/roles"))?.arr("roles")?.objs()?.mapNotNull { it.str("name").ifBlank { null } }?.takeIf { it.isNotEmpty() }?.let { st.watcherRoles.value = it }
        jparse(api("GET", "/v1/profiles"))?.arr("profiles")?.let { pa ->
            val names = pa.mapNotNull { e ->
                when (e) {
                    is JsonObject -> e.str("name").ifBlank { e.str("id") }
                    is JsonPrimitive -> e.contentOrNull
                    else -> null
                }
            }.filter { it.isNotBlank() && !it.startsWith("lost+") }
            if (names.isNotEmpty()) st.watcherProfiles.value = names
        }
        val o = jparse(api("GET", "/v1/workflows"))
        if (ok(o)) {
            st.watcherRaw.clear()
            val out = ArrayList<Watcher>()
            for (w in o.arr("workflows")?.objs() ?: emptyList()) {
                val nodes = w.arr("nodes")?.objs() ?: emptyList()
                var trig: JsonObject? = null; var agent: JsonObject? = null; var reconNode: JsonObject? = null; var steps = 0
                for (n in nodes) {
                    if (n.str("type") == "trigger") trig = n.obj("trigger")
                    else { steps++; if (n.str("type") == "agent" && agent == null) agent = n; if (n.str("type") == "recon" && reconNode == null) reconNode = n }
                }
                val cfg = trig ?: w.obj("trigger")
                if (cfg == null || cfg.str("type") != "schedule") continue
                val id = w.str("id"); if (id.isBlank()) continue
                st.watcherRaw[id] = w.toString()
                val nmin = maxOf(1, cfg.int("n", 1)); val runs = w.int("runs")
                val last = if (runs > 0) "$runs runs, last ${w.str("lastRunStatus", "?")}" else "never run"
                val fcfg = jparse(api("GET", "/v1/watchers/$id/config")) ?: JsonObject(emptyMap())
                val h = jparse(api("GET", "/v1/watchers/$id/health")) ?: JsonObject(emptyMap())
                out.add(Watcher(
                    id, w.str("name", id).ifBlank { id }, reconNode.str("scan").ifBlank { agent.str("role").ifBlank { "general" } }, agent.str("profile"),
                    nmin, w.bool("active"), last, 0, reconNode.str("target").ifBlank { agent.str("goal") },
                    if (steps > 1) "automation" else if (reconNode != null) "security" else "role", steps,
                    fcfg.str("followUpFlowId"), (fcfg.arr("followUpKinds")?.size ?: 0) > 0,
                    followUps = routesOf(fcfg.arr("followUps")), health = healthLine(h),
                    stale = h.bool("stale"), running = h.bool("running"), kind = w.str("kind", if (reconNode != null) "security" else "browser"),
                ))
            }
            st.watchers.value = out
        }
        st.watchersLoading.value = false
    }
    private fun routesOf(a: kotlinx.serialization.json.JsonArray?): List<FollowUpRoute> =
        (a?.objs() ?: emptyList()).map { o -> FollowUpRoute(o.arr("kinds")?.strings() ?: emptyList(), o.str("flowId")) }
    private fun healthLine(o: JsonObject): String {
        val lp = o.obj("lastPass") ?: return if (o.bool("running")) "first pass running…" else "no pass yet"
        return buildString {
            if (o.bool("running")) append("running · ") else o.int("sinceMinutes", -1).takeIf { it >= 0 }?.let { append("$it min ago · ") }
            append("${lp.int("messages")} messages · ${lp.int("waiting")} waiting")
            if (lp.int("verified") > 0) append(" · ${lp.int("verified")} verified, ${lp.int("corrected")} corrected")
            if (lp.int("drafts") > 0) append(" · ${lp.int("drafts")} new drafts")
        }
    }
    fun toggleWatcher(id: String, active: Boolean) = scope.launch {
        val raw = st.watcherRaw[id] ?: return@launch
        val obj = jparse(raw) ?: return@launch
        val body = buildJsonObject { obj.forEach { (k, v) -> if (k != "active") put(k, v) }; put("active", active) }.toString()
        api("PUT", "/v1/workflows/$id", body); loadWatchers()
    }
    fun saveWatcher(id: String?, name: String, mode: String, role: String, goal: String, profile: String, automationId: String, intervalMin: Int, followUpFlowId: String, followUpRepliesOnly: Boolean) = scope.launch {
        val stepNodes = ArrayList<JsonObject>()
        if (mode == "automation") {
            val full = jparse(api("GET", "/v1/workflows/$automationId"))
            var k = 0
            for (n in full.arr("nodes")?.objs() ?: emptyList()) {
                if (n.str("type") == "trigger") continue
                val nid = "n$k"; k++
                stepNodes.add(buildJsonObject { n.forEach { (kk, vv) -> if (kk != "id") put(kk, vv) }; put("id", nid) })
            }
            if (k == 0) { st.log("that automation has no steps"); return@launch }
        } else if (mode == "security") {
            stepNodes.add(buildJsonObject { put("id", "n0"); put("type", "recon"); put("label", "Security recon"); put("scan", role); put("target", goal) })
        } else {
            stepNodes.add(buildJsonObject { put("id", "n0"); put("type", "agent"); put("label", "Watch"); put("role", role); put("profile", profile); put("goal", goal.ifBlank { DEFAULT_WATCH_GOAL }) })
        }
        val nodes = buildJsonArray {
            add(buildJsonObject { put("id", "trigger"); put("type", "trigger"); put("label", "Every $intervalMin min"); putJsonObject("trigger") { put("type", "schedule"); put("every", "minute"); put("n", intervalMin) } })
            stepNodes.forEach { add(it) }
        }
        val edges = buildJsonArray { var prev = "trigger"; stepNodes.forEach { n -> val nid = n.str("id"); add(buildJsonObject { put("from", prev); put("to", nid) }); prev = nid } }
        val body = buildJsonObject { put("name", name); put("active", true); put("autoApprove", false); put("nodes", nodes); put("edges", edges) }.toString()
        val res = if (id.isNullOrBlank()) api("POST", "/v1/workflows", body) else api("PUT", "/v1/workflows/$id", body)
        val wid = if (!id.isNullOrBlank()) id else jparse(res).str("id")
        if (wid.isNotBlank()) putWatcherConfig(wid, followUpFlowId, followUpRepliesOnly)
        st.log(if (id.isNullOrBlank()) "watcher \"$name\" created" else "watcher \"$name\" saved")
        loadWatchers()
    }
    private suspend fun putWatcherConfig(wid: String, followUpFlowId: String, repliesOnly: Boolean) {
        val body = if (followUpFlowId.startsWith("[")) buildJsonObject {
            put("followUps", jparseArray(followUpFlowId) ?: buildJsonArray {})
            put("followUpFlowId", ""); put("followUpKinds", buildJsonArray {})
        } else buildJsonObject {
            put("followUpFlowId", followUpFlowId)
            put("followUpKinds", buildJsonArray { if (repliesOnly) { add("reply"); add("comment"); add("mention") } })
            put("followUps", buildJsonArray {})
        }
        api("PUT", "/v1/watchers/$wid/config", body.toString())
    }

    // ── Watcher results artifact ──────────────────────────────────────────────────────────────────
    fun openWatcherResults(id: String) = scope.launch {
        st.artifactName.value = st.watchers.value.firstOrNull { it.id == id }?.name ?: "Watcher"
        st.artifactWid.value = id; st.artifactItems.value = emptyList(); st.artifactLoading.value = true; st.artifactVisible.value = true
        loadWatcherFeed(id)
        st.artifactLoading.value = false
    }
    private suspend fun loadWatcherFeed(id: String) {
        val hidden = setOf("thread", "why", "postTitle", "postId", "rootId", "commentId")
        val items = (jparse(api("GET", "/v1/watchers/$id/feed")).arr("items")?.objs() ?: emptyList()).filter { !it.bool("handled") }.map { it ->
            val f = it.obj("fields")
            val fields = (f?.keys ?: emptySet()).filter { k -> k !in hidden }.mapNotNull { k -> f.str(k).takeIf { v -> v.isNotBlank() }?.let { v -> k to v } }
            ResultItem(it.str("title"), fields, it.str("url"), it.str("image"), it.str("kind").ifBlank { "item" },
                draft = it.str("draft"), jobId = it.str("draftJobId"), pid = it.str("draftPid"), feedKey = it.str("key"), handled = false,
                draftState = it.str("draftState"), postId = f.str("postId"), postTitle = f.str("postTitle"), why = f.str("why"), thread = f.str("thread"), lead = f.bool("lead"), readOnly = it.bool("readOnly"))
        }
        st.artifactItems.value = items
    }
    fun approveDraft(item: ResultItem, edited: String) = scope.launch {
        val wid = st.artifactWid.value; if (wid.isBlank() || item.feedKey.isBlank()) return@launch
        /*
         * confirm=true, because PRESSING APPROVE IS THE APPROVAL.
         *
         * The server reads `confirm` to decide whether to press Wyslij on useme's summary page.
         * Omitting it meant every approved gig offer filled the form, advanced to the summary,
         * verified its own price and body — and stopped one click short, with the client never
         * seeing it. The feed then recorded posted:"summary", which reads like success unless you
         * know that only "submitted" means sent. Neither UI has ever been able to finish a send.
         *
         * Sending stays gated on a human. This IS that human, and they already said yes.
         */
        api("POST", "/v1/watchers/$wid/feed/approve", buildJsonObject { put("key", item.feedKey); put("text", edited); put("confirm", true) }.toString())
        loadWatcherFeed(wid)
    }
    fun denyDraft(item: ResultItem) = scope.launch {
        val wid = st.artifactWid.value; if (wid.isBlank() || item.feedKey.isBlank()) return@launch
        api("POST", "/v1/watchers/$wid/feed/deny", buildJsonObject { put("key", item.feedKey) }.toString())
        loadWatcherFeed(wid)
    }
    fun runFlowOnItem(flowId: String, item: ResultItem) = scope.launch {
        val input = buildJsonObject {
            if (item.title.isNotBlank()) { put("title", item.title); put("name", item.title) }
            if (item.url.isNotBlank()) put("url", item.url)
            item.fields.forEach { (k, v) -> put(k, v) }
        }
        api("POST", "/v1/workflows/$flowId/run", buildJsonObject { put("input", input) }.toString())
        st.log("flow started — its action lands in Approvals")
    }
    fun watchPost(url: String) = scope.launch {
        val wid = st.artifactWid.value; if (wid.isBlank()) return@launch
        api("POST", "/v1/watchers/$wid/posts", buildJsonObject { put("url", url) }.toString()); st.log("watching that post")
    }
    fun mutePost(postId: String) = scope.launch {
        val wid = st.artifactWid.value; if (wid.isBlank() || postId.isBlank()) return@launch
        api("DELETE", "/v1/watchers/$wid/posts", buildJsonObject { put("url", "https://www.facebook.com/?post_id=$postId") }.toString())
        loadWatcherFeed(wid)
    }

    fun loadActionRecordings() = scope.launch {
        val o = jparse(api("GET", "/v1/route-cards"))
        st.recordingsError.value = if (ok(o)) "" else "Could not load recordings. Check the connection and refresh."
        if (ok(o)) st.actionRecordings.value = (o.arr("cards")?.objs() ?: emptyList()).map { c ->
            ActionRecordingInfo(c.str("id"), c.str("origin"), c.str("intent"), c.str("kind"), c.str("status"), c.str("reason"), c.int("uses"), c.str("lastVerifiedLabel"))
        }
    }

    // ── Approvals ───────────────────────────────────────────────────────────────────────────────
    fun loadApprovals() = scope.launch {
        st.jobsLoading.value = true
        jparse(api("GET", "/v1/people?platform=facebook"))?.let { pe ->
            st.leads.value = (pe.arr("people")?.objs() ?: emptyList()).map { p ->
                PersonInfo(p.str("name"), p.str("platform"), p.int("worth"), p.bool("lead"), p.int("repliedBack"),
                    p.int("exchanges"), p.int("posts"), p.arr("signals")?.strings() ?: emptyList(),
                    p.arr("promises")?.strings() ?: emptyList(), p.long("lastSeen"))
            }.filter { it.lead || it.worth >= 20 }
        }
        val o = jparse(api("GET", "/v1/agent/jobs"))
        if (ok(o)) st.jobs.value = (o.arr("jobs")?.objs() ?: emptyList()).map { j ->
            val stepsArr = j.arr("steps")?.objs() ?: emptyList()
            val steps = stepsArr.takeLast(8).map { s ->
                val kind = s.str("kind"); val txt = s.str("text").ifBlank { s.str("detail") }
                (if (kind.isNotBlank()) "$kind: " else "") + txt
            }
            val props = (j.arr("proposals")?.objs() ?: emptyList()).filter { it.str("state") == "pending" }.map { p ->
                Proposal(j.str("id"), p.str("pid"), p.str("kind").ifBlank { "reply" },
                    p.str("why").ifBlank { p.str("label") }, p.str("url"), p.str("text"), j.str("role"))
            }
            JobInfo(j.str("id"), j.str("role"), j.str("status"), steps, props,
                j.obj("data").obj("execution").let { e ->
                    if (e.str("mode").isBlank()) "No execution evidence · Older run or unsupported executor"
                    else e.str("mode") + " · " + e.str("input") + "\n" + e.str("reason") +
                        (if (e.str("recording").isBlank()) "" else "\nRecording: " + e.str("recording")) +
                        (if (e.bool("verified")) "\nVerified outcome" else "\nOutcome not verified") +
                        j.obj("data").obj("capture").let { c -> if (c.bool("saved")) "\nCaptured: " + c.str("recording") + " · " + c.str("reason") else "" }
                })
        }
        st.jobsLoading.value = false
    }

    fun approve(jobId: String, pid: String, edited: String) = scope.launch {
        api("POST", "/v1/agent/jobs/$jobId/proposals/$pid", "{\"approve\":true,\"edit\":${jsonStr(edited)}}"); loadApprovals()
    }
    fun deny(jobId: String, pid: String) = scope.launch {
        api("POST", "/v1/agent/jobs/$jobId/proposals/$pid", "{\"approve\":false}"); loadApprovals()
    }
    fun stopJob(jobId: String) = scope.launch { api("POST", "/v1/agent/jobs/$jobId/stop", "{}"); loadApprovals() }
    fun sayJob(jobId: String, text: String) = scope.launch { api("POST", "/v1/agent/jobs/$jobId/say", "{\"text\":${jsonStr(text)}}"); loadApprovals() }

    // ── Downloads ───────────────────────────────────────────────────────────────────────────────
    fun loadDownloads() = scope.launch {
        st.downloads.loading.value = true
        val o = jparse(api("GET", "/v1/files"))
        if (ok(o)) st.downloads.files.value = (o.arr("files")?.objs() ?: emptyList()).map { f ->
            FileInfo(f.str("id"), f.str("name").ifBlank { f.str("id") }, f.str("kind"), f.str("mime"), f.long("size"),
                f.long("at"), f.str("source"))
        }.sortedByDescending { it.at }
        st.downloads.loading.value = false
    }
    fun deleteFile(id: String) = scope.launch { api("DELETE", "/v1/files/$id"); loadDownloads() }

    // ── Assistant (thin client; the agent lives on the cluster) ───────────────────────────────────
    private var chatId = ""
    private var polling = false

    fun openAssistant() = scope.launch {
        loadModel()
        val o = jparse(api("GET", "/v1/assistant/chats"))
        if (!ok(o)) { st.assistant.error.value = "Sign in to your Ghost Browser first."; return@launch }
        val list = parseChats(o)
        st.assistant.chats.value = list
        val first = list.firstOrNull { !it.running } ?: list.firstOrNull()
        if (first != null) loadChat(first.id) else newChat()
    }
    fun refreshChats() = scope.launch { jparse(api("GET", "/v1/assistant/chats"))?.let { st.assistant.chats.value = parseChats(it) } }

    fun loadChat(id: String) = scope.launch { loadChatInner(id) }
    private suspend fun loadChatInner(id: String) {
        val v = parseChat(api("GET", "/v1/assistant/chats/$id"))
        if (v == null) { st.assistant.error.value = "Could not reach your Ghost Browser."; return }
        chatId = v.id; st.assistant.chat.value = v; st.assistant.error.value = ""
        if (v.live != null && !polling) {
            polling = true
            scope.launch {
                try {
                    while (true) {
                        delay(2500)
                        val cur = parseChat(api("GET", "/v1/assistant/chats/$chatId")) ?: break
                        st.assistant.chat.value = cur
                        if (cur.live == null) break
                    }
                } finally { polling = false }
            }
        }
    }
    fun newChat() = scope.launch {
        val v = parseChat(api("POST", "/v1/assistant/chats", "{}"))
        if (v != null) { chatId = v.id; st.assistant.chat.value = v; st.assistant.error.value = "" }
        else st.assistant.error.value = "Could not start a chat — is your Ghost Browser connected?"
        jparse(api("GET", "/v1/assistant/chats"))?.let { st.assistant.chats.value = parseChats(it) }
    }
    fun send(text: String) = scope.launch {
        if (text.isBlank()) return@launch
        st.assistant.chat.value?.let { c -> st.assistant.chat.value = c.copy(turns = c.turns + AssistantTurn("user", text, currentTimeMillisCompat(), spoken = c.live != null)) }
        if (chatId.isBlank()) { val v = parseChat(api("POST", "/v1/assistant/chats", "{}")); if (v == null) { st.assistant.error.value = "Could not start a chat."; return@launch }; chatId = v.id }
        val id = chatId
        api("POST", "/v1/assistant/chats/$id/messages", "{\"text\":${jsonStr(text)}}")
        loadChatInner(id)
    }
    fun stop() = scope.launch { val id = chatId; if (id.isNotBlank()) { api("POST", "/v1/assistant/chats/$id/stop", "{}"); loadChatInner(id) } }
    fun deleteChat(id: String) = scope.launch {
        api("DELETE", "/v1/assistant/chats/$id")
        jparse(api("GET", "/v1/assistant/chats"))?.let { st.assistant.chats.value = parseChats(it) }
        if (id == chatId) { chatId = ""; st.assistant.chat.value = null }
    }

    private suspend fun loadModel() {
        val o = jparse(api("GET", "/v1/agent/settings"))
        if (o != null && !o.hasError()) st.assistant.model.value = o.str("llmModel")
    }

    // ── AI model + keyring editor (writes the GB SERVER settings — used by every device) ───────────
    private fun cleanHost(h: String) = h.trim().removeSuffix("/").removeSuffix("/v1")
    private fun modelJson(host: String, key: String, model: String): String = jbody {
        if (host.isNotBlank()) put("llmHost", kotlinx.serialization.json.JsonPrimitive(cleanHost(host)))
        if (key.isNotBlank()) put("llmKey", kotlinx.serialization.json.JsonPrimitive(key.trim()))
        if (model.isNotBlank()) put("llmModel", kotlinx.serialization.json.JsonPrimitive(model.trim()))
    }
    private fun parseModelInfo(o: JsonObject?): AiModelInfo? {
        if (o == null || o.hasError()) return null
        val usable = o.obj("keyState").int("usable", -1)
        val state = if (usable >= 0) "$usable key(s) usable" else ""
        return AiModelInfo(o.str("llmModel"), o.str("llmHost"), o.bool("keySet"), o.str("keyHint"), state, o.bool("keys2Set"))
    }
    private suspend fun reloadModel() {
        st.aiModel.loading.value = true
        val info = parseModelInfo(jparse(api("GET", "/v1/agent/settings")))
        st.aiModel.loading.value = false
        if (info != null) { st.aiModel.info.value = info; st.assistant.model.value = info.model }
    }
    fun aiModelActions() = AiModelActions(
        onLoad = { scope.launch { reloadModel() } },
        onList = { host, key -> scope.launch {
            st.aiModel.busy.value = true; st.aiModel.note.value = "asking your Ghost Browser…"
            val o = jparse(api("POST", "/v1/agent/models", jbody {
                if (host.isNotBlank()) put("llmHost", kotlinx.serialization.json.JsonPrimitive(cleanHost(host)))
                if (key.isNotBlank()) put("llmKey", kotlinx.serialization.json.JsonPrimitive(key.trim()))
            }))
            val list = o.arr("models")?.strings() ?: emptyList()
            st.aiModel.busy.value = false; st.aiModel.models.value = list
            st.aiModel.note.value = if (list.isEmpty()) "no models — ${o.str("reason", "check the host")}" else "${list.size} models on ${o.str("host").ifBlank { "the host" }}"
        } },
        onTest = { host, key, model -> scope.launch {
            st.aiModel.busy.value = true; st.aiModel.note.value = "testing $model…"
            val o = jparse(api("POST", "/v1/agent/test", modelJson(host, key, model)))
            st.aiModel.busy.value = false
            st.aiModel.note.value = if (o != null && !o.hasError()) "✓ $model answers" else "✗ ${o.str("error", "no answer").take(120)}"
        } },
        onSave = { host, key, model -> scope.launch {
            val o = jparse(api("PUT", "/v1/agent/settings", modelJson(host, key, model)))
            st.aiModel.note.value = if (o != null && !o.hasError()) "✓ saved — the agent now runs on ${o.str("llmModel", model)}" else "✗ ${o.str("error", "no answer").take(120)}"
            reloadModel()
        } },
        onSaveBackups = { backups -> scope.launch {
            val o = jparse(api("PUT", "/v1/agent/settings", jbody { put("llmKeys", kotlinx.serialization.json.JsonPrimitive(backups.trim())) }))
            st.aiModel.note.value = if (o != null && !o.hasError()) "✓ backup key(s) saved — the agent rolls onto them when the main runs dry" else "✗ ${o.str("error", "no answer").take(120)}"
            reloadModel()
        } },
    )

    // ── API tokens (owner-managed Bearer keys, stored on the GB server) ────────────────────────────
    private suspend fun reloadTokens() {
        st.apiTokens.loading.value = true
        val o = jparse(api("GET", "/v1/tokens"))
        st.apiTokens.loading.value = false
        if (o != null && !o.hasError()) {
            st.apiTokens.tokens.value = (o.arr("tokens")?.objs() ?: emptyList()).map {
                ApiTokenRow(it.str("tokenId"), it.str("name"), it.long("createdAt"), it.str("preview"))
            }
        }
    }
    fun apiTokenActions() = ApiTokensActions(
        onLoad = { scope.launch { reloadTokens() } },
        onGenerate = { name -> scope.launch {
            st.apiTokens.busy.value = true; st.apiTokens.note.value = "generating…"
            val o = jparse(api("POST", "/v1/tokens", jbody { if (name.isNotBlank()) put("name", kotlinx.serialization.json.JsonPrimitive(name.trim())) }))
            st.apiTokens.busy.value = false
            if (o != null && !o.hasError()) {
                st.apiTokens.minted.value = o.str("token")
                st.apiTokens.note.value = "✓ token created — copy it now, it is shown only once"
                reloadTokens()
            } else st.apiTokens.note.value = "✗ ${o.str("error", "could not generate").take(120)}"
        } },
        onRevoke = { tokenId -> scope.launch {
            val o = jparse(api("DELETE", "/v1/tokens/$tokenId"))
            st.apiTokens.note.value = if (o != null && !o.hasError()) "✓ revoked" else "✗ ${o.str("error", "could not revoke").take(120)}"
            reloadTokens()
        } },
        onClearMinted = { st.apiTokens.minted.value = null },
    )

    fun assistantActions(openUrl: (String) -> Unit, openApprovals: () -> Unit, openSettings: () -> Unit) = AssistantActions(
        onSend = { send(it) }, onNew = { newChat() }, onOpen = { loadChat(it) }, onDelete = { deleteChat(it) },
        onStop = { stop() },
        onCard = { c -> when (c.kind) { "approvals" -> openApprovals(); "url" -> if (c.url.isNotBlank()) openUrl(c.url); "choice" -> send(c.title) } },
        onRefreshChats = { refreshChats() }, onSettings = openSettings, onClose = {}, onOpenUrl = openUrl, onConnect = openSettings,
    )
}
