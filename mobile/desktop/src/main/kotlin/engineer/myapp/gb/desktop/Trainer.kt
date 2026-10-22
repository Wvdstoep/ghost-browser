package engineer.myapp.gb.desktop

import java.io.File
import org.json.JSONObject

/**
 * THIS MACHINE AS A TRAINING NODE — able or not, and honest about which.
 *
 * A round runs on whichever laptop is connected, which only means anything if a laptop can say
 * truthfully whether it is capable. The desktop node's own capability list carries the rule:
 *
 *   "a name here that execPath does not handle sends work to a machine that cannot do it, instead
 *    of to one that can — worse than saying nothing."
 *
 * So `trainer` is advertised only when this machine can genuinely take a round: a drive with room,
 * a Python that exists, a virtual environment with torch in it, and the base model cached. When it
 * cannot, it says WHAT IS MISSING rather than going quiet — a machine that is one `pip install`
 * away from being useful should not be indistinguishable from a phone.
 *
 * WHY THE DRIVE IS CHOSEN RATHER THAN ASSUMED. The laptop this was written on has C: at 98% full
 * with 6.3 GB free and D: with 849 GB. Defaulting to the user profile would have put a 3.5 GB
 * environment on the full disk and failed at the worst moment — half way through installing torch.
 * So it picks the drive with the most room and puts `gb-train` there.
 */
object Trainer {

    /** Room for the environment (~2 GB), the model (~1 GB), a slice, and somewhere to breathe. */
    const val NEEDED_GB = 6L

    private const val MODEL = "Qwen/Qwen2.5-0.5B-Instruct"

    @Volatile private var setupLog = mutableListOf<String>()
    @Volatile var settingUp = false; private set
    /** Called when a set-up ends, however it ends - the node re-registers with what it can do now. */
    @Volatile var onSetupDone: (() -> Unit)? = null
    /** The last thing set-up said, for the caps the hub shows while it runs. */
    fun setupLine(): String = setupLog.lastOrNull() ?: ""

    /**
     * WHERE THIS MACHINE TRAINS — an environment that already exists wins over a roomier drive.
     *
     * Picking purely by free space was right for the FIRST setup and wrong for every run after it.
     * A 3.5 GB environment, the cached base model and the round scripts live in one folder, and the
     * moment a larger disk appears — an external drive, a phone in file-transfer mode, a second
     * internal disk after a clean-up — `maxByOrNull { usableSpace }` moves the answer to it. The
     * existing environment does not move with it: it becomes invisible, the machine reports "the
     * training environment has not been built yet", and a setup downloads the whole thing again onto
     * the new disk. Unplug the drive and it moves back, now with two copies and no way to tell.
     *
     * So the order is: an explicit override, then a `gb-train` that is already BUILT (it has a venv
     * in it — an empty folder left behind by a cancelled setup must not pin the machine to a disk
     * that no longer has room), and only then the roomiest drive, which is what a first setup wants.
     *
     * Still not cached: a drive really does get unplugged, and the answer should change when the
     * machine does.
     */
    fun home(): File {
        val explicit = System.getenv("GB_TRAIN_HOME")
        if (!explicit.isNullOrBlank()) return File(explicit)
        val roots = File.listRoots().filter { it.totalSpace > 0 }
        val built = roots
            .map { File(it, "gb-train") }
            .firstOrNull { File(it, "venv/Scripts/python.exe").canExecute() }
        if (built != null) return built
        val best = roots.maxByOrNull { it.usableSpace } ?: File(System.getProperty("user.home"))
        return File(best, "gb-train")
    }

    fun freeGb(dir: File = home()): Long {
        /* The directory may not exist yet, so ask the nearest ancestor that does — asking a path
           that is not there reports zero, which reads as "no room" on a disk with plenty. */
        var probe: File? = dir
        while (probe != null && !probe.exists()) probe = probe.parentFile
        return ((probe?.usableSpace ?: 0L) / (1024L * 1024L * 1024L))
    }

    private fun exeIn(venv: File, name: String) = File(venv, "Scripts/$name.exe")

    /** The python that runs a round, or null when the environment is not built. */
    fun venvPython(): File? {
        val p = exeIn(File(home(), "venv"), "python")
        return if (p.canExecute()) p else null
    }

    /** A system python to BUILD the environment with. Without one, nothing else is possible. */
    fun systemPython(): String? {
        for (cmd in listOf(listOf("py", "-3", "--version"), listOf("python", "--version"), listOf("python3", "--version"))) {
            try {
                val p = ProcessBuilder(cmd).redirectErrorStream(true).start()
                val out = p.inputStream.bufferedReader().readText()
                if (p.waitFor() == 0 && out.contains("Python 3")) return cmd.dropLast(1).joinToString(" ")
            } catch (e: Exception) { /* try the next spelling */ }
        }
        return null
    }

    private fun scriptsPresent() = File(home(), "train_round.py").isFile && File(home(), "evaluate.py").isFile

    /**
     * IS THE ENVIRONMENT BUILT? ASKED OF THE DISK, BECAUSE THE IMPORT TAKES THREE MINUTES.
     *
     * This used to run `python -c "import torch, transformers, peft"` and read the exit code. The
     * answer is correct and it is useless here: measured on this machine, that import takes 176
     * SECONDS cold — torch alone unpacks a couple of hundred megabytes of extension modules off a
     * spinning disk. status() is called while the node builds its capability list on every
     * register, so a three-minute blocking probe sat in the middle of the one path that has to be
     * quick. Whatever gave up first — the register, the poll, the caller waiting on the reply — the
     * result reaching the hub was "torch is not installed in the environment" on a machine where
     * torch was installed, and the hub duly refused to send it a round.
     *
     * A package that is on disk is a package pip put there. That is the same fact, it costs two
     * milliseconds, and it cannot time out. The real import still happens where a three-minute wait
     * is expected and wanted: the first thing a round does is import them for real, and a broken
     * install fails there, loudly, in a place that is already slow.
     */
    private fun torchPresent(): Boolean {
        val venv = File(home(), "venv")
        return listOf("torch", "transformers", "peft")
            .all { File(venv, "Lib/site-packages/$it/__init__.py").isFile }
    }

    /**
     * What this machine can and cannot do, as data.
     *
     * `ready` is the only thing the hub routes on; `missing` is what a person needs to see. They are
     * deliberately separate: a machine is either usable or it is not, and the reasons are for the
     * screen, not for the scheduler to interpret.
     */
    fun status(): JSONObject {
        val dir = home()
        val free = freeGb(dir)
        val missing = mutableListOf<String>()

        val sys = systemPython()
        if (sys == null) missing.add("Python 3 is not installed on this machine")
        if (free < NEEDED_GB) missing.add("needs ${NEEDED_GB} GB free on ${dir.absolutePath.take(3)} — ${free} GB available")
        if (venvPython() == null) missing.add("the training environment has not been built yet")
        else if (!torchPresent()) missing.add("torch is not installed in the environment")
        if (!scriptsPresent()) missing.add("the round scripts are not here yet")

        return JSONObject()
            .put("ready", missing.isEmpty())
            .put("home", dir.absolutePath)
            .put("freeGb", free)
            .put("neededGb", NEEDED_GB)
            .put("settingUp", settingUp)
            .put("missing", missing)
            .put("canSetUp", sys != null && free >= NEEDED_GB)
            .put("log", setupLog.takeLast(8))
    }

    /**
     * BUILD THE ENVIRONMENT. Once, in the background, reporting as it goes.
     *
     * Deliberately refuses rather than half-succeeds: installing torch into a drive with four
     * gigabytes free fails part way and leaves an environment that imports but cannot run, which is
     * far worse than not starting. The space check is therefore a gate, not a warning.
     *
     * Python itself is NOT installed here. Automating a system-wide runtime install on somebody's
     * laptop is not a thing a browser should do quietly, and a clear "install Python 3" is a thirty
     * second job for the owner.
     */
    /**
     * Fetch the round scripts from the cluster.
     *
     * They ship in the browser's own image rather than living on any one laptop, which is the whole
     * of what makes "whichever laptop is connected" true. Without this a second machine needs
     * somebody to walk over with a USB stick and the setup is only automatic on the first one.
     */
    private fun fetchScripts(say: (String) -> Unit): Boolean {
        var ok = true
        for (name in listOf("train_round.py", "evaluate.py", "export_model.py")) {
            val body = try { Cluster.authed("GET", "/v1/training/script/$name", null) } catch (e: Exception) { "" }
            if (body.length < 200 || body.trimStart().startsWith("{\"error\"")) {
                say("could not fetch $name from the cluster"); ok = false; continue
            }
            try {
                File(home(), name).writeText(body)
                say("fetched $name")
            } catch (e: Exception) { say("could not write $name: ${e.message}"); ok = false }
        }
        return ok
    }

    fun setUp(report: (String) -> Unit): Boolean {
        if (settingUp) { report("setup is already running"); return false }
        val sys = systemPython()
        if (sys == null) { report("cannot set up: Python 3 is not installed"); return false }
        val dir = home()
        if (freeGb(dir) < NEEDED_GB) { report("cannot set up: needs $NEEDED_GB GB free, has ${freeGb(dir)} GB"); return false }

        settingUp = true
        setupLog = mutableListOf()
        Thread({
            try {
                fun say(s: String) { setupLog.add(s); report(s) }
                dir.mkdirs()
                say("setting up training in ${dir.absolutePath}")

                val venv = File(dir, "venv")
                if (venvPython() == null) {
                    say("building the environment (this takes a few minutes)")
                    run(listOf(*sys.split(" ").toTypedArray(), "-m", "venv", venv.absolutePath), dir, ::say)
                }
                val py = venvPython() ?: run { say("the environment was not created"); return@Thread }

                if (!torchPresent()) {
                    /*
                     * CPU wheels explicitly. The default index serves a CUDA build that is several
                     * gigabytes larger and cannot be used by any machine in this ring — it would
                     * fill the disk we just checked and then not work.
                     */
                    say("installing torch (CPU build, about 2 GB)")
                    run(listOf(py.absolutePath, "-m", "pip", "install", "--quiet",
                        "--index-url", "https://download.pytorch.org/whl/cpu", "torch"), dir, ::say)
                    say("installing transformers, peft, accelerate")
                    run(listOf(py.absolutePath, "-m", "pip", "install", "--quiet",
                        "transformers", "peft", "accelerate", "psutil"), dir, ::say)
                    /* pip is quiet on success and this check is not: a wheel that did not land
                       is said in words here, not discovered as "torch is not installed" later. */
                    if (!torchPresent()) say("torch or its companions did not install — pip's lines above say why; free space now ${freeGb(dir)} GB")
                }
                /*
                 * THE EXPORT TOOLS. A promoted adapter leaves this machine as one GGUF file the
                 * cluster's model server can load; llama.cpp's converter makes it, and it needs
                 * the gguf and sentencepiece packages. Cheap, idempotent, and only the converter
                 * needs git - without git the round still trains and only the export is refused.
                 */
                run(listOf(py.absolutePath, "-m", "pip", "install", "--quiet", "gguf", "sentencepiece", "protobuf"), dir, ::say)
                val llama = File(dir, "tools/llama.cpp")
                if (!File(llama, "convert_hf_to_gguf.py").isFile) {
                    File(dir, "tools").mkdirs()
                    say("fetching llama.cpp's converter")
                    run(listOf("git", "clone", "--quiet", "--depth", "1", "https://github.com/ggml-org/llama.cpp.git", llama.absolutePath), dir, ::say)
                }

                /* The scripts before the model: a machine that fetched a gigabyte and then could
                   not get the fifty kilobytes that use it is set up and still unable to train. */
                fetchScripts(::say)

                say("fetching the base model (about 1 GB)")
                run(listOf(py.absolutePath, "-c",
                    "from transformers import AutoModelForCausalLM, AutoTokenizer;" +
                    "AutoTokenizer.from_pretrained('$MODEL');" +
                    "AutoModelForCausalLM.from_pretrained('$MODEL')"), dir, ::say)

                say(if (status().getBoolean("ready")) "ready to train" else "still not ready: " + status().getJSONArray("missing"))
            } catch (e: Throwable) {
                setupLog.add("setup failed: ${e.message}")
                report("setup failed: ${e.message}")
            } finally {
                settingUp = false
                try { onSetupDone?.invoke() } catch (e: Throwable) { /* the node's business */ }
            }
        }, "gb-trainer-setup").apply { isDaemon = true }.start()
        return true
    }

    private fun run(cmd: List<String>, cwd: File, say: (String) -> Unit) {
        val p = ProcessBuilder(cmd).directory(cwd).redirectErrorStream(true).start()
        p.inputStream.bufferedReader().forEachLine { l ->
            /* Only lines worth a status page: pip prints thousands. */
            if (l.contains("error", true) || l.contains("Successfully", true)) say(l.trim().take(160))
        }
        val code = p.waitFor()
        if (code != 0) say("step exited $code")
    }

    /**
     * EXPORT A PROMOTED ROUND. Merge the adapter into the base, convert to one GGUF file, upload it
     * and have the cluster register it as a served model. Minutes of work and a gigabyte of
     * upload, so it is detached like a round; the script reports to the cluster itself.
     */
    fun exportModel(adapter: String, tag: String, base: String, roundId: String, hub: String, token: String, report: (String) -> Unit): Boolean {
        val py = venvPython() ?: run { report("not set up to train"); return false }
        fetchScripts(report)
        val script = File(home(), "export_model.py")
        if (!script.isFile) { report("the export script is not here"); return false }
        if (adapter.isBlank() || !File(adapter).isDirectory) { report("no adapter at $adapter"); return false }
        if (!File(home(), "tools/llama.cpp/convert_hf_to_gguf.py").isFile) { report("the converter is not set up — run setup again"); return false }
        val cmd = mutableListOf(py.absolutePath, script.absolutePath, "--adapter", adapter, "--tag", tag, "--round", roundId, "--hub", hub, "--token", token)
        if (base.isNotBlank()) { cmd.add("--base"); cmd.add(base) }
        return try {
            ProcessBuilder(cmd).directory(home())
                .redirectOutput(File(home(), "last-export.log")).redirectErrorStream(true)
                .apply { environment()["PYTHONUNBUFFERED"] = "1"; environment()["PYTHONIOENCODING"] = "utf-8" }
                .start()
            report("exporting $tag from $adapter")
            true
        } catch (e: Exception) { report("could not start the export: ${e.message}"); false }
    }

    /**
     * TAKE A ROUND. Launched and left alone.
     *
     * The script reports its own progress to the cluster and writes its own result, so there is
     * nothing for this process to supervise — and supervising it would mean a round dying when the
     * browser restarts. It is detached on purpose.
     */
    /** The round this machine is on, so a second one is refused while it is alive. */
    @Volatile private var roundProcess: Process? = null

    /**
     * STOP, AND KILL THE WHOLE TREE. The trainer forks an exam process; ending only the parent
     * would leave a python on the machine scoring an adapter nobody will read - and a round of an
     * earlier app instance is not this process's child at all. So: this process's descendants,
     * then itself, then any python of the training environment still alive. Forcibly, because a
     * training step does not answer a polite request. Nothing here reports to the hub: the hub
     * marked the round before it asked, and the watcher below sees a round that is not running
     * and keeps quiet.
     */
    fun stopRound(roundId: String, report: (String) -> Unit): org.json.JSONObject {
        var n = 0
        val p = roundProcess
        if (p != null && p.isAlive) {
            val kids = try { p.toHandle().descendants().toList() } catch (e: Exception) { emptyList() }
            for (k in kids) { try { if (k.destroyForcibly()) n++ } catch (e: Exception) { } }
            try { if (p.destroyForcibly() != null) n++ } catch (e: Exception) { }
            try { p.waitFor(10, java.util.concurrent.TimeUnit.SECONDS) } catch (e: Exception) { }
        }
        n += killStrays()
        report(if (n > 0) "■ round ${roundId.ifBlank { "on this machine" }} stopped by the owner — $n trainer process(es) ended"
               else "no trainer process was running on this machine")
        return org.json.JSONObject().put("stopped", n > 0).put("processes", n)
    }

    /**
     * DISK. Every round leaves its adapters in rounds/<stamp>/ - a few hundred MB each - and
     * Karolina's C: drive hit 0 GB free during the fourth round. The two newest round folders are
     * kept (the last adapter and the one before it, for a retry); older ones are removed before a
     * new round starts. The promoted adapter lives on the hub and the model server, not here.
     */
    fun pruneRounds(report: (String) -> Unit, keep: Int = 2): Int {
        val dir = File(home(), "rounds")
        val rounds = dir.listFiles { f -> f.isDirectory && f.name.startsWith("round-") }?.sortedByDescending { it.name } ?: return 0
        var freed = 0L; var n = 0
        for (old in rounds.drop(keep)) {
            val size = old.walkBottomUp().filter { it.isFile }.sumOf { it.length() }
            if (old.deleteRecursively()) { freed += size; n++ }
        }
        if (n > 0) report("removed $n old round folder(s), ${freed / 1_000_000} MB freed")
        return n
    }

    /** Every python of this machine's training environment still alive - an earlier instance's round, an orphaned exam. */
    private fun killStrays(): Int {
        val venv = File(home(), "venv").absolutePath.lowercase().replace('/', '\\')
        var n = 0
        try {
            ProcessHandle.allProcesses().forEach { h ->
                val cmd = h.info().command().orElse("").lowercase().replace('/', '\\')
                if (cmd.startsWith(venv) && cmd.contains("python")) { try { if (h.destroyForcibly()) n++ } catch (e: Exception) { } }
            }
        } catch (e: Exception) { }
        return n
    }

    fun runRound(base: String, hours: Double, hub: String, token: String, report: (String) -> Unit): Boolean {
        val py = venvPython() ?: run { report("not set up to train"); return false }
        /*
         * ONE ROUND PER MACHINE. The hub read a quiet exam as a dead round and handed this laptop a
         * second one; the two halved each other for an hour. The machine knows better than the hub
         * whether its round is alive - it holds the process - so it refuses here.
         */
        roundProcess?.let { if (it.isAlive) { report("a round is still running on this machine — not starting another"); return false } }
        /*
         * The cluster's copy of the script is the one that ships with the image, so every round
         * trains with the recipe the cluster is serving today. A laptop set up months ago would
         * otherwise keep running the recipe it was set up with, and two machines would silently
         * train two different ways. Best effort: if the cluster cannot be reached the local copy
         * is still a round.
         */
        fetchScripts(report)
        /* Old round folders go first: each holds two adapters (a few hundred MB), and a laptop
           with a small C: drive filled up after a handful of rounds. The last two rounds stay. */
        pruneRounds(report)
        val script = File(home(), "train_round.py")
        if (!script.isFile) { report("the round script is not here"); return false }

        val cmd = mutableListOf(py.absolutePath, script.absolutePath,
            "--data", File(home(), "data").absolutePath,
            "--out", File(home(), "rounds").absolutePath,
            "--hours", hours.toString())
        if (base.isNotBlank()) { cmd.add("--adapter"); cmd.add(base) }

        return try {
            roundProcess = ProcessBuilder(cmd)
                .directory(home())
                .redirectOutput(File(home(), "last-round.log"))
                .redirectErrorStream(true)
                .apply {
                    environment()["GB_HUB"] = hub
                    environment()["GB_TOKEN"] = token
                    environment()["PYTHONUNBUFFERED"] = "1"
                    environment()["PYTHONIOENCODING"] = "utf-8"
                    environment()["OMP_NUM_THREADS"] = "6"
                }
                .start()
            roundProcess?.let { watchRound(it, report); giveWay(it, report) }
            report("started a training round (${hours}h)")
            true
        } catch (e: Exception) {
            report("could not start the round: ${e.message}")
            false
        }
    }

    /*
     * A ROUND THAT DIES SAYS SO. On 24 Sep 2026 the trainer crashed at 20:42 - an access violation
     * inside Torch, recorded by Windows - and nothing told the hub: the round read "running" for the
     * seventy-five minutes the planner waits, and the Studio showed a round that had been dead for an
     * hour. So the process is watched, and an exit the script did not announce itself is reported as
     * a failed round, with the exit code in words, and the planner starts the next one.
     */
    /*
     * THE TRAINER COMES FIRST ON A MACHINE THAT IS TRAINING. Measured on 24 Sep 2026: this app's
     * own Chromium helpers took seven of eight cores all night and the round crawled at a sixth of
     * its pace. While a round runs, the trainer is raised above normal and the browser helpers are
     * lowered to idle; when it ends, they are put back. Windows only, through PowerShell, because
     * the JVM cannot set another process's priority itself.
     */
    private fun giveWay(p: Process, report: (String) -> Unit) {
        if (!System.getProperty("os.name", "").lowercase().contains("win")) return
        fun ps(script: String) { try { ProcessBuilder("powershell", "-NoProfile", "-Command", script).redirectErrorStream(true).start().waitFor() } catch (e: Exception) { /* best effort */ } }
        Thread {
            Thread.sleep(3000)
            val raise = "Get-Process jcef_helper -ErrorAction SilentlyContinue | ForEach-Object { try { \$_.PriorityClass = 'Idle' } catch {} }; " +
               "Get-Process 'Ghost Browser' -ErrorAction SilentlyContinue | ForEach-Object { try { \$_.PriorityClass = 'BelowNormal' } catch {} }; " +
               "Get-Process python -ErrorAction SilentlyContinue | ForEach-Object { try { \$_.PriorityClass = 'AboveNormal' } catch {} }"
            ps(raise)
            report("the trainer has the cores while the round runs; the browser waits")
            /* Re-applied every minute: the exam runs in a child process the trainer starts later,
               and a browser helper that restarts comes back at normal priority. */
            while (p.isAlive) {
                try { Thread.sleep(60000) } catch (e: Exception) { break }
                if (p.isAlive) ps(raise)
            }
            ps("Get-Process jcef_helper -ErrorAction SilentlyContinue | ForEach-Object { try { \$_.PriorityClass = 'Normal' } catch {} }; " +
               "Get-Process 'Ghost Browser' -ErrorAction SilentlyContinue | ForEach-Object { try { \$_.PriorityClass = 'Normal' } catch {} }")
        }.apply { isDaemon = true; name = "gb-round-priority" }.start()
    }

    /** The newest round's last checkpoint on this machine, for a retry to continue from. */
    private fun lastCheckpoint(): String {
        val rounds = File(home(), "rounds").listFiles { f -> f.isDirectory } ?: return ""
        val newest = rounds.maxByOrNull { it.lastModified() } ?: return ""
        val last = File(newest, "adapter-last")
        return if (File(last, "adapter_config.json").isFile) last.absolutePath else ""
    }

    private fun watchRound(p: Process, report: (String) -> Unit) {
        Thread {
            val code = try { p.waitFor() } catch (e: Exception) { -1 }
            if (code == 0) return@Thread
            val log = try { File(home(), "last-round.log").readText() } catch (e: Exception) { "" }
            val id = Regex("round (r-[a-z0-9-]+) on").find(log)?.groupValues?.get(1) ?: return@Thread
            /* The script reports its own end on every path it knows; only a round the hub still
               believes is running was cut short without a word. */
            var running = false
            try {
                val rounds = org.json.JSONObject(Cluster.authed("GET", "/v1/training/state", null)).optJSONArray("rounds")
                if (rounds != null) for (i in 0 until rounds.length()) { val r = rounds.getJSONObject(i); if (r.optString("id") == id) running = r.optString("status") == "running" }
            } catch (e: Exception) { running = false }
            if (!running) return@Thread
            val why = when (code) {
                -1073741819 -> "the trainer process died on this machine: access violation in Python/Torch (Windows 0xC0000005)"
                -1073741571 -> "the trainer process died on this machine: stack overflow"
                else -> "the trainer process died on this machine with exit code $code"
            }
            report("✖ $why — reported to the hub")
            /* The last checkpoint travels with the failure, so the retry continues from it. */
            val ckpt = lastCheckpoint()
            try { Cluster.authed("POST", "/v1/training/rounds/$id/end", org.json.JSONObject().put("status", "failed").put("why", why).put("adapter", ckpt).toString()) } catch (e: Exception) { }
        }.apply { isDaemon = true; name = "gb-round-watch" }.start()
    }
}
