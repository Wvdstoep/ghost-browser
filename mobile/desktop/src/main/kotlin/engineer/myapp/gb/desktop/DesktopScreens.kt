package engineer.myapp.gb.desktop

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import engineer.myapp.gb.shared.*
import org.json.JSONObject
import kotlin.concurrent.thread

/** Reactive desktop state the screens read; the node + loaders write to it. */
class DesktopState {
    val reconUi = engineer.myapp.gb.shared.ReconUi()
    val flows = mutableStateOf<List<FlowInfo>>(emptyList())
    val flowsHint = mutableStateOf("Load your automations from the cluster.")
    val devices = mutableStateOf<List<HubDevice>>(emptyList())
    val hubSummary = mutableStateOf("")
    /* The nightly training loop, read from the cluster. One object, read by the Training screen and
       by each device's row in the hub, so the two cannot disagree about the same machine. */
    val training = mutableStateOf(engineer.myapp.gb.shared.TrainingWatch.View())
    /* The runs browser: the rows, and the one run open over the page. */
    val trainingRuns = mutableStateOf<List<engineer.myapp.gb.shared.TrainingWatch.RunRow>>(emptyList())
    /* The scoreboard: every measured round, whatever model trained it. Null until the tab asks. */
    val trainingResults = mutableStateOf<engineer.myapp.gb.shared.TrainingWatch.Results?>(null)
    /* Side by side: what may be compared, and the run being watched. */
    val compareOffer = mutableStateOf<engineer.myapp.gb.shared.TrainingWatch.CompareOffer?>(null)
    val compareRun = mutableStateOf<engineer.myapp.gb.shared.TrainingWatch.CompareRun?>(null)
    val trainingRun = mutableStateOf<engineer.myapp.gb.shared.TrainingWatch.RunDetail?>(null)
    val platforms = mutableStateOf<List<PlatformOpt>>(emptyList())
    /* Profiles as its own surface: the logged-in identities and the role each one uses. */
    val profiles = ProfilesUi()
    /* The nav bar slides off while a page is scrolled down; fed by the page's own scroll. */
    val chrome = engineer.myapp.gb.shared.ChromeScroll()
    val activity = mutableStateOf("")
    val nodeStatus = mutableStateOf("node: connecting…")
    val dark = mutableStateOf(true)
    // the assistant — one chat, one agent on the cluster (shapes in :shared)
    val assistant = engineer.myapp.gb.shared.AssistantUi()
    val aiModel = engineer.myapp.gb.shared.AiModelUi()
    // legacy on-device agent state (kept while AgentD's local tools are retired)
    val agentMsgs = mutableStateOf<List<ChatMsg>>(emptyList())
    val agentBusy = mutableStateOf(false)
    val endpoint = mutableStateOf("")
    val apiKey = mutableStateOf("")
    val model = mutableStateOf("llama3.1")
    var gbJs = ""
    // new-tab home
    val homeFeed = mutableStateOf<List<LearnItem>>(emptyList())
    val homeLoading = mutableStateOf(false)
    // run sheet + AI modal (same UX as the phone)
    val runVisible = mutableStateOf(false)
    val runFlowId = mutableStateOf("")
    val runFlowName = mutableStateOf("")
    val runPhase = mutableStateOf("pick")
    val runStatus = mutableStateOf("")
    val runDevices = mutableStateOf<List<DeviceOpt>>(emptyList())
    val runActivity = mutableStateOf<List<String>>(emptyList())   // live steps in the Run sheet
    val aiModal = mutableStateOf(false)
    val ollamaModels = mutableStateOf<List<String>>(emptyList())
    val ollamaBusy = mutableStateOf(false)
    val ollamaNote = mutableStateOf("")
    // approvals gate — running watchers + their pending proposals (drafts awaiting yes/no)
    val jobs = mutableStateOf<List<engineer.myapp.gb.shared.JobInfo>>(emptyList())
    val jobsLoading = mutableStateOf(false)
    val leads = mutableStateOf<List<engineer.myapp.gb.shared.PersonInfo>>(emptyList())   // people worth your words
    val downloads = engineer.myapp.gb.shared.DownloadsUi()   // every file the cluster browser captured
    // watchers — scheduled background tasks
    val watchers = mutableStateOf<List<engineer.myapp.gb.shared.Watcher>>(emptyList())
    val watchersLoading = mutableStateOf(false)
    val watcherRoles = mutableStateOf<List<String>>(emptyList())
    val watcherProfiles = mutableStateOf<List<String>>(listOf("facebook"))
    val watcherRaw = java.util.Collections.synchronizedMap(HashMap<String, JSONObject>())
    // watcher results artifact (native view)
    val artifactVisible = mutableStateOf(false)
    val artifactName = mutableStateOf("")
    val artifactWid = mutableStateOf("")
    val artifactLoading = mutableStateOf(false)
    val artifactItems = mutableStateOf<List<engineer.myapp.gb.shared.ResultItem>>(emptyList())
    fun log(line: String) { nodeStatus.value = line; activity.value = (activity.value + line + "\n").takeLast(6000) }
}

private fun bg(block: () -> Unit) = thread(isDaemon = true) { block() }

fun loadFlows(st: DesktopState) = bg {
    val r = Cluster.authed("GET", "/v1/workflows", null)
    try {
        val arr = JSONObject(r).optJSONArray("workflows") ?: return@bg
        val out = ArrayList<FlowInfo>()
        for (i in 0 until arr.length()) {
            val w = arr.optJSONObject(i) ?: continue
            val id = w.optString("id"); if (id.isBlank()) continue
            val nodes = w.optJSONArray("nodes") ?: org.json.JSONArray()
            var profile = ""; var role = ""; val goals = ArrayList<String>()
            for (j in 0 until nodes.length()) {
                val nn = nodes.optJSONObject(j) ?: continue
                if (nn.optString("type") == "agent") {
                    if (profile.isBlank()) profile = nn.optString("profile")
                    if (role.isBlank()) role = nn.optString("role")
                    val g = nn.optString("goal"); if (g.isNotBlank()) goals.add(g)
                }
            }
            val runs = w.optInt("runs", 0)
            val verified = w.optBoolean("lastVerified")
            val last = if (runs > 0) "$runs runs, last ${w.optString("lastRunStatus", "?")}" else "never run"
            out.add(FlowInfo(id, w.optString("name", id), nodes.length(), last, profile, role, goals, runs, w.optString("lastRunStatus", ""), verified))
        }
        st.flows.value = out
        st.flowsHint.value = if (out.isEmpty()) "No automations yet." else "${out.size} automations — click Run to fire one."
    } catch (e: Exception) { st.flowsHint.value = "Sign in first (open Ghost Browser from my-app Tools)." }
}

fun loadDevices(st: DesktopState) = bg {
    val r = Cluster.authed("GET", "/v1/device/list", null)
    try {
        val arr = JSONObject(r).optJSONArray("devices") ?: return@bg
        val out = ArrayList<HubDevice>(); var online = 0
        for (i in 0 until arr.length()) {
            val d = arr.optJSONObject(i) ?: continue
            val on = d.optBoolean("online"); if (on) online++
            val caps = d.optJSONObject("caps"); val plat = caps?.optString("platform") ?: ""
            val type = when { plat == "android" -> "PHONE"; plat == "desktop" -> "LAPTOP"; plat == "cluster" -> "CLUSTER"; else -> "NODE" }
            val nm = d.optString("name").ifBlank { d.optString("deviceId") }
            /* Already phrased by the shared code rather than worked out here, so this row and the
               Training screen cannot reach different conclusions about the same machine. */
            val tr = st.training.value.byDevice[nm]
            out.add(HubDevice(nm, d.optString("owner"), type, on, d.optLong("lastSeen", 0), d.optInt("queued", 0),
                engineer.myapp.gb.shared.TrainingWatch.deviceLine(tr), tr?.stale == true))
        }
        st.devices.value = out; st.hubSummary.value = "$online online · ${arr.length()} registered"
    } catch (e: Exception) {}
}

/**
 * The pipeline, read in one call.
 *
 * It also re-phrases the device rows, because the two surfaces are fed from this single answer: a
 * hub row that said "idle" beside a laptop four hours into a round is exactly the failure this is
 * here to prevent, and it would come back the moment either screen derived its own version.
 */
fun loadTraining(st: DesktopState) = bg {
    try {
        val v = engineer.myapp.gb.shared.TrainingWatch.parse(Cluster.authed("GET", "/v1/training/state", null))
        /*
         * The collection loop keeps its own state at its own endpoint, and it is read separately on
         * purpose: a build talking to an older cluster gets a 404 for it and must still show the
         * training page. Folding it into the one reply would turn a missing block into "off", which
         * is a confident wrong answer about something that spends money.
         */
        val h = try { engineer.myapp.gb.shared.TrainingWatch.parseHarvest(Cluster.authed("GET", "/v1/harvest/state", null)) } catch (e: Exception) { null }
        st.training.value = v.copy(harvest = h)
        st.devices.value = st.devices.value.map { d ->
            val tr = v.byDevice[d.name]
            d.copy(training = engineer.myapp.gb.shared.TrainingWatch.deviceLine(tr), trainingStale = tr?.stale == true)
        }
    } catch (e: Exception) { /* a status page is never worth an error over the work it describes */ }
}

/** Let the browser collect its own training data, or stop it. Off is always one tap away. */
fun setHarvest(st: DesktopState, on: Boolean) = bg {
    try { Cluster.authed("POST", "/v1/harvest/on", "{\"on\":" + on + "}") } catch (e: Exception) { }
    loadTraining(st)
}

/** How the trained model is served: a mode, or the model tag to serve. */
fun setServing(st: DesktopState, mode: String?, model: String?) = bg {
    val body = buildString {
        append("{")
        if (mode != null) append("\"mode\":\"").append(mode).append("\"")
        if (mode != null && model != null) append(",")
        if (model != null) append("\"model\":\"").append(model.replace("\"", "")).append("\"")
        append("}")
    }
    try { Cluster.authed("POST", "/v1/training/serving", body) } catch (e: Exception) { }
    loadTraining(st)
}

/** Where rounds run, the provider key, the card, the hard stop - any subset of fields. */
fun setGpu(st: DesktopState, fields: Map<String, String>) = bg {
    val o = JSONObject(); fields.forEach { (k, v) -> o.put(k, v) }
    try { Cluster.authed("POST", "/v1/training/gpu", o.toString()) } catch (e: Exception) { }
    loadTraining(st)
}
fun destroyGpu(st: DesktopState) = bg {
    try { Cluster.authed("POST", "/v1/training/gpu/destroy", "{}") } catch (e: Exception) { }
    loadTraining(st)
}

/** Give the old runs their pages back, or stop. Browser time only; no model credit. */
fun setResight(st: DesktopState, on: Boolean) = bg {
    try { Cluster.authed("POST", "/v1/training/resight", "{\"on\":" + on + "}") } catch (e: Exception) { }
    loadTraining(st)
}

/** Put a round's adapter into service. The cluster refuses one that did not beat its own baseline. */
fun promoteRound(st: DesktopState, id: String) = bg {
    try { Cluster.authed("POST", "/v1/training/rounds/$id/promote", "{}") } catch (e: Exception) { }
    loadTraining(st)
}

/* ── the three controls ───────────────────────────────────────────────────────────────────────── */

/** Whether rounds may start on their own. Absolute: no rule on the cluster overrides it. */
fun setTrainingAuto(st: DesktopState, on: Boolean) = bg {
    try { Cluster.authed("POST", "/v1/training/auto", JSONObject().put("on", on).toString()) } catch (e: Exception) { }
    loadTraining(st)
}

/**
 * Force a round now.
 *
 * Skips the reasons to WAIT — not enough new data, the set already covered — and never the reasons
 * it cannot run: no machine, no set, a round already going. Those are not preferences.
 */
fun runRoundNow(st: DesktopState) = bg {
    try { Cluster.authed("POST", "/v1/training/dispatch", JSONObject().put("force", true).toString()) } catch (e: Exception) { }
    loadTraining(st)
}

/** Allow, or forbid, one machine to take rounds. Default is forbidden — a laptop must not enlist itself. */
fun allowTrainer(st: DesktopState, deviceId: String, on: Boolean) = bg {
    try { Cluster.authed("POST", "/v1/training/trainers/$deviceId", JSONObject().put("on", on).toString()) } catch (e: Exception) { }
    loadTraining(st)
}

/**
 * Build the training environment on a machine that could train but is not set up.
 *
 * It takes several minutes and reports as it goes, so the screen keeps reading while it works — a
 * setup that looks frozen for ten minutes gets cancelled halfway, which leaves exactly the broken
 * half-installed environment it was trying to avoid.
 */
fun setUpTrainer(st: DesktopState, deviceId: String) = bg {
    try { Cluster.authed("POST", "/v1/training/trainers/$deviceId/setup", "{}") } catch (e: Exception) { }
    loadTraining(st)
}

fun loadPlatforms(st: DesktopState) = bg {
    val r = Cluster.authed("GET", "/v1/profiles/presets", null)
    try {
        val arr = JSONObject(r).optJSONArray("presets") ?: return@bg
        val out = ArrayList<PlatformOpt>()
        for (i in 0 until arr.length()) {
            val p = arr.optJSONObject(i) ?: continue
            val key = p.optString("key"); val site = p.optString("site"); if (key.isBlank() || site.isBlank()) continue
            out.add(PlatformOpt(p.optString("label", key).ifBlank { key }, site, "p_" + key.lowercase(), false))
        }
        st.platforms.value = out
    } catch (e: Exception) {}
}

/** The reply-watch goal — mirrors the console Reply Desk: watch notifications, draft, gate every act. */
private const val RD_GOAL_D = "Open Facebook notifications and my recent posts. For each NEW comment or reaction on MY posts, read the whole thread for context, then draft ONE natural reply that continues the conversation and moves toward my-app.engineer only where it genuinely fits. Propose EVERY reply for my approval - never post without approval. Skip threads that are hostile, off-topic, already handled, or where I chose not to engage. Keep watching and check back periodically."

/** The approval gate: pull running watchers + their pending proposals from the jobs engine. */
/** Downloads — the files the cluster browser captured (GET /v1/files); the chat's hooks play/save them. */
fun loadFilesD(st: DesktopState) = bg {
    st.downloads.loading.value = true
    if (engineer.myapp.gb.shared.AssistantHooks.playMedia == null) AssistantD.open(st)   // installs the play/save hooks
    try { st.downloads.files.value = AssistantJson.files(Cluster.authed("GET", "/v1/files", null)) } catch (e: Exception) { st.activity.value = "downloads: ${e.message}" }
    loadRecordingsD(st)
    st.downloads.loading.value = false
}
fun deleteFileD(st: DesktopState, id: String) = bg { try { Cluster.authed("DELETE", "/v1/files/$id", null) } catch (e: Exception) {}; loadFilesD(st) }
/** Recordings (GET /v1/recordings): the list for Downloads and the map the cards in the chat read. */
fun loadRecordingsD(st: DesktopState) {
    try {
        val (list, free) = AssistantJson.recordings(Cluster.authed("GET", "/v1/recordings", null))
        st.downloads.recordings.value = list; st.downloads.recordingsFreeBytes.value = free
        engineer.myapp.gb.shared.RecordingHooks.recordings.value = engineer.myapp.gb.shared.RecordingHooks.recordings.value + list.associateBy { it.id }
    } catch (e: Exception) { st.activity.value = "recordings: ${e.message}" }
}
fun refreshRecordingD(st: DesktopState, id: String) = bg { try { AssistantJson.recording(Cluster.authed("GET", "/v1/recordings/$id", null))?.let { r -> engineer.myapp.gb.shared.RecordingHooks.recordings.value = engineer.myapp.gb.shared.RecordingHooks.recordings.value + (r.id to r) } } catch (e: Exception) {} }
fun stopRecordingD(st: DesktopState, id: String) = bg { try { Cluster.authed("POST", "/v1/recordings/$id/stop", "{}") } catch (e: Exception) {}; loadRecordingsD(st) }
fun deleteRecordingD(st: DesktopState, id: String) = bg { try { Cluster.authed("DELETE", "/v1/recordings/$id", null) } catch (e: Exception) {}; loadRecordingsD(st) }

fun loadApprovals(st: DesktopState) = bg {
    st.jobsLoading.value = true
    try { st.leads.value = AssistantJson.people(Cluster.authed("GET", "/v1/people?platform=facebook", null)) } catch (e: Exception) { /* the section stays hidden */ }
    if (engineer.myapp.gb.shared.AssistantHooks.ask == null) engineer.myapp.gb.shared.AssistantHooks.ask = { t -> AssistantD.ask(st, t) }
    val r = Cluster.authed("GET", "/v1/agent/jobs", null)
    try {
        val arr = JSONObject(r).optJSONArray("jobs") ?: org.json.JSONArray()
        val out = ArrayList<engineer.myapp.gb.shared.JobInfo>()
        for (i in 0 until arr.length()) {
            val j = arr.optJSONObject(i) ?: continue
            val stepsArr = j.optJSONArray("steps") ?: org.json.JSONArray()
            val steps = ArrayList<String>()
            for (k in maxOf(0, stepsArr.length() - 8) until stepsArr.length()) {
                val s = stepsArr.optJSONObject(k) ?: continue
                val kind = s.optString("kind"); val txt = s.optString("text").ifBlank { s.optString("detail") }
                steps.add((if (kind.isNotBlank()) "$kind: " else "") + txt)
            }
            val propArr = j.optJSONArray("proposals") ?: org.json.JSONArray()
            val props = ArrayList<engineer.myapp.gb.shared.Proposal>()
            for (k in 0 until propArr.length()) {
                val p = propArr.optJSONObject(k) ?: continue
                if (p.optString("state") != "pending") continue
                props.add(engineer.myapp.gb.shared.Proposal(
                    jobId = j.optString("id"), pid = p.optString("pid"),
                    kind = p.optString("kind").ifBlank { "reply" },
                    why = p.optString("why").ifBlank { p.optString("label") },
                    url = p.optString("url"), text = p.optString("text"), jobRole = j.optString("role"),
                ))
            }
            out.add(engineer.myapp.gb.shared.JobInfo(j.optString("id"), j.optString("role"), j.optString("status"), steps, props))
        }
        st.jobs.value = out
    } catch (e: Exception) {}
    st.jobsLoading.value = false
}

fun approveD(st: DesktopState, jobId: String, pid: String, edited: String) = bg {
    Cluster.authed("POST", "/v1/agent/jobs/$jobId/proposals/$pid", JSONObject().put("approve", true).put("edit", edited).toString()); loadApprovals(st)
}
fun denyD(st: DesktopState, jobId: String, pid: String) = bg {
    Cluster.authed("POST", "/v1/agent/jobs/$jobId/proposals/$pid", JSONObject().put("approve", false).toString()); loadApprovals(st)
}
fun stopJobD(st: DesktopState, jobId: String) = bg { Cluster.authed("POST", "/v1/agent/jobs/$jobId/stop", "{}"); loadApprovals(st) }
fun sayJobD(st: DesktopState, jobId: String, text: String) = bg { Cluster.authed("POST", "/v1/agent/jobs/$jobId/say", JSONObject().put("text", text).toString()); loadApprovals(st) }
fun startWatchD(st: DesktopState) = bg {
    val s = Cluster.authed("POST", "/v1/sessions", JSONObject().put("reuse", true).put("profile", "facebook").toString())
    val sid = try { JSONObject(s).optString("sessionId") } catch (e: Exception) { "" }
    if (sid.isBlank()) { st.log("! could not open the facebook session"); return@bg }
    Cluster.authed("POST", "/v1/agent/jobs", JSONObject().put("role", "facebook.conversation").put("goal", RD_GOAL_D).put("sessionId", sid).toString())
    st.log("● reply watch running — drafts appear in Approvals"); loadApprovals(st)
}

/* ── Watchers: scheduled background tasks = active workflows with a schedule trigger ──────────────── */
fun loadWatchers(st: DesktopState) = bg {
    st.watchersLoading.value = true
    // roles for the picker
    try {
        val rr = Cluster.authed("GET", "/v1/agent/roles", null)
        val ra = JSONObject(rr).optJSONArray("roles") ?: org.json.JSONArray()
        val rn = ArrayList<String>(); for (i in 0 until ra.length()) ra.optJSONObject(i)?.optString("name")?.takeIf { it.isNotBlank() }?.let { rn.add(it) }
        if (rn.isNotEmpty()) st.watcherRoles.value = rn
    } catch (e: Exception) {}
    // profiles for the picker
    try {
        val pr = Cluster.authed("GET", "/v1/profiles", null)
        val pa = JSONObject(pr).optJSONArray("profiles") ?: org.json.JSONArray()
        val pn = ArrayList<String>()
        for (i in 0 until pa.length()) { val v = pa.opt(i); val nm = if (v is JSONObject) v.optString("name").ifBlank { v.optString("id") } else v?.toString() ?: ""; if (nm.isNotBlank() && !nm.startsWith("lost+")) pn.add(nm) }
        if (pn.isNotEmpty()) st.watcherProfiles.value = pn
    } catch (e: Exception) {}
    // the watchers themselves = scheduled workflows
    val r = Cluster.authed("GET", "/v1/workflows", null)
    try {
        val arr = JSONObject(r).optJSONArray("workflows") ?: org.json.JSONArray()
        val out = ArrayList<engineer.myapp.gb.shared.Watcher>(); st.watcherRaw.clear()
        for (i in 0 until arr.length()) {
            val w = arr.optJSONObject(i) ?: continue
            val nodes = w.optJSONArray("nodes") ?: org.json.JSONArray()
            var trig: JSONObject? = null; var agent: JSONObject? = null; var steps = 0
            for (j in 0 until nodes.length()) {
                val n = nodes.optJSONObject(j) ?: continue
                if (n.optString("type") == "trigger") trig = n.optJSONObject("trigger")
                else { steps++; if (n.optString("type") == "agent" && agent == null) agent = n }
            }
            val cfg = trig ?: w.optJSONObject("trigger")
            if (cfg == null || cfg.optString("type") != "schedule") continue
            val id = w.optString("id"); if (id.isBlank()) continue
            st.watcherRaw[id] = w
            val nmin = maxOf(1, cfg.optInt("n", 1)); val runs = w.optInt("runs", 0)
            val last = if (runs > 0) "$runs runs, last ${w.optString("lastRunStatus", "?")}" else "never run"
            val fcfg = try { JSONObject(Cluster.authed("GET", "/v1/watchers/$id/config", null)) } catch (e: Exception) { JSONObject() }
            val fuFlow = fcfg.optString("followUpFlowId"); val fuReplies = (fcfg.optJSONArray("followUpKinds")?.length() ?: 0) > 0
            val h = try { JSONObject(Cluster.authed("GET", "/v1/watchers/$id/health", null)) } catch (e: Exception) { JSONObject() }
            out.add(engineer.myapp.gb.shared.Watcher(id, w.optString("name", id), agent?.optString("role") ?: "general", agent?.optString("profile") ?: "", nmin, w.optBoolean("active"), last, 0, agent?.optString("goal") ?: "", if (steps > 1) "automation" else "role", steps, fuFlow, fuReplies,
                followUps = routesOfD(fcfg.optJSONArray("followUps")), health = healthLineD(h), stale = h.optBoolean("stale"), running = h.optBoolean("running")))
        }
        st.watchers.value = out
    } catch (e: Exception) {}
    st.watchersLoading.value = false
}
private const val DEFAULT_WATCH_GOAL_D = "Run your watch now: carry out this role's task and record what you find with collect (or save_lead). Propose any action that others would see for my approval — never act without it. If nothing needs doing, finish."
/** Routing config: `followUpFlowId` is a JSON array of routes (starts with "[", the engine form) or a legacy single flow id. */
fun putWatcherConfigD(wid: String, followUpFlowId: String, repliesOnly: Boolean) {
    val body = if (followUpFlowId.startsWith("[")) JSONObject().put("followUps", org.json.JSONArray(followUpFlowId)).put("followUpFlowId", "").put("followUpKinds", org.json.JSONArray())
    else {
        val kinds = if (repliesOnly) org.json.JSONArray().put("reply").put("comment").put("mention") else org.json.JSONArray()
        JSONObject().put("followUpFlowId", followUpFlowId).put("followUpKinds", kinds).put("followUps", org.json.JSONArray())
    }
    Cluster.authed("PUT", "/v1/watchers/$wid/config", body.toString())
}
/** The last pass in one line, from GET /v1/watchers/:id/health. */
private fun healthLineD(o: JSONObject): String = try {
    val lp = o.optJSONObject("lastPass"); val since = o.opt("sinceMinutes")
    if (lp == null) (if (o.optBoolean("running")) "first pass running…" else "no pass yet") else buildString {
        append(when { o.optBoolean("running") -> "running · "; since is Int -> "$since min ago · "; else -> "" })
        append("${lp.optInt("messages")} messages · ${lp.optInt("waiting")} waiting")
        if (lp.optInt("verified") > 0) append(" · ${lp.optInt("verified")} verified, ${lp.optInt("corrected")} corrected")
        if (lp.optInt("drafts") > 0) append(" · ${lp.optInt("drafts")} new drafts")
        val errs = lp.optJSONArray("errors"); if (errs != null && errs.length() > 0) append(" · ${errs.length()} error(s): ${errs.optString(0).take(60)}")
    }
} catch (e: Exception) { "" }
private fun routesOfD(arr: org.json.JSONArray?): List<engineer.myapp.gb.shared.FollowUpRoute> =
    if (arr == null) emptyList() else (0 until arr.length()).mapNotNull { i ->
        val o = arr.optJSONObject(i) ?: return@mapNotNull null
        val ks = o.optJSONArray("kinds") ?: org.json.JSONArray()
        engineer.myapp.gb.shared.FollowUpRoute((0 until ks.length()).map { ks.optString(it) }.filter { it.isNotBlank() }, o.optString("flowId"))
    }
fun saveWatcherD(st: DesktopState, id: String?, name: String, mode: String, role: String, goal: String, profile: String, automationId: String, intervalMin: Int, followUpFlowId: String, followUpRepliesOnly: Boolean) = bg {
    val trigger = JSONObject().put("id", "trigger").put("type", "trigger").put("label", "Every $intervalMin min")
        .put("trigger", JSONObject().put("type", "schedule").put("every", "minute").put("n", intervalMin))
    val nodes = org.json.JSONArray().put(trigger); val edges = org.json.JSONArray()
    if (mode == "automation") {
        val wf = st.flows.value.firstOrNull { it.id == automationId }
        // Fetch the automation's full graph and copy its steps in.
        val full = try { JSONObject(Cluster.authed("GET", "/v1/workflows/$automationId", null)) } catch (e: Exception) { null }
        val steps = full?.optJSONArray("nodes") ?: org.json.JSONArray()
        var prev = "trigger"; var k = 0
        for (i in 0 until steps.length()) {
            val n = steps.optJSONObject(i) ?: continue
            if (n.optString("type") == "trigger") continue
            val nid = "n$k"; k++
            nodes.put(JSONObject(n.toString()).put("id", nid)); edges.put(JSONObject().put("from", prev).put("to", nid)); prev = nid
        }
        if (k == 0) { st.log("! that automation has no steps"); return@bg }
    } else {
        val agent = JSONObject().put("id", "n0").put("type", "agent").put("label", "Watch").put("role", role).put("profile", profile).put("goal", goal.ifBlank { DEFAULT_WATCH_GOAL_D })
        nodes.put(agent); edges.put(JSONObject().put("from", "trigger").put("to", "n0"))
    }
    val body = JSONObject().put("name", name).put("active", true).put("autoApprove", false).put("nodes", nodes).put("edges", edges).toString()
    val res = if (id.isNullOrBlank()) Cluster.authed("POST", "/v1/workflows", body) else Cluster.authed("PUT", "/v1/workflows/$id", body)
    val wid = if (!id.isNullOrBlank()) id else try { JSONObject(res).optString("id") } catch (e: Exception) { "" }
    if (wid.isNotBlank()) putWatcherConfigD(wid, followUpFlowId, followUpRepliesOnly)
    st.log(if (id.isNullOrBlank()) "● watcher \"$name\" created" else "✎ watcher \"$name\" saved")
    loadWatchers(st)
}
fun toggleWatcherD(st: DesktopState, id: String, active: Boolean) = bg {
    val raw = st.watcherRaw[id] ?: return@bg
    try { raw.put("active", active) } catch (e: Exception) {}
    Cluster.authed("PUT", "/v1/workflows/$id", raw.toString()); loadWatchers(st)
}

/** Open a watcher's results: the deduped feed, with drafts correlated from pending proposals by URL. */
fun openWatcherResultsD(st: DesktopState, id: String) = bg {
    st.artifactName.value = st.watchers.value.firstOrNull { it.id == id }?.name ?: "Watcher"
    st.artifactWid.value = id
    st.artifactItems.value = emptyList(); st.artifactLoading.value = true; st.artifactVisible.value = true
    try {
        val feed = JSONObject(Cluster.authed("GET", "/v1/watchers/$id/feed", null)).optJSONArray("items") ?: org.json.JSONArray()
        val items = ArrayList<engineer.myapp.gb.shared.ResultItem>()
        for (i in 0 until feed.length()) { val it = feed.optJSONObject(i) ?: continue
            if (it.optBoolean("handled")) continue
            val f = it.optJSONObject("fields"); val fields = ArrayList<Pair<String, String>>()
            val hidden = setOf("thread", "why", "postTitle", "postId", "rootId", "commentId")   // shown elsewhere on the card
            f?.keys()?.forEach { k -> if (k !in hidden) f.optString(k).takeIf { v -> v.isNotBlank() }?.let { v -> fields.add(k to v) } }
            // The feed item carries its own draft (written back by the follow-up), keyed exactly.
            items.add(engineer.myapp.gb.shared.ResultItem(it.optString("title"), fields, it.optString("url"), it.optString("image"), it.optString("kind").ifBlank { "item" },
                draft = it.optString("draft"), jobId = it.optString("draftJobId"), pid = it.optString("draftPid"), feedKey = it.optString("key"), handled = false,
                draftState = it.optString("draftState"),
                postId = f?.optString("postId") ?: "", postTitle = f?.optString("postTitle") ?: "", why = f?.optString("why") ?: "", thread = f?.optString("thread") ?: "",
                lead = f?.optBoolean("lead") == true, readOnly = it.optBoolean("readOnly")))
        }
        st.artifactItems.value = items
    } catch (e: Exception) { st.log("! results: ${e.message}") }
    st.artifactLoading.value = false
}
// Approve = the cluster re-opens the thread, checks nothing was answered meanwhile, and posts the exact
// text (or hands the yes to a still-parked gate). Deny = mark handled. Both by feed key.
fun approveDraftD(st: DesktopState, item: engineer.myapp.gb.shared.ResultItem, edited: String) = bg {
    val wid = st.artifactWid.value
    if (wid.isBlank() || item.feedKey.isBlank()) return@bg
    try {
        /*
         * confirm=true, because PRESSING APPROVE IS THE APPROVAL.
         *
         * The server reads `confirm` to decide whether to press Wyslij on useme's summary page.
         * Omitting it meant an approved gig offer filled the form, reached the summary, verified its
         * own price and body — and stopped one click short, with the client never seeing it. The
         * feed recorded posted:"summary", which reads like success unless you know that only
         * "submitted" means sent. Sending stays gated on a human; this IS that human.
         */
        Cluster.authed("POST", "/v1/watchers/$wid/feed/approve", JSONObject().put("key", item.feedKey).put("text", edited).put("confirm", true).toString())
        st.log("● approved — the cluster re-checks it, then sends (a gig offer goes to the summary and presses send)")
    } catch (e: Exception) { st.log("! approve: ${e.message}") }
    openWatcherResultsD(st, wid)
}
/** Post watcher: follow a post by its link / stop following one (by post id). */
fun watchPostD(st: DesktopState, url: String) = bg {
    val wid = st.artifactWid.value; if (wid.isBlank()) return@bg
    try { Cluster.authed("POST", "/v1/watchers/$wid/posts", JSONObject().put("url", url).toString()); st.log("● watching that post — its threads appear after the next pass") }
    catch (e: Exception) { st.log("! watch post: ${e.message}") }
}
fun mutePostD(st: DesktopState, postId: String) = bg {
    val wid = st.artifactWid.value; if (wid.isBlank() || postId.isBlank()) return@bg
    try { Cluster.authed("DELETE", "/v1/watchers/$wid/posts", JSONObject().put("url", "https://www.facebook.com/?post_id=$postId").toString()); st.log("○ post muted") }
    catch (e: Exception) { st.log("! mute post: ${e.message}") }
    openWatcherResultsD(st, wid)
}
fun denyDraftD(st: DesktopState, item: engineer.myapp.gb.shared.ResultItem) = bg {
    val wid = st.artifactWid.value
    if (wid.isBlank() || item.feedKey.isBlank()) return@bg
    try { Cluster.authed("POST", "/v1/watchers/$wid/feed/deny", JSONObject().put("key", item.feedKey).toString()); st.log("○ dismissed") }
    catch (e: Exception) { st.log("! deny: ${e.message}") }
    openWatcherResultsD(st, wid)
}
fun runFlowOnItemD(st: DesktopState, flowId: String, item: engineer.myapp.gb.shared.ResultItem) = bg {
    val input = JSONObject()
    if (item.title.isNotBlank()) { input.put("title", item.title); input.put("name", item.title) }
    if (item.url.isNotBlank()) input.put("url", item.url)
    item.fields.forEach { (k, v) -> input.put(k, v) }
    Cluster.authed("POST", "/v1/workflows/$flowId/run", JSONObject().put("input", input).toString())
    st.log("● flow started — its action will appear in Approvals")
}

fun runFlow(id: String, st: DesktopState) = bg {
    st.log("▶ running $id on the cluster…")
    val r = Cluster.authed("POST", "/v1/workflows/$id/run", "{}")
    val runId = try { JSONObject(r).optString("runId") } catch (e: Exception) { "" }
    st.log(if (runId.isNotBlank()) "● started run $runId" else "! run: ${r.take(120)}")
}

/** Open the Run sheet (pick device + goal), same UX as the phone. */
fun showRunSheetD(id: String, name: String, st: DesktopState) {
    st.runFlowId.value = id; st.runFlowName.value = name; st.runPhase.value = "pick"; st.runStatus.value = ""
    val base = mutableListOf(
        DeviceOpt("cluster", "Cluster", "headless · scale · runs now", "☁", true),
        DeviceOpt("auto", "Auto (ring picks the best device)", "for the flow", "🔀", true),
    )
    // add connected nodes (this machine + phones) if we have them
    st.devices.value.forEach { d -> base.add(DeviceOpt("dev:${d.name}", d.name, if (d.online) "${d.type.lowercase()} · connected" else "offline", if (d.type == "PHONE") "📱" else "🖥", d.online)) }
    st.runDevices.value = base
    st.runVisible.value = true
    loadDevices(st)
}

/** Fire the run on the cluster and stream status into the sheet (device target is a routing hint). */
fun runTargetD(target: String, goal: String, st: DesktopState) = bg {
    st.runPhase.value = "running"; st.runStatus.value = "Starting on the cluster…"; st.runActivity.value = emptyList()
    val id = st.runFlowId.value
    val body = if (goal.isBlank()) "{}" else JSONObject().put("input", JSONObject().put("goal", goal)).toString()
    val r = Cluster.authed("POST", "/v1/workflows/$id/run", body)
    val runId = try { JSONObject(r).optString("runId") } catch (e: Exception) { "" }
    if (runId.isBlank()) { st.runStatus.value = "! ${r.take(140)}"; st.runPhase.value = "done"; return@bg }
    st.runStatus.value = "Running…"
    repeat(60) {
        Thread.sleep(3000)
        val rr = Cluster.authed("GET", "/v1/workflow-runs/$runId", null)
        try {
            val o = JSONObject(rr)
            val steps = o.optJSONArray("steps") ?: org.json.JSONArray()
            if (steps.length() > 0) {
                val lines = ArrayList<String>()
                for (i in maxOf(0, steps.length() - 6) until steps.length()) {
                    val s = steps.optJSONObject(i) ?: continue
                    val label = s.optString("type").ifBlank { s.optString("kind") }
                    val detail = s.optString("status").ifBlank { s.optString("text") }
                    lines.add((if (label.isNotBlank()) label else "step") + if (detail.isNotBlank()) " · $detail" else "")
                }
                st.runActivity.value = lines
            }
            val s = o.optString("status")
            if (s.isNotBlank() && s != "running") { st.runStatus.value = "Finished: $s"; st.runPhase.value = "done"; return@bg }
        } catch (e: Exception) {}
        loadApprovals(st)   // a step may hit the gate — surface it in the sheet + badge
    }
    st.runStatus.value = "Still running — check the cluster."; st.runPhase.value = "done"
}

/* ── Flows ─────────────────────────────────────────────────────────────────────────────────── */
@Composable
fun FlowsScreenD(st: DesktopState) {
    val cs = MaterialTheme.colorScheme
    var sub by remember { mutableStateOf(0) }   // 0 = Automations, 1 = Watchers
    LaunchedEffect(Unit) { if (st.flows.value.isEmpty()) loadFlows(st) }
    Column(Modifier.fillMaxSize().background(cs.background)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)
            .clip(RoundedCornerShape(10.dp)).border(1.dp, cs.outline, RoundedCornerShape(10.dp))) {
            listOf("Automations", "Watchers").forEachIndexed { i, lbl ->
                val on = sub == i
                Box(Modifier.weight(1f).clip(RoundedCornerShape(9.dp)).background(if (on) Brand else androidx.compose.ui.graphics.Color.Transparent)
                    .clickable { sub = i; if (i == 1) loadWatchers(st) }.padding(vertical = 9.dp), contentAlignment = Alignment.Center) {
                    Text(lbl, color = if (on) BrandOn else cs.onSurface, fontSize = 13.sp)
                }
            }
        }
        if (sub == 0) FlowsScreen(
            flows = st.flows.value, onLoad = { loadFlows(st) },
            onRun = { id, name -> showRunSheetD(id, name, st) },
            onCreate = { name, steps -> createFlowD(name, steps, st) },
            modifier = Modifier.weight(1f).fillMaxWidth(),
        ) else engineer.myapp.gb.shared.WatchersScreen(
            watchers = st.watchers.value, roles = st.watcherRoles.value, profiles = st.watcherProfiles.value,
            automations = st.flows.value, loading = st.watchersLoading.value,
            onSave = { id, n, m, r, g, p, aid, iv, fuF, fuR -> saveWatcherD(st, id, n, m, r, g, p, aid, iv, fuF, fuR) },
            onToggle = { id, a -> toggleWatcherD(st, id, a) },
            onOpenResults = { openWatcherResultsD(st, it) },
            onRefresh = { loadWatchers(st) }, modifier = Modifier.weight(1f).fillMaxWidth(),
        )
    }
}

fun createFlowD(name: String, steps: String, st: DesktopState) = bg {
    val goals = steps.split("\n").map { it.trim() }.filter { it.isNotEmpty() }
    val nodes = org.json.JSONArray().put(org.json.JSONObject().put("id", "trigger").put("type", "trigger").put("label", "Manual"))
    val edges = org.json.JSONArray(); var prev = "trigger"
    goals.forEachIndexed { i, g -> val nid = "n$i"; nodes.put(org.json.JSONObject().put("id", nid).put("type", "agent").put("label", "Step ${i + 1}").put("goal", g)); edges.put(org.json.JSONObject().put("from", prev).put("to", nid)); prev = nid }
    val body = org.json.JSONObject().put("name", name).put("nodes", nodes).put("edges", edges).toString()
    Cluster.authed("POST", "/v1/workflows", body); st.log("+ created automation: $name"); loadFlows(st)
}

/* ── Device Hub ────────────────────────────────────────────────────────────────────────────── */
@Composable
fun DeviceHubScreenD(st: DesktopState) {
    /* Devices first, then the training lines that go on their rows — a machine deep in a round must
       never read as idle here. */
    LaunchedEffect(Unit) { loadDevices(st); loadTraining(st) }
    // S9: the SAME shared Device Hub the phone uses.
    DeviceHubScreen(st.devices.value, st.hubSummary.value, { loadDevices(st); loadTraining(st) }, System.currentTimeMillis())
}

/* ── Training ──────────────────────────────────────────────────────────────────────────────── */
@Composable
fun TrainingScreenD(st: DesktopState) {
    LaunchedEffect(Unit) { loadTraining(st) }
    /*
     * A round is hours long, so the page keeps reading while it is open — but slowly. This is a
     * status page, not a heartbeat, and the cluster answers it for every app that has it open.
     */
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(if (st.training.value.active != null) 20000 else 60000)
            loadTraining(st)
        }
    }
    engineer.myapp.gb.shared.TrainingScreen(
        st.training.value,
        onRefresh = { loadTraining(st) },
        onPromote = { promoteRound(st, it) },
        onSetAuto = { on -> setTrainingAuto(st, on) },
        onRunNow = { runRoundNow(st) },
        onAllowTrainer = { id, on -> allowTrainer(st, id, on) },
        onSetUpTrainer = { id -> setUpTrainer(st, id) },
        onSetHarvest = { on -> setHarvest(st, on) },
        onSetResight = { on -> setResight(st, on) },
        onSetServing = { mode, model -> setServing(st, mode, model) },
        onSetGpu = { fields -> setGpu(st, fields) },
        onDestroyGpu = { destroyGpu(st) },
        onSetJudge = { on -> setJudge(st, on) },
        onSetPractice = { on -> setPractice(st, on) },
        onSetAutopilot = { on -> setAutopilot(st, on) },
        onStopRound = { id -> stopRound(st, id) },
        onNodeJoin = { kind -> nodeJoin(st, kind) },
        onNodeRevoke = { code -> nodeRevoke(st, code) },
        onSetModal = { fields -> setModal(st, fields) },
        onModalStart = { modalStart(st) },
        onTrialStudents = { models -> trialStudents(st, models) },
        results = st.trainingResults.value,
        onLoadResults = { loadTrainingResults(st) },
        compareOffer = st.compareOffer.value,
        compareRun = st.compareRun.value,
        onLoadCompare = { loadCompareOffer(st) },
        onCompareRecorded = { jobId, model -> startCompare(st, jobId, model) },
        onCompareLive = { prompt, model -> startCompareLive(st, prompt, model) },
        onCompareStop = { stopCompare(st) },
        onModalStop = { modalStop(st) },
        runs = st.trainingRuns.value,
        runDetail = st.trainingRun.value,
        onLoadRuns = { loadTrainingRuns(st) },
        onOpenRun = { id -> loadTrainingRun(st, id) },
        onCloseRun = { st.trainingRun.value = null },
        onLabelStep = { id, n, verdict -> labelStep(st, id, n, verdict) },
    )
}

/** The practice collector: a thin role doing its own job, signed in. */
fun setPractice(st: DesktopState, on: Boolean) = bg {
    try { Cluster.authed("POST", "/v1/training/practice", "{\"on\":" + on + "}") } catch (e: Exception) { }
    loadTraining(st)
}
/** GPU nodes: a join for a kind (the hub mints the token and the line), a revoke, Modal's settings, start and stop. */
fun nodeJoin(st: DesktopState, kind: String) = bg {
    try { Cluster.authed("POST", "/v1/training/nodes/join", "{\"kind\":\"" + kind + "\"}") } catch (e: Exception) { }
    loadTraining(st)
}
fun nodeRevoke(st: DesktopState, code: String) = bg {
    try { Cluster.authed("DELETE", "/v1/training/nodes/" + java.net.URLEncoder.encode(code, "UTF-8"), null) } catch (e: Exception) { }
    loadTraining(st)
}
fun setModal(st: DesktopState, fields: Map<String, String>) = bg {
    val o = org.json.JSONObject()
    fields.forEach { (k, v) -> if (k == "auto") o.put(k, v == "true") else o.put(k, v) }
    try { Cluster.authed("POST", "/v1/training/nodes/modal", o.toString()) } catch (e: Exception) { }
    loadTraining(st)
}
fun modalStart(st: DesktopState) = bg {
    try { Cluster.authed("POST", "/v1/training/nodes/modal/start", "{}") } catch (e: Exception) { }
    loadTraining(st)
}
/** What may be compared: the recorded jobs, and the models the server actually holds. */
fun loadCompareOffer(st: DesktopState) = bg {
    try { st.compareOffer.value = TrainingWatch.parseCompareOffer(Cluster.authed("GET", "/v1/training/compare/jobs", null)) }
    catch (e: Exception) { st.compareOffer.value = TrainingWatch.CompareOffer(error = e.message ?: "could not read the jobs") }
}

/*
 * A comparison fills in over minutes - a forty-step job on a processor-only sidecar is not quick -
 * so it is started, then polled until it says it is done.
 */
private fun watchCompare(st: DesktopState, id: String) = bg {
    var left = 600
    while (left-- > 0) {
        val run = try { TrainingWatch.parseCompareRun(Cluster.authed("GET", "/v1/training/compare/" + id, null)) }
        catch (e: Exception) { TrainingWatch.CompareRun(error = e.message ?: "lost the comparison") }
        st.compareRun.value = run
        if (run.done || run.error.isNotBlank()) break
        Thread.sleep(3000)
    }
}

/** Replay a recorded job against a model: no teacher calls, works whatever the allowance says. */
fun startCompare(st: DesktopState, jobId: String, model: String) = bg {
    val o = org.json.JSONObject().put("jobId", jobId).put("model", model)
    try {
        val run = TrainingWatch.parseCompareRun(Cluster.authed("POST", "/v1/training/compare", o.toString()))
        st.compareRun.value = run
        if (run.id.isNotBlank()) watchCompare(st, run.id)
    } catch (e: Exception) { st.compareRun.value = TrainingWatch.CompareRun(error = e.message ?: "could not start it") }
}

/** The teacher works a typed prompt for real, with the model answering beside it. */
fun startCompareLive(st: DesktopState, prompt: String, model: String) = bg {
    val o = org.json.JSONObject().put("prompt", prompt).put("model", model)
    try {
        val run = TrainingWatch.parseCompareRun(Cluster.authed("POST", "/v1/training/compare/live", o.toString()))
        st.compareRun.value = run
        if (run.id.isNotBlank()) watchCompare(st, run.id)
    } catch (e: Exception) { st.compareRun.value = TrainingWatch.CompareRun(error = e.message ?: "could not start it") }
}

fun stopCompare(st: DesktopState) = bg {
    val id = st.compareRun.value?.id ?: return@bg
    try { Cluster.authed("POST", "/v1/training/compare/" + id + "/stop", "{}") } catch (e: Exception) { }
}

/** The scoreboard: every measured round, whatever model trained it. */
fun loadTrainingResults(st: DesktopState) = bg {
    try { st.trainingResults.value = TrainingWatch.parseResults(Cluster.authed("GET", "/v1/training/results?limit=24", null)) }
    catch (e: Exception) { st.trainingResults.value = TrainingWatch.Results(error = e.message ?: "could not read the results") }
}

/** Score the candidate students on the same paper. An empty list means the whole field. */
fun trialStudents(st: DesktopState, models: List<String>) = bg {
    val o = org.json.JSONObject()
    if (models.isNotEmpty()) o.put("models", org.json.JSONArray(models))
    try { Cluster.authed("POST", "/v1/training/students/trial", o.toString()) } catch (e: Exception) { }
    loadTraining(st)
}
fun modalStop(st: DesktopState) = bg {
    try { Cluster.authed("POST", "/v1/training/nodes/modal/stop", "{}") } catch (e: Exception) { }
    loadTraining(st)
}
/** End a round on whichever machine runs it: the hub marks it and tells the machine to kill its trainer. */
fun stopRound(st: DesktopState, id: String) = bg {
    try { Cluster.authed("POST", "/v1/training/rounds/$id/stop", "{}") } catch (e: Exception) { }
    loadTraining(st)
}
/** Autopilot serving: the most specific model that earned its stage answers. */
fun setAutopilot(st: DesktopState, on: Boolean) = bg {
    try { Cluster.authed("POST", "/v1/training/serving", "{\"autopilot\":" + on + "}") } catch (e: Exception) { }
    loadTraining(st)
}
/** The teacher judging the old runs, or not. One model call per run. */
fun setJudge(st: DesktopState, on: Boolean) = bg {
    try { Cluster.authed("POST", "/v1/training/judge", "{\"on\":" + on + "}") } catch (e: Exception) { }
    loadTraining(st)
}
fun loadTrainingRuns(st: DesktopState) = bg {
    try { st.trainingRuns.value = engineer.myapp.gb.shared.TrainingWatch.parseRuns(Cluster.authed("GET", "/v1/training/runs?limit=60", null)) } catch (e: Exception) { }
}
fun loadTrainingRun(st: DesktopState, id: String) = bg {
    try { st.trainingRun.value = engineer.myapp.gb.shared.TrainingWatch.parseRun(Cluster.authed("GET", "/v1/training/runs/$id", null)) } catch (e: Exception) { }
}
/** A person's label on a step - outranks the record and the teacher in the next set. */
fun labelStep(st: DesktopState, id: String, n: Int, verdict: String) = bg {
    try { Cluster.authed("POST", "/v1/training/runs/$id/steps/$n/label", "{\"verdict\":\"" + verdict + "\"}") } catch (e: Exception) { }
    loadTrainingRun(st, id)
}

/* ── Settings ──────────────────────────────────────────────────────────────────────────────── */
@Composable
fun SettingsScreenDLegacy(st: DesktopState, onOpenUrl: (String) -> Unit, onOpenDevices: () -> Unit, onOpenDownloads: () -> Unit = {}, onOpenTraining: () -> Unit = {}) {
    val cs = MaterialTheme.colorScheme
    LaunchedEffect(Unit) { if (st.platforms.value.isEmpty()) loadPlatforms(st); if (st.devices.value.isEmpty()) loadDevices(st) }
    Column(Modifier.fillMaxSize().background(cs.background).verticalScroll(rememberScrollState()).padding(20.dp)) {
        Text("Settings", style = MaterialTheme.typography.headlineSmall)
        Text("Everything for this device and your account", color = cs.onSurfaceVariant, fontSize = 12.sp)
        Spacer(Modifier.height(16.dp))

        SectionD("☁  Account & sync") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(9.dp).clip(CircleShape).background(if (Cluster.connected) Brand else cs.onSurfaceVariant))
                Spacer(Modifier.width(8.dp))
                Text(if (Cluster.connected) "Cluster: connected ✓" else "Cluster: connecting…", color = cs.onSurface, fontSize = 13.sp)
            }
            Spacer(Modifier.height(6.dp))
            Text(Cluster.clusterUrl, color = cs.onSurfaceVariant, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
            Spacer(Modifier.height(10.dp))
            OutlinedButton(onClick = { loadPlatforms(st); loadDevices(st); loadFlows(st) }, shape = RoundedCornerShape(12.dp)) { Text("Re-sync now") }
            Note("Sign in on the Browser tab (my-app.engineer → open Ghost Browser from Tools). The node then auto-registers — one account, same data on every device.")
        }

        SectionD("⬇  Downloads") {
            Text("Every file your Ghost Browser captured — songs, pictures, exports. Play, save to this machine, or delete.", color = cs.onSurfaceVariant, fontSize = 12.sp)
            Spacer(Modifier.height(8.dp))
            Button(onClick = onOpenDownloads, shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Open downloads") }
        }

        SectionD("👤  Profiles") {
            Text("Open a platform", color = cs.onSurfaceVariant, fontSize = 12.sp)
            Spacer(Modifier.height(6.dp))
            if (st.platforms.value.isEmpty()) Text("Load your platforms from the cluster.", color = cs.onSurfaceVariant, fontSize = 12.sp)
            else Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                st.platforms.value.forEach { p ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(cs.surfaceVariant).clickable { onOpenUrl(p.site) }.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(p.label, fontSize = 14.sp, modifier = Modifier.weight(1f)); Text("open", color = Brand, fontSize = 12.sp)
                    }
                }
            }
            TextButton(onClick = { loadPlatforms(st) }) { Text("Load platforms from cluster") }
        }

        SectionD("🖥  Devices & ring") {
            Text("This machine", color = cs.onSurfaceVariant, fontSize = 12.sp)
            Text("desktop · real Chromium (JCEF) · CDP", fontFamily = FontFamily.Monospace, fontSize = 12.sp)
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(st.hubSummary.value.ifBlank { "Connected devices" }, color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.weight(1f))
                TextButton(onClick = { loadDevices(st) }) { Text("Refresh") }
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                st.devices.value.forEach { d ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(cs.surfaceVariant).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(if (d.online) Brand else cs.onSurfaceVariant))
                        Spacer(Modifier.width(8.dp))
                        Text(d.name, fontSize = 13.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(d.type, color = cs.onSurfaceVariant, fontSize = 10.sp)
                    }
                }
            }
            TextButton(onClick = onOpenDevices) { Text("Open full Device Hub") }
        }

        SectionD("🧠  Training") {
            val tv = st.training.value
            Text(engineer.myapp.gb.shared.TrainingWatch.readiness(tv.corpus), color = cs.onSurfaceVariant, fontSize = 12.sp)
            tv.active?.let {
                Spacer(Modifier.height(6.dp))
                Text("training now on ${it.device}${it.lines.lastOrNull()?.let { l -> " — $l" } ?: ""}", fontSize = 12.sp)
            }
            TextButton(onClick = onOpenTraining) { Text("Open the pipeline") }
        }

        SectionD("🛡  Network & exit") {
            Text("This desktop operates on its own machine network. The cluster GB keeps its own in-image exit node.", fontSize = 13.sp)
        }

        SectionD("⚡  AI model (Agent)") {
            Text("An OpenAI-compatible endpoint the Agent uses (Ollama: http://localhost:11434/v1).", color = cs.onSurfaceVariant, fontSize = 12.sp)
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(st.endpoint.value, { st.endpoint.value = it }, label = { Text("Endpoint") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp)); OutlinedTextField(st.apiKey.value, { st.apiKey.value = it }, label = { Text("API key (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp)); OutlinedTextField(st.model.value, { st.model.value = it }, label = { Text("Model (e.g. llama3.1)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(10.dp))
            Button(onClick = { Agent.save(st.endpoint.value, st.apiKey.value, st.model.value) }, shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Save") }
        }

        SectionD("🎨  Appearance") {
            Segmented(listOf("Dark", "Light"), if (st.dark.value) 0 else 1) { st.dark.value = it == 0 }
        }

        SectionD("📜  Activity") {
            Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                Text(st.activity.value.ifBlank { "No activity yet." }, Modifier.heightIn(min = 60.dp, max = 200.dp).verticalScroll(rememberScrollState()).padding(12.dp), color = cs.onSurfaceVariant, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Note(text: String) { Spacer(Modifier.height(10.dp)); Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, lineHeight = 15.sp) }

@Composable
private fun Segmented(options: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).border(1.dp, cs.outline, RoundedCornerShape(12.dp))) {
        options.forEachIndexed { i, opt ->
            val on = i == selected
            Box(Modifier.weight(1f).background(if (on) Brand else androidx.compose.ui.graphics.Color.Transparent).clickable { onSelect(i) }.padding(vertical = 12.dp), contentAlignment = Alignment.Center) {
                Text(opt, color = if (on) BrandOn else cs.onSurface, fontSize = 13.sp)
            }
        }
    }
}

@Composable
private fun SectionD(title: String, content: @Composable ColumnScope.() -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(16.dp), border = androidx.compose.foundation.BorderStroke(1.dp, cs.outline), modifier = Modifier.fillMaxWidth().padding(bottom = 14.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(12.dp))
            content()
        }
    }
}

/* ── Agent chat (desktop) ─────────────────────────────────────────────────────────────────────── */
@androidx.compose.runtime.Composable
fun AgentChatD(st: DesktopState, main: org.cef.browser.CefBrowser?) {
    val cs = MaterialTheme.colorScheme
    var input by remember { mutableStateOf("") }
    var toolView by remember { mutableStateOf<engineer.myapp.gb.shared.ChatMsg?>(null) }
    Column(Modifier.fillMaxSize().background(cs.background)) {
        Row(Modifier.fillMaxWidth().background(cs.surface).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Agent", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
            TextButton(onClick = { st.agentMsgs.value = emptyList() }) { Text("New chat") }
        }
        val scroll = rememberScrollState()
        LaunchedEffect(st.agentMsgs.value.size, st.agentBusy.value) { scroll.animateScrollTo(scroll.maxValue) }
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll).padding(16.dp)) {
            if (st.agentMsgs.value.isEmpty()) Text("What can I do for you?\n\nI can browse for you on this machine, run your automations, and inspect your platforms — just ask.", color = cs.onSurfaceVariant, fontSize = 15.sp, modifier = Modifier.padding(top = 20.dp))
            st.agentMsgs.value.forEach { msg ->
                when (msg.role) {
                    "user" -> Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.End) {
                        Surface(color = Brand, contentColor = BrandOn, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth(0.8f)) { Text(msg.content, Modifier.padding(12.dp), fontSize = 14.sp) }
                    }
                    "assistant" -> Row(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                        Surface(color = cs.surface, border = androidx.compose.foundation.BorderStroke(1.dp, cs.outline), shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth(0.85f)) { Text(msg.content, Modifier.padding(12.dp), fontSize = 14.sp) }
                    }
                    "tool" -> Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(9.dp), modifier = Modifier.padding(bottom = 8.dp).clickable { toolView = msg }) {
                        Text("⚙ ${msg.tool}", Modifier.padding(horizontal = 11.dp, vertical = 7.dp), color = cs.onSurfaceVariant, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                    }
                }
            }
            if (st.agentBusy.value) Text("…thinking", color = cs.onSurfaceVariant, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
        }
        Row(Modifier.fillMaxWidth().background(cs.surface).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { OutlinedTextField(input, { input = it }, placeholder = { Text("Message the agent…") }, singleLine = true, modifier = Modifier.fillMaxWidth()) }
            Spacer(Modifier.width(8.dp))
            Button(onClick = { if (!st.agentBusy.value && input.isNotBlank()) { Agent.send(st, main, input.trim()); input = "" } }, enabled = !st.agentBusy.value, shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Send") }
        }
    }
    toolView?.let { tv ->
        AlertDialog(onDismissRequest = { toolView = null }, confirmButton = { TextButton(onClick = { toolView = null }) { Text("Close") } },
            title = { Text("⚙ ${tv.tool}") }, text = { Column(Modifier.verticalScroll(rememberScrollState())) { Text(tv.content.ifBlank { "(empty)" }, fontFamily = FontFamily.Monospace, fontSize = 12.sp) } })
    }
}

/* ── New-tab home + /learn feed (desktop) ─────────────────────────────────────────────────────── */
fun loadLearn(st: DesktopState) = bg {
    st.homeLoading.value = true
    val items = ArrayList<LearnItem>()
    try {
        val c = java.net.URL("https://my-app.engineer/learn/").openConnection() as java.net.HttpURLConnection
        c.connectTimeout = 12000; c.readTimeout = 12000; c.setRequestProperty("Accept", "text/html")
        val html = c.inputStream.bufferedReader().use { it.readText() }
        val rx = Regex("<li><a href=\"/learn/([^\"]+)\"><b>(.*?)</b></a>(?:<span>(.*?)</span>)?</li>", RegexOption.DOT_MATCHES_ALL)
        for (m in rx.findAll(html)) {
            val slug = m.groupValues[1]; val title = unesc(m.groupValues[2]); val desc = unesc(m.groupValues[3])
            if (slug.isNotBlank() && title.isNotBlank()) items.add(LearnItem(slug, title, desc))
        }
    } catch (e: Exception) {}
    st.homeFeed.value = items.take(30); st.homeLoading.value = false
}
private fun unesc(s: String) = s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&#x27;", "'")

@Composable
fun HomePageD(st: DesktopState, onOpenUrl: (String) -> Unit, onSearch: () -> Unit) {
    LaunchedEffect(Unit) { if (st.homeFeed.value.isEmpty()) loadLearn(st); if (st.platforms.value.isEmpty()) loadPlatforms(st) }
    // S9: the SAME shared new-tab home the phone uses.
    HomeScreen(
        platforms = st.platforms.value, feed = st.homeFeed.value, loading = st.homeLoading.value,
        onSearch = onSearch, onOpenPlatform = { p -> onOpenUrl(p.site) },
        onOpenLearn = { slug -> onOpenUrl("https://my-app.engineer/learn/$slug") }, onRefresh = { loadLearn(st) },
    )
}

/** Fetch models via the cluster (reaches ollama.com fine + curated fallback). */
fun fetchModelsD(st: DesktopState) = bg {
    st.ollamaBusy.value = true; st.ollamaNote.value = "fetching via cluster…"
    val host = st.endpoint.value.trim().removeSuffix("/").removeSuffix("/v1").ifBlank { "https://ollama.com" }
    val body = JSONObject().put("llmHost", host).put("llmKey", st.apiKey.value).toString()
    val r = Cluster.authed("POST", "/v1/agent/models", body)
    try {
        val arr = JSONObject(r).optJSONArray("models") ?: org.json.JSONArray()
        val list = ArrayList<String>(); for (i in 0 until arr.length()) { val m = arr.optString(i); if (m.isNotBlank()) list.add(m) }
        st.ollamaModels.value = list
        if (list.isNotEmpty() && st.model.value.isBlank()) st.model.value = list[0]
        st.ollamaNote.value = if (list.isEmpty()) "! no models — ${JSONObject(r).optString("reason", "check endpoint")}" else "${list.size} models — pick one"
    } catch (e: Exception) { st.ollamaNote.value = "! ${r.take(80)}" }
    st.ollamaBusy.value = false
}

/** S9-ish: desktop AI-model MODAL (like the phone's) instead of opening the Settings tab. */
@Composable
fun AiModalD(st: DesktopState, onClose: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color(0x99000000)).clickable { onClose() }, contentAlignment = Alignment.Center) {
        Surface(color = cs.surface, contentColor = cs.onSurface, shape = RoundedCornerShape(20.dp), tonalElevation = 6.dp,
            modifier = Modifier.padding(24.dp).width(460.dp).clickable(enabled = false) {}) {
            Column(Modifier.padding(20.dp).verticalScroll(rememberScrollState())) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("AI model", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Close", tint = cs.onSurfaceVariant) }
                }
                Text("The agent uses your cluster's LLM by default — no key needed. Set a custom endpoint below to override.", color = cs.onSurfaceVariant, fontSize = 12.sp)
                Spacer(Modifier.height(14.dp))
                OutlinedTextField(st.endpoint.value, { st.endpoint.value = it }, label = { Text("Endpoint (optional — e.g. https://ollama.com/v1)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(st.apiKey.value, { st.apiKey.value = it }, label = { Text("API key (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation())
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Model", color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.weight(1f))
                    if (st.ollamaBusy.value) CircularProgressIndicator(Modifier.size(15.dp), color = Brand, strokeWidth = 2.dp)
                    else TextButton(onClick = { fetchModelsD(st) }) { Text("Fetch models") }
                }
                if (st.ollamaModels.value.isNotEmpty()) SegDropdown(st.ollamaModels.value, st.ollamaModels.value.indexOf(st.model.value).coerceAtLeast(0)) { st.model.value = st.ollamaModels.value.getOrElse(it) { st.model.value } }
                else OutlinedTextField(st.model.value, { st.model.value = it }, label = { Text("Model name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                if (st.ollamaNote.value.isNotBlank()) { Spacer(Modifier.height(4.dp)); Text(st.ollamaNote.value, color = cs.onSurfaceVariant, fontSize = 11.sp) }
                Spacer(Modifier.height(14.dp))
                Button(onClick = { Agent.save(st.endpoint.value, st.apiKey.value, st.model.value); onClose() }, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Save") }
            }
        }
    }
}

@androidx.compose.runtime.Composable
private fun SegDropdown(options: List<String>, sel: Int, onSelect: (Int) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val cs = MaterialTheme.colorScheme
    Box {
        OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) { Text(options.getOrElse(sel) { "pick a model" }) }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEachIndexed { i, o -> DropdownMenuItem(text = { Text(o) }, onClick = { expanded = false; onSelect(i) }) }
        }
    }
}

/**
 * THE ONE SETTINGS PAGE, on the desktop. The legacy page above is kept for reference and no longer
 * shown; this feeds the shared page from DesktopState. The model section is the same
 * AiModelUi/AiModelActions the model sheet uses, so the backup key is finally saved from here too.
 */
@Composable
fun SettingsScreenD(st: DesktopState, onOpenUrl: (String) -> Unit, onOpenDevices: () -> Unit, onOpenDownloads: () -> Unit = {}, onOpenTraining: () -> Unit = {}) {
    LaunchedEffect(Unit) { if (st.platforms.value.isEmpty()) loadPlatforms(st); if (st.devices.value.isEmpty()) loadDevices(st) }
    val s = remember { engineer.myapp.gb.shared.SettingsState() }
    s.clusterUrl.value = Cluster.clusterUrl
    s.connected.value = Cluster.connected
    s.clusterStatus.value = if (Cluster.connected) "Cluster: connected ✓" else "Cluster: connecting…"
    s.deviceKind.value = "desktop"
    s.deviceLine.value = "desktop · real Chromium (JCEF) · CDP"
    s.platforms.value = st.platforms.value
    s.devices.value = st.devices.value.map { d -> engineer.myapp.gb.shared.DeviceOpt(id = d.name, name = d.name, sub = d.type, emoji = "", online = d.online) }
    s.hubSummary.value = st.hubSummary.value
    val tv = st.training.value
    s.trainingLine.value = engineer.myapp.gb.shared.TrainingWatch.headline(tv)
    s.trainingNow.value = tv.active?.let { "training now on ${it.device}${it.lines.lastOrNull()?.let { l -> " — $l" } ?: ""}" } ?: ""
    s.networkLine.value = "This desktop operates on its own machine network. The cluster's Ghost Browser keeps its own in-image exit node."
    s.themeDark.value = st.dark.value
    s.activity.value = st.activity.value
    s.appLabel.value = "Ghost Browser Desktop"
    val handlers = remember(st) {
        engineer.myapp.gb.shared.SettingsHandlers(
            onResync = { loadPlatforms(st); loadDevices(st); loadFlows(st); loadTraining(st) },
            onOpenHub = onOpenDevices, onOpenTraining = onOpenTraining, onOpenDownloads = onOpenDownloads,
            onLoadPlatforms = { loadPlatforms(st) }, onOpenPlatform = { _, site -> onOpenUrl(site) },
            onRefreshDevices = { loadDevices(st) },
            onSetTheme = { dark -> st.dark.value = dark },
            aiModel = AssistantD.modelActions(st),
            /*
             * THE PASSWORD FALLBACK. Signs the hidden control browser in with the owner's email and
             * the password set on the instance - the same session cookie the platform hand-off
             * would have set - so the node registers on it; and sets that password while signed in.
             */
            onPasswordSignIn = { email, pw -> bg {
                val r = try { Cluster.authed("POST", "/api/auth/login", JSONObject().put("username", email).put("password", pw).toString()) } catch (e: Exception) { "{\"error\":" + JSONObject.quote(e.message ?: "failed") + "}" }
                val j = try { JSONObject(r) } catch (e: Exception) { JSONObject() }
                s.authMessage.value = if (j.has("username")) "signed in as ${j.optString("username")} — the node connects in a moment" else "sign-in failed: " + j.optString("error", r.take(120))
                if (j.has("username")) { s.hasPassword.value = true; s.accountEmail.value = j.optString("username") }
                loadPlatforms(st); loadDevices(st)
            } },
            onSetPassword = { pw -> bg {
                val r = try { Cluster.authed("POST", "/api/auth/password", JSONObject().put("password", pw).toString()) } catch (e: Exception) { "{\"error\":" + JSONObject.quote(e.message ?: "failed") + "}" }
                val j = try { JSONObject(r) } catch (e: Exception) { JSONObject() }
                s.authMessage.value = if (j.optBoolean("ok")) "password set — your email and this password open this Ghost Browser on any device" else "not set: " + j.optString("error", r.take(120))
                if (j.optBoolean("ok")) s.hasPassword.value = true
            } },
        )
    }
    /* Whether a password exists on the instance, and whose it is - asked once, off the UI thread. */
    LaunchedEffect(Cluster.connected) {
        bg {
            try {
                val j = JSONObject(Cluster.authed("GET", "/api/auth/state", null))
                if (j.has("hasPassword")) s.hasPassword.value = j.optBoolean("hasPassword")
                val who = j.optString("username", ""); if (who.isNotBlank()) s.accountEmail.value = who
            } catch (e: Exception) { /* an older cluster */ }
        }
    }
    engineer.myapp.gb.shared.SettingsScreenShared(s, st.aiModel, handlers, onClose = null)
}
