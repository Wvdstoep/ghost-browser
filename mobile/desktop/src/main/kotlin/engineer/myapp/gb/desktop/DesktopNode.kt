package engineer.myapp.gb.desktop

import org.cef.browser.CefBrowser
import org.json.JSONArray
import org.json.JSONObject

/**
 * S8 — the desktop as a drivable NODE. Mirrors the Electron node's control channel (register → poll →
 * result) and its /v1 command set, but on JCEF: authed cluster calls run as fetch() inside a hidden
 * control browser on the GB origin (same SSO session the user signs into), and commands execute on the
 * visible browser over CDP. The cluster/ring drives this exactly as it drives the Electron node today.
 *
 * S8.2: register + poll + navigate/info/read/click/click_text/type/scroll/screenshot/eval.
 * S8.3: CDP drag, upload_file — done below. S8.4 (here): fetch a URL to disk, and run a goal on this
 * node, which is what lets the ring hand a whole job (a CapCut edit) over instead of driving every
 * click from the cluster. S9 retires Electron.
 */
class DesktopNode(
    private val active: () -> CefBrowser?,     // drive whichever tab is active
    private val deviceId: String,
    private val deviceName: String,
    private val gbJs: String,
    /*
     * RUN A GOAL ON THIS NODE. The ring's way of saying "this job is yours": the cluster sends the
     * goal, already filled in, and the on-device agent works it with THIS browser's own tools —
     * click_xy, drag, upload_file. Without it the cluster would have to drive every click over the
     * wire, and a CapCut edit is hundreds of them.
     */
    private val runGoal: (goal: String, runId: String) -> Unit = { _, _ -> },
    private val log: (String) -> Unit,
) {
    private val main: CefBrowser get() = active() ?: throw IllegalStateException("no active tab")
    @Volatile private var stopped = false
    @Volatile var registered = false; private set

    /*
     * WHAT THIS NODE CAN DO — read off execPath below, and kept beside it.
     *
     * The ring believes this list (see missesFor in the cluster's device-hub): it picks a device for a
     * run by matching a role's stated requirements against these names. So a name here that execPath
     * does not handle sends work to a machine that cannot do it, instead of to one that can — worse
     * than saying nothing. Add a branch below, add its name here; never the other way round.
     *
     * "download" was listed and has never existed; it is gone. cdp stays true and is accurate: input
     * goes through Input.dispatchMouseEvent and uploads through DOM.setFileInputFiles. What this node
     * does NOT have is drag INTERCEPTION (Input.setInterceptDrags), so a true HTML5-draggable element
     * cannot be dropped here — dragXY is a compositor press/move/release, which is exactly right for a
     * canvas like the CapCut timeline and wrong for a library card that sets a dataTransfer.
     */
    /*
     * Built fresh on every register rather than held as a constant, because whether this machine can
     * TRAIN changes: a drive fills up, an environment gets built, a model finishes downloading. A
     * constant computed at class-load would advertise the state at startup for ever, and the hub
     * would keep routing rounds to a laptop that ran out of disk an hour ago.
     *
     * `train_setup` is always offered — that is the command that MAKES a machine able — while
     * `train_round` appears only once it actually is. Offering to take a round it cannot run is the
     * exact failure the note above this warns about.
     */
    private fun caps(): String {
        val tr = Trainer.status()
        val features = mutableListOf(
            "navigate", "info", "analyze", "content", "click_text", "click", "type", "scroll",
            "screenshot", "eval", "info_device", "click_xy", "drag", "upload_file",
            "download_url", "run_goal", "train_setup", "train_status")
        if (tr.optBoolean("ready")) { features.add("train_round"); features.add("train_export") }
        return JSONObject()
            /* realIp: this node is the owner's own machine on their own connection, which is the
               whole reason the ring sends it the sites that wall the cluster. Reporting false kept
               the router from ever choosing it for that work. */
            .put("platform", "desktop").put("cdp", true).put("model", false).put("realIp", true)
            .put("trainer", tr.optBoolean("ready"))
            .put("trainerFreeGb", tr.optLong("freeGb"))
            .put("trainerHome", tr.optString("home"))
            .put("trainerMissing", tr.optJSONArray("missing"))
            .put("trainerCanSetUp", tr.optBoolean("canSetUp"))
            .put("trainerSettingUp", tr.optBoolean("settingUp"))
            .put("trainerSetupLine", Trainer.setupLine())
            .put("features", features)
            .toString()
    }

    /**
     * A TOKEN THE TRAINING ROUND CAN REPORT WITH.
     *
     * Everything else this node does rides the control browser's session cookie, which a separate
     * Python process cannot use. So the machine enrols ONCE for a durable device login and keeps it
     * beside the training home.
     *
     * Once, deliberately: minting rotates, so enrolling on every start would invalidate the token a
     * round already running is using to report its progress — and that round would go silent with
     * nothing to say why.
     */
    private fun trainerToken(): String {
        val f = java.io.File(Trainer.home(), "cluster-token.txt")
        try { if (f.isFile) { val s = f.readText().trim(); if (s.startsWith("gbd_")) return s } } catch (e: Exception) {}
        return try {
            val body = JSONObject().put("deviceId", deviceId).put("name", deviceName).toString()
            val got = JSONObject(authed("POST", "/v1/device/auth", body))
            val tok = got.optString("token", "")
            if (tok.startsWith("gbd_")) {
                f.parentFile?.mkdirs(); f.writeText(tok)
                log("● enrolled this machine for training reports")
                tok
            } else { log("node: could not enrol for training — ${got.optString("error").take(120)}"); "" }
        } catch (e: Exception) { log("node: enrol failed — ${e.message}"); "" }
    }

    fun start() { Thread({ runLoop() }, "gb-desktop-node").apply { isDaemon = true }.start() }
    fun stop() { stopped = true }

    /** An authed cluster call (rides the control browser's session, on the GB origin). */
    private fun authed(method: String, path: String, body: String?): String = Cluster.authed(method, path, body)

    /**
     * TELL THE CLUSTER WHAT WE ARE DOING — the half of the ring that was missing.
     *
     * A walk handed to this machine has no cluster job, so from the assistant's side the work
     * vanished the moment it arrived here. Seen live: the hand-over succeeded, then the assistant
     * called gb_walk_wait with this device's NAME, got "no such job", read the cluster log in a
     * loop, and handed the same goal over a second time. The hub has kept a per-device log all
     * along (POST /v1/device/log) and nothing ever wrote to it.
     *
     * Off-thread and swallowed on purpose: reporting progress must never be able to stall or break
     * the work it is reporting on.
     */
    fun report(line: String) {
        if (!registered) return
        Thread {
            try {
                authed("POST", "/v1/device/log",
                    JSONObject().put("deviceId", deviceId).put("line", line.take(400)).toString())
            } catch (e: Exception) { /* progress is never worth failing the job for */ }
        }.apply { isDaemon = true }.start()
    }

    /** Register, retrying until the user is signed in and GB is open. Returns false only on stop. */
    private fun registerLoop(): Boolean {
        while (!stopped) {
            val reg = authed("POST", "/v1/device/register",
                JSONObject().put("deviceId", deviceId).put("name", deviceName).put("caps", JSONObject(caps())).toString())
            if (reg.contains("\"ok\":true") || reg.contains("\"deviceId\"")) {
                registered = true; Cluster.connected = true
                /* The reporter can only post once we are registered — the hub rejects a log line
                   for a device it does not know. Wiring it here is what makes that true by
                   construction instead of by hoping the order works out. */
                engineer.myapp.gb.shared.RingWork.upstream = { line -> report(line) }
                log("● desktop node registered as \"$deviceName\""); return true
            }
            log("node: register reply = " + reg.replace("\n", " ").take(160))
            Thread.sleep(4000)
        }
        return false
    }

    /* Set by the trainer when a set-up ends: the caps were sent at register, so a machine that just
       became able would otherwise read "torch is not installed" until the app restarted. */
    @Volatile private var reRegister = false

    private fun runLoop() {
        Trainer.onSetupDone = { reRegister = true }
        if (!registerLoop()) return
        while (!stopped) {                        // poll → run → result
            if (reRegister) {
                reRegister = false
                registered = false
                log("node: set-up ended — registering again with what this machine can do now")
                if (!registerLoop()) return
            }
            val cmd = try { authed("GET", "/v1/device/poll?deviceId=$deviceId", null) } catch (e: Exception) { Thread.sleep(2000); continue }
            if (cmd.isBlank() || cmd == "null") { continue }         // 204 (no command) → poll again
            val o = try { JSONObject(cmd) } catch (e: Exception) { Thread.sleep(1500); continue }

            /*
             * THE CLUSTER CAN FORGET US, and this loop used to treat that as a command.
             *
             * When the GB pod rolls, its device registry is in memory and starts empty, so every poll
             * answers 404 {"error":"register first"}. Cluster.authed hands back only the body, so the
             * status is invisible here — and that body parses. With no "path" in it the next line fell
             * back to "/v1/info", so the node ran info against the browser, posted a result with an
             * empty id, looped with no sleep, and never registered again. The desktop simply vanished
             * from the ring after every deploy until someone restarted the app.
             *
             * A reply with no id is not a command. The JS control script has always handled this by
             * re-registering on a 404; this is the same rule, read off the body because that is all
             * we are given.
             */
            if (!o.has("id")) {
                if (cmd.contains("register first") || cmd.contains("not connected")) {
                    registered = false
                    log("node: the cluster forgot us (it restarted) — registering again")
                    if (!registerLoop()) return
                } else {
                    Thread.sleep(1500)          // some other error body; do not hammer it
                }
                continue
            }

            val id = o.optString("id"); val path = o.optString("path", "/v1/info"); val bodyO = o.optJSONObject("body") ?: JSONObject()
            val out = try { execPath(path, bodyO) } catch (e: Exception) { "{\"error\":${jsonStr(e.message ?: "error")}}" }
            authed("POST", "/v1/device/result", JSONObject().put("deviceId", deviceId).put("id", id).put("status", 200).put("body", out).toString())
            log("↺ ran $path")
            /* Every command the ring drives, visible from the other side too — a walk that is being
               driven click by click was just as invisible as one handed over whole. */
            if (path != "/v1/run_goal") report("↺ $path${if (out.startsWith("{\"error\"")) " — " + out.take(120) else ""}")
        }
    }

    /** Run one command on the visible browser and return its JSON string result. */
    private fun execPath(path: String, body: JSONObject): String {
        fun gb(expr: String) = Cef.evalJs(main, gbJs + "\n" + expr)
        return when (path) {
            "/v1/navigate" -> { main.loadURL(body.optString("url")); Thread.sleep(2500); waitSettle(6000); "{\"url\":${jsonStr(main.url ?: body.optString("url"))}}" }
            "/v1/info" -> gb("JSON.stringify(window.__gb.info())").ifBlank { "{}" }
            "/v1/read", "/v1/analyze" -> "{\"info\":" + gb("JSON.stringify(window.__gb.info())").ifBlank { "{}" } + ",\"elements\":" + gb("JSON.stringify(window.__gb.mark())").ifBlank { "[]" } + ",\"text\":" + gb("JSON.stringify(window.__gb.text())").ifBlank { "\"\"" } + "}"
            "/v1/content" -> gb("JSON.stringify(window.__gb.text())").ifBlank { "\"\"" }
            "/v1/click_text" -> gb("JSON.stringify(window.__gb.clickText(${jsonStr(body.optString("text"))},${body.optInt("nth", 0)}))").ifBlank { "{}" }
            "/v1/click" -> gb("JSON.stringify(window.__gb.click(${body.optInt("index", -1)}))").ifBlank { "{}" }
            "/v1/type" -> gb("JSON.stringify(window.__gb.type(${body.optInt("index", -1)},${jsonStr(body.optString("text"))}))").ifBlank { "{}" }
            "/v1/scroll" -> gb("JSON.stringify(window.__gb.scroll(${body.optInt("dy", 600)}))").ifBlank { "{}" }
            "/v1/screenshot" -> Hands.screenshot(main)
            "/v1/eval" -> Cef.evalJs(main, gbJs + "\n(function(){try{return JSON.stringify((" + body.optString("code") + "))}catch(e){return JSON.stringify({error:String(e)})}})()").ifBlank { "{}" }
            "/v1/info_device" -> "{\"platform\":\"desktop\",\"name\":${jsonStr(deviceName)}}"

            /* ── training ─────────────────────────────────────────────────────────────────────────
             *
             * Three commands and no supervision. The round reports its own progress to the cluster
             * and writes its own result, so there is nothing here to watch — and watching it would
             * mean a six-hour round dying because the browser restarted.
             */
            "/v1/train_status" -> Trainer.status().toString()
            /* The owner stopped the round: end the trainer and everything it forked, now. */
            "/v1/train_stop" -> Trainer.stopRound(body.optString("round", "")) { line -> report("train: $line") }.toString()

            "/v1/train_setup" -> {
                /* Idempotent and gated: it refuses on a full disk rather than failing half way
                   through a two-gigabyte download and leaving an environment that imports but
                   cannot run. */
                val started = Trainer.setUp { line -> report("train: $line") }
                JSONObject().put("started", started).put("status", Trainer.status()).toString()
            }

            "/v1/train_round" -> {
                val tok = trainerToken()
                if (tok.isBlank()) JSONObject().put("error", "this machine has no cluster login for the round to report with").toString()
                else {
                    val ok = Trainer.runRound(
                        base = body.optString("base", ""),
                        hours = body.optDouble("hours", 6.0),
                        hub = Cluster.clusterUrl,
                        token = tok,
                    ) { line -> report("train: $line") }
                    JSONObject().put("started", ok).toString()
                }
            }
            /* A promoted round leaves this machine as one model file the cluster can serve. */
            "/v1/train_export" -> {
                val tok = trainerToken()
                if (tok.isBlank()) JSONObject().put("error", "this machine has no cluster login to upload with").toString()
                else {
                    val ok = Trainer.exportModel(
                        adapter = body.optString("adapter", ""),
                        tag = body.optString("tag", ""),
                        base = body.optString("base", ""),
                        roundId = body.optString("roundId", ""),
                        hub = Cluster.clusterUrl,
                        token = tok,
                    ) { line -> report("export: $line") }
                    JSONObject().put("started", ok).toString()
                }
            }
            /*
             * These four live in Hands, shared with the on-device agent. They used to be private
             * here, which meant only the ring could use them: the agent in front of this very
             * browser was never offered a drag or an upload, so a CapCut edit handed to this machine
             * could not be carried out by the thing standing closest to it.
             */
            "/v1/click_xy" -> Hands.clickXy(main, body.optDouble("x", 0.0), body.optDouble("y", 0.0))
            "/v1/drag" -> Hands.drag(
                main,
                body.optDouble("fromX", body.optDouble("x1", 0.0)), body.optDouble("fromY", body.optDouble("y1", 0.0)),
                body.optDouble("toX", body.optDouble("x2", 0.0)), body.optDouble("toY", body.optDouble("y2", 0.0)),
                body.optInt("steps", 14), body.optLong("holdMs", 60L),
            )
            "/v1/upload_file" -> Hands.uploadFile(main, body.optString("path"), body.optInt("nth", 0))
            "/v1/download_url" -> Hands.downloadUrl(body.optString("url"), body.optString("name"), log)
            "/v1/run_goal" -> {
                /*
                 * Acknowledged at once, deliberately. A CapCut edit is minutes of work and the poll
                 * that delivered this command must not be held open for it — the node would stop
                 * answering the ring while it worked. The agent reports its own progress.
                 */
                val goal = body.optString("goal")
                if (goal.isBlank()) "{\"error\":\"goal required\"}"
                else {
                    log("▶ ring handed us a goal (${goal.length} chars)")
                    /*
                     * Both directions at once (RingWork): the strip on this machine's own screen, and
                     * the per-device log the assistant reads — because the owner asks on the phone and
                     * the work happens here, so neither side may be the only one that knows.
                     */
                    engineer.myapp.gb.shared.RingWork.started(goal, body.optString("role", "general"))
                    // runId: the cluster's job for this goal, so the run is filed into it (see DeviceTrace).
                    runGoal(goal, body.optString("runId", ""))
                    "{\"started\":true}"
                }
            }
            else -> "{\"error\":${jsonStr("unknown path $path")}}"
        }
    }

    /*
     * The CapCut-critical primitives moved to Hands.kt, so the on-device agent can use the same ones
     * this node does. They were private here, and that is precisely why the agent's tool list stopped
     * at click/type/scroll while the machine underneath could drag and upload.
     */

    /** Wait for lazy content to settle (Facebook etc. fire load on a skeleton). Best-effort. */
    private fun waitSettle(maxMs: Int) {
        val end = System.currentTimeMillis() + maxMs
        var last = -1
        while (System.currentTimeMillis() < end) {
            val n = Cef.evalJs(main, "document.body?document.body.innerText.length:0").toIntOrNull() ?: 0
            if (n > 0 && n == last) return
            last = n; Thread.sleep(600)
        }
    }
}
