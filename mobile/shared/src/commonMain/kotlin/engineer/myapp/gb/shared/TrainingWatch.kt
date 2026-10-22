package engineer.myapp.gb.shared

/**
 * THE TRAINING PIPELINE, READ ONCE FOR EVERY SURFACE.
 *
 * The model is meant to improve every night without anybody driving it, and that is exactly why it
 * needs a face. An unattended loop with no surface is indistinguishable from a broken one: the model
 * either gets better or it does not, and nobody finds out which for weeks.
 *
 * Parsed at string level, like [RingWatch] and for the same reason — commonMain deliberately carries
 * no JSON parser, because one would have to be satisfied on android, jvm and wasm alike to render a
 * status screen.
 *
 * Two screens read this, and they read the SAME object: the pipeline screen in Settings, and each
 * device's row in the Device Hub. Deriving "what is this laptop doing" separately in two places is
 * how two screens come to disagree about one machine in front of the person who has to trust them.
 */
object TrainingWatch {

    data class Tiers(val gold: Int = 0, val silver: Int = 0, val bronze: Int = 0, val void: Int = 0) {
        val judged: Int get() = gold + silver + bronze + void
        /** What a round may actually learn from. Bronze is evidence of what NOT to do; void is nobody's fault. */
        val usable: Int get() = gold + silver
    }

    data class Corpus(
        val tiers: Tiers = Tiers(),
        val jobs: Int = 0,
        val unjudged: Int = 0,
        /** The history is read in slices, so early on this number is still climbing. */
        val scanning: Boolean = false,
        val pending: Int = 0,
        val usableSinceLastRound: Int = 0,
        val enoughForARound: Boolean = false,
    )

    data class Dataset(
        val builtAt: String = "",
        val trainTurns: Int = 0,
        val evalTurns: Int = 0,
        val rejectTurns: Int = 0,
        val tiers: Tiers = Tiers(),
        /** Why turns were thrown away, largest first — the set's own account of itself. */
        val dropped: List<Pair<String, Int>> = emptyList(),
        val indexTurns: Int = 0,
        val indexLearnable: Int = 0,
        /** Turns whose latest observation carries the page they decide on. The gate a round waits on;
         *  -1 when the set was built before anyone counted. */
        val sightedTurns: Int = -1,
    )

    /** What one device is doing, or last did. */
    data class DeviceRound(
        val roundId: String = "",
        val status: String = "",
        val stale: Boolean = false,
        val silentForMin: Int = -1,
        val turns: Int = 0,
        val last: String = "",
        val promoted: Boolean = false,
        val baseline: Double = -1.0,
        val result: Double = -1.0,
    ) {
        val running: Boolean get() = status == "running"
    }

    data class Round(
        val id: String = "",
        val device: String = "",
        val status: String = "",
        val startedAt: String = "",
        val endedAt: String = "",
        val turns: Int = 0,
        val promoted: Boolean = false,
        val why: String = "",
        val baseline: Double = -1.0,
        val result: Double = -1.0,
        val lines: List<String> = emptyList(),
        /** What it trained with, as one line: "r32 all · lr 2e-4 · 3 epochs × 16 · cpu float32". */
        val recipe: String = "",
        /** The validation curve: (turns seen, held-out loss) per check, in order. */
        val validation: List<Pair<Int, Double>> = emptyList(),
        val bestValLoss: Double = -1.0,
        val bestAtTurns: Int = 0,
        /** The tool AND its arguments, after and before; the collapse ratio and the tool it collapsed onto. */
        val args: Double = -1.0,
        val baselineArgs: Double = -1.0,
        val collapse: Double = -1.0,
        val collapseTool: String = "",
        val unusable: Double = -1.0,
        val perTool: List<Agree> = emptyList(),
        /** What it trained: base, platform:<name> or role:<name>. Blank on a round from before the scopes. */
        val scope: String = "",
        /** The batch this round is a share of, how many machines share it, whether it is the merge of the shares, and the merge it went into. */
        val batch: String = "",
        val share: Int = 1,
        val merge: Boolean = false,
        val mergedInto: String = "",
        /* How long it was given and the mode of its batch - a running batch shows its own numbers, not the settings for the next. */
        val hours: Double = 0.0,
        val mode: String = "",
        val lastAt: String = "",
    ) {
        /** Beat its own baseline. A round that merely finished is not this. */
        val won: Boolean get() = baseline >= 0 && result > baseline
        /** Said one answer far more often than it was right - the failure a headline cannot see. */
        val collapsed: Boolean get() = collapse > 2.0
    }

    data class Serving(
        val adapter: String = "",
        val agreement: Double = -1.0,
        val beat: Double = -1.0,
        val promotedAt: String = "",
        val device: String = "",
    )

    /**
     * A machine that could train, and whether it may.
     *
     * ABLE and ALLOWED are different questions and both have to be on the row. Able is the machine's
     * own answer — a drive with room, an environment built, the model cached — and only it knows.
     * Allowed is the owner's choice, and only the cluster knows. A machine that is able and not
     * allowed must look different from one that is willing and cannot, or the reason nothing is
     * happening is invisible.
     */
    data class Trainer(
        /* A GPU node's GPU and kind (modal, colab, kaggle), blank on a laptop. */
        val gpu: String = "",
        val node: String = "",
        val name: String,
        val deviceId: String = "",
        val online: Boolean,
        val able: Boolean = false,
        val allowed: Boolean = false,
        val freeGb: Int = 0,
        val home: String = "",
        val canSetUp: Boolean = false,
        val missing: List<String> = emptyList(),
        val round: DeviceRound?,
        /** A set-up in progress on it, and the last thing that set-up said. */
        val settingUp: Boolean = false,
        val setupLine: String = "",
    )

    /**
     * COLLECTING BY ITSELF — the loop that used to be the owner typing one prompt at a time.
     *
     * `aiming` is the part worth putting on screen. A toggle that says only on or off gives no way
     * to tell a generator doing useful work from one writing twenty variations of a Google search,
     * and the whole value of this thing is which gaps it is going after.
     */
    /**
     * ONE COLLECTED PROMPT AND WHAT CAME OF IT.
     *
     * A card that says "31 prompts collected" and nothing else cannot be acted on. The only
     * question worth asking of a collector is whether what it collected was any GOOD, so the row
     * carries the grade, the tools the run actually used, and the verifier's own first sentence.
     */
    data class Collected(
        val at: String = "",
        val prompt: String = "",
        val jobId: String = "",
        val state: String = "",
        val grade: String = "",
        val calls: Int = 0,
        val tools: List<String> = emptyList(),
        val why: String = "",
    )

    /**
     * Re-opening the pages the old runs read, so their decisions stop being blind. Costs browser
     * time and no model credit, which is why it is the thing to run when the allowance is spent.
     */
    data class Resight(
        val on: Boolean = false,
        val accepted: Int = 0,
        val rejected: Int = 0,
        /** Blind reads still waiting; -1 until the first batch has counted them. */
        val left: Int = -1,
        val lastWhy: String = "",
        val lastAt: String = "",
    )

    /** One of the six readiness checks: a value against a threshold, and the sentence about it. */
    data class Check(
        val name: String = "",
        val ok: Boolean = false,
        /** A gating check stops a round; an advisory one only aims the collector. */
        val gate: Boolean = false,
        val value: Int = 0,
        val threshold: Int = 0,
        val score: Int = 0,
        val text: String = "",
    )

    /** Is the set ready to train on - the six checks, the weakest as the score, and what to aim at. */
    data class Readiness(
        val ok: Boolean = false,
        val score: Int = 0,
        val why: String = "",
        val aim: List<String> = emptyList(),
        val checks: List<Check> = emptyList(),
    )

    data class ToolRow(val tool: String = "", val all: Int = 0, val sighted: Int = 0, val gold: Int = 0)

    /** What the set holds per tool, sighted or blind. */
    data class Coverage(val total: Int = 0, val sighted: Int = 0, val perTool: List<ToolRow> = emptyList())

    /** The planner's decision right now: whether a round would start, and why or why not. */
    data class Plan(val run: Boolean = false, val why: String = "", val scope: String = "")

    /**
     * ONE SCOPE OF WEIGHTS - base, a platform, a role (trainScopes.js on the cluster): its sighted
     * turns in the set and in the paper, how many rounds of it have trained on, the adapter that
     * serves for it and the one it chains from, and the served model's stage when there is one.
     */
    data class Scope(
        val level: String = "", val name: String = "", val key: String = "",
        val platform: String = "", val sighted: Int = 0, val all: Int = 0, val exam: Int = 0, val seen: Int = 0,
        val adapter: String = "", val parentAdapter: String = "", val model: String = "",
        val stage: String = "", val stageWhy: String = "",
    ) {
        val label: String get() = if (level == "base") "base" else name
        val untrained: Int get() = (sighted - seen).coerceAtLeast(0)
    }

    /** A served model and what it has earned (autopilot.js): shadow, canary or primary, and why. */
    data class ModelStage(val key: String = "", val model: String = "", val stage: String = "", val why: String = "", val agree: Double = 0.0, val good: Double = 0.0, val judged: Int = 0, val fallback: Double = 0.0)

    data class Login(val profile: String = "", val platform: String = "")
    data class Practiced(val at: String = "", val role: String = "", val platform: String = "", val profile: String = "", val prompt: String = "", val jobId: String = "")

    /** The platform-and-role collector (practice.js): a thin role doing its own job, signed in. */
    data class Practice(
        val on: Boolean = false,
        val stoppedBecause: String = "",
        val currentRole: String = "", val currentPrompt: String = "", val currentProfile: String = "", val currentJob: String = "",
        val queued: Int = 0, val lastHour: Int = 0, val capPerHour: Int = 6,
        val history: List<Practiced> = emptyList(),
        val logins: List<Login> = emptyList(),
        /** Automatic acting is on - practice refuses to run until it is off. */
        val autoAct: Boolean = false,
    )

    /** One platform in the platform map: how many recorded steps and distinct pages it knows. */
    data class PlatformPages(val name: String = "", val turns: Int = 0, val pages: Int = 0)

    /** The teacher judging the old runs step by step - the third loop. */
    data class Judge(
        val on: Boolean = false,
        val runs: Int = 0,
        val steps: Int = 0,
        val wrong: Int = 0,
        val reasons: Int = 0,
        val calls: Int = 0,
        val left: Int = -1,
        val lastWhy: String = "",
    )

    /** One recorded run, as the browser lists it. */
    data class RunRow(
        val id: String = "",
        val goal: String = "",
        val role: String = "",
        val profile: String = "",
        val status: String = "",
        val createdAt: String = "",
        val tier: String = "",
        val grade: String = "",
        val calls: Int = 0,
        val sighted: Int = 0,
        val judged: Int = 0,
        val human: Int = 0,
        val wrong: Int = 0,
        val tools: List<String> = emptyList(),
    )

    /** One step of a run, with every verdict on it. */
    data class RunStep(
        val n: Int = 0,
        val kind: String = "",
        val text: String = "",
        val tool: String = "",
        val args: String = "",
        val content: String = "",
        val marks: Int = 0,
        val judgedVerdict: String = "",
        val judgedWhy: String = "",
        val reason: String = "",
        val humanVerdict: String = "",
        val resighted: Boolean = false,
    ) {
        val isCall: Boolean get() = kind == "tool" && tool.isNotBlank()
    }

    data class RunDetail(
        val id: String = "",
        val goal: String = "",
        val role: String = "",
        val profile: String = "",
        val status: String = "",
        val createdAt: String = "",
        val report: String = "",
        val tier: String = "",
        val why: List<String> = emptyList(),
        val steps: List<RunStep> = emptyList(),
    )

    /** A card rented right now, or the last one. */
    data class Rental(
        val id: String = "",
        val gpuType: String = "",
        val since: String = "",
        val costPerHr: Double = -1.0,
        val costSoFar: Double = -1.0,
        val tag: String = "",
        val notes: List<String> = emptyList(),
        val endedAt: String = "",
        val why: String = "",
        val hours: Double = -1.0,
        val cost: Double = -1.0,
    )

    /**
     * WHERE ROUNDS RUN. One flow at a time: the laptops that offered, or a card rented per round
     * and destroyed after it. The key never comes back from the server; only whether it is set.
     */
    data class Gpu(
        val trainOn: String = "laptop",
        /** How long one BATCH runs: 3, 6, 12 or 24 hours. */
        val trainHours: Int = 12,
        /** How the machines share a batch: "time" (each runs its part of the hours) or "work" (each runs the full hours on its own share). */
        val trainShare: String = "time",
        /** How many machines would share the next batch right now. */
        val machines: Int = 1,
        val provider: String = "runpod",
        val keySet: Boolean = false,
        val keyHint: String = "",
        val gpuType: String = "",
        val cloud: String = "COMMUNITY",
        val maxHours: Double = 2.0,
        val hub: String = "",
        val types: List<String> = emptyList(),
        val pod: Rental? = null,
        val last: Rental? = null,
    )

    /** One tool or role in the live ledger: how often the student agreed with the teacher. */
    data class Agree(val name: String = "", val seen: Int = 0, val agree: Int = 0, val pct: Double = 0.0, val argsPct: Double = 0.0)

    /** One recent step: what the teacher did, what the student said. */
    data class Shadowed(val at: String = "", val role: String = "", val teacher: String = "", val student: String = "", val agree: Boolean = false)

    /**
     * The model WE trained, served beside the teacher: the mode it is in, whether the sidecar
     * answers, and the live ledger of its answers against the teacher's on real jobs.
     */
    data class Student(
        val mode: String = "off",
        val model: String = "",
        val share: Int = 10,
        /** Null until asked; false when the sidecar does not answer. */
        val reachable: Boolean? = null,
        val hasModel: Boolean = false,
        val models: List<String> = emptyList(),
        val seen: Int = 0,
        val agreePct: Double = 0.0,
        val argsPct: Double = 0.0,
        val unusablePct: Double = 0.0,
        val perTool: List<Agree> = emptyList(),
        val perRole: List<Agree> = emptyList(),
        val recent: List<Shadowed> = emptyList(),
        val drivenSteps: Int = 0,
        val fallbackPct: Double = 0.0,
        val drivenJobs: Int = 0,
        /** Autopilot: the most specific model that earned its stage answers; off, the mode above rules. */
        val autopilot: Boolean = true,
        /** The model map: scope key -> served tag. */
        val map: List<Pair<String, String>> = emptyList(),
        val stages: List<ModelStage> = emptyList(),
    )

    /** A walk the collector has going right now. */
    data class Walk(
        val jobId: String = "",
        val profile: String = "",
        val goal: String = "",
        val steps: Int = 0,
        val since: String = "",
        val last: String = "",
    )

    data class Harvest(
        val on: Boolean = false,
        val queued: Int = 0,
        val next: String = "",
        val inLastHour: Int = 0,
        val capPerHour: Int = 0,
        val collected: Int = 0,
        val aiming: List<String> = emptyList(),
        val stoppedBecause: String = "",
        val why: String = "",
        /** On, but the plan says not now — the why above says why (allowance spent, at width, cap). */
        val waiting: Boolean = false,
        val keysUsable: Int = -1,
        val keysTotal: Int = -1,
        val runs: List<Collected> = emptyList(),
        val tally: List<Pair<String, Int>> = emptyList(),
        val walks: List<Walk> = emptyList(),
    )

    data class View(
        val corpus: Corpus = Corpus(),
        val dataset: Dataset? = null,
        val serving: Serving? = null,
        val rounds: List<Round> = emptyList(),
        val trainers: List<Trainer> = emptyList(),
        val byDevice: Map<String, DeviceRound> = emptyMap(),
        /* Whether the loop runs itself, and how much of the set it has been through. */
        val auto: Boolean = false,
        /* LEARNED: turns trained on by an adapter that passed the gates. ATTEMPTED: turns every
           finished round trained on, kept or not - the number that used to be shown as learned. */
        val covered: Int = 0,
        val attempted: Int = 0,
        /* What the next batch will be for the settings and the machines online, at three epochs. */
        val sizing: Sizing? = null,
        /* GPU nodes (Modal, Colab, Kaggle): the joins minted and the Modal state. Null on an older hub. */
        val nodes: Nodes? = null,
        /* Null until the harvest state has been read, so the card can stay off the page on a
           build whose cluster does not serve it yet rather than showing a dead toggle. */
        val harvest: Harvest? = null,
        /* Old runs getting their pages back. Null on a cluster that does not do this yet. */
        val resight: Resight? = null,
        /* The planner's decision, the six checks, and the set per tool - null on an older cluster. */
        val plan: Plan? = null,
        val readiness: Readiness? = null,
        val coverage: Coverage? = null,
        /* The served student, null on a cluster that cannot serve one yet. */
        val student: Student? = null,
        /* Where rounds run and the rental, null on a cluster without the GPU flow. */
        val gpu: Gpu? = null,
        /* The teacher judging old runs, null on a cluster without it. */
        val judge: Judge? = null,
        /* The scopes of weights, the practice collector and the platform map - empty or null on an
           older cluster, so their cards stay off the page rather than showing nothing. */
        val scopes: List<Scope> = emptyList(),
        val practice: Practice? = null,
        val platformMap: List<PlatformPages> = emptyList(),
        /* Shares handed out but not registered yet. */
        val pending: List<Pending> = emptyList(),
        /* The field of candidate students and what each scored on this paper. Null on an older hub. */
        val students: Students? = null,
        val error: String = "",
    ) {
        /** A round happening right now, anywhere in the ring - the first of them. */
        val active: Round? get() = rounds.firstOrNull { it.status == "running" }
        /** EVERY round running right now: two machines train two scopes at once. */
        val actives: List<Round> get() = rounds.filter { it.status == "running" }
    }

    // ── reading it ───────────────────────────────────────────────────────────────────────────────

    fun parse(json: String): View {
        if (json.isBlank()) return View(error = "nothing came back")
        val err = RingWatch.stringField(json, "error")
        if (err.isNotBlank() && objectField(json, "corpus") == null) return View(error = err)

        val corpusObj = objectField(json, "corpus")
        val corpus = if (corpusObj == null) Corpus() else Corpus(
            tiers = tiersOf(objectField(corpusObj, "tiers")),
            jobs = intField(corpusObj, "jobs"),
            unjudged = intField(corpusObj, "unjudged"),
            scanning = boolField(corpusObj, "scanning"),
            pending = intField(corpusObj, "pending"),
            usableSinceLastRound = intField(corpusObj, "usableSinceLastRound"),
            enoughForARound = boolField(corpusObj, "enoughForARound"),
        )

        val dsObj = objectField(json, "dataset")
        val dataset = dsObj?.let {
            val turns = objectField(it, "turns")
            val marks = objectField(it, "marks")
            Dataset(
                builtAt = RingWatch.stringField(it, "builtAt"),
                trainTurns = intField(turns ?: "", "train"),
                evalTurns = intField(turns ?: "", "eval"),
                rejectTurns = intField(turns ?: "", "reject"),
                tiers = tiersOf(objectField(it, "tiers")),
                dropped = pairsOf(objectField(it, "dropped")).sortedByDescending { p -> p.second },
                indexTurns = intField(marks ?: "", "indexTurns"),
                indexLearnable = intField(marks ?: "", "indexWithMarks"),
                sightedTurns = if (marks != null && keyPresent(marks, "turnsWithContent")) intField(marks, "turnsWithContent") else -1,
            )
        }

        val svObj = objectField(json, "serving")
        val serving = svObj?.let {
            Serving(
                adapter = RingWatch.stringField(it, "adapter"),
                agreement = numField(it, "agreement"),
                beat = numField(it, "beat"),
                promotedAt = RingWatch.stringField(it, "promotedAt"),
                device = RingWatch.stringField(it, "device"),
            )
        }

        val rounds = objectsInArray(json, "rounds").map { o ->
            Round(
                id = RingWatch.stringField(o, "id"),
                device = RingWatch.stringField(o, "device"),
                status = RingWatch.stringField(o, "status"),
                startedAt = RingWatch.stringField(o, "startedAt"),
                endedAt = RingWatch.stringField(o, "endedAt"),
                turns = intField(o, "turns"),
                promoted = boolField(o, "promoted"),
                why = RingWatch.stringField(o, "why"),
                baseline = numField(o, "baseline"),
                result = numField(o, "result"),
                /* Each line is {at, text}; the screen wants the words. */
                lines = objectsInArray(o, "lines").map { l -> RingWatch.stringField(l, "text") },
                recipe = recipeLine(objectField(o, "recipe")),
                validation = objectsInArray(o, "validation").map { p -> intField(p, "turns") to numField(p, "valLoss") },
                bestValLoss = numField(o, "bestValLoss"),
                bestAtTurns = intField(o, "bestAtTurns"),
                args = numField(o, "args"),
                baselineArgs = numField(o, "baselineArgs"),
                collapse = numField(o, "collapse"),
                collapseTool = RingWatch.stringField(o, "collapseTool"),
                unusable = numField(o, "unusable"),
                perTool = objectsInArray(o, "perTool").map { p -> Agree(RingWatch.stringField(p, "tool"), intField(p, "seen"), intField(p, "right"), numField(p, "pct", 0.0), 0.0) },
                scope = objectField(o, "scope")?.let { RingWatch.stringField(it, "key") } ?: "",
                batch = RingWatch.stringField(o, "batch"),
                share = intField(o, "share", 1),
                merge = boolField(o, "merge"),
                mergedInto = RingWatch.stringField(o, "mergedInto"),
                hours = numField(o, "hours", 0.0),
                mode = RingWatch.stringField(o, "mode"),
                lastAt = RingWatch.stringField(o, "lastAt"),
            )
        }
        /* Shares handed out and not registered yet: the machine is fetching its slice. */
        val pending = objectsInArray(json, "pending").map { p ->
            Pending(device = RingWatch.stringField(p, "device"), scope = objectField(p, "scope")?.let { RingWatch.stringField(it, "key") } ?: "base",
                batch = RingWatch.stringField(p, "batch"), share = intField(p, "share", 1), turns = intField(p, "turns"), merge = boolField(p, "merge"), at = RingWatch.stringField(p, "at"))
        }

        val trainers = objectsInArray(json, "trainers").map { o ->
            Trainer(
                name = RingWatch.stringField(o, "name"),
                deviceId = RingWatch.stringField(o, "deviceId"),
                online = boolField(o, "online"),
                able = boolField(o, "able"),
                allowed = boolField(o, "allowed"),
                freeGb = intField(o, "freeGb"),
                home = RingWatch.stringField(o, "home"),
                canSetUp = boolField(o, "canSetUp"),
                missing = RingWatch.stringArrayField(o, "missing"),
                round = objectField(o, "training")?.let(::deviceRound),
                settingUp = boolField(o, "settingUp"),
                setupLine = RingWatch.stringField(o, "setupLine"),
            )
        }

        val resight = objectField(json, "resight")?.let {
            Resight(
                on = boolField(it, "on"),
                accepted = intField(it, "accepted"),
                rejected = intField(it, "rejected"),
                left = intField(it, "left", -1),
                lastWhy = RingWatch.stringField(it, "lastWhy"),
                lastAt = RingWatch.stringField(it, "lastAt"),
            )
        }

        val plan = objectField(json, "plan")?.let { Plan(run = boolField(it, "run"), why = RingWatch.stringField(it, "why"), scope = objectField(it, "scope")?.let { s -> RingWatch.stringField(s, "key") } ?: "") }
        val readiness = objectField(json, "readiness")?.let { r ->
            Readiness(
                ok = boolField(r, "ok"),
                score = intField(r, "score"),
                why = RingWatch.stringField(r, "why"),
                aim = stringsInArray(r, "aim"),
                checks = objectsInArray(r, "checks").map { c ->
                    Check(
                        name = RingWatch.stringField(c, "name"),
                        ok = boolField(c, "ok"),
                        gate = boolField(c, "gate"),
                        value = intField(c, "value"),
                        threshold = intField(c, "threshold"),
                        score = intField(c, "score"),
                        text = RingWatch.stringField(c, "text"),
                    )
                },
            )
        }
        val coverage = objectField(json, "coverage")?.let { c ->
            Coverage(
                total = intField(c, "total"),
                sighted = intField(c, "sighted"),
                perTool = objectsInArray(c, "perTool").map { t ->
                    ToolRow(tool = RingWatch.stringField(t, "tool"), all = intField(t, "all"), sighted = intField(t, "sighted"), gold = intField(t, "gold"))
                },
            )
        }

        val student = objectField(json, "student")?.let { s ->
            val sh = objectField(s, "shadow")
            val agreeRows = { name: String -> objectsInArray(sh ?: "", name).map { a -> Agree(RingWatch.stringField(a, "name"), intField(a, "seen"), intField(a, "agree"), numField(a, "pct", 0.0), numField(a, "argsPct", 0.0)) } }
            val driven = sh?.let { objectField(it, "driven") }
            Student(
                mode = RingWatch.stringField(s, "mode").ifBlank { "off" },
                model = RingWatch.stringField(s, "model"),
                share = intField(s, "share", 10),
                reachable = if (keyPresent(s, "reachable") && !s.contains("\"reachable\":null")) boolField(s, "reachable") else null,
                hasModel = boolField(s, "hasModel"),
                models = stringsInArray(s, "models"),
                seen = if (sh != null) intField(sh, "seen") else 0,
                agreePct = if (sh != null) numField(sh, "agreePct", 0.0) else 0.0,
                argsPct = if (sh != null) numField(sh, "argsPct", 0.0) else 0.0,
                unusablePct = if (sh != null) numField(sh, "unusablePct", 0.0) else 0.0,
                perTool = agreeRows("perTool"),
                perRole = agreeRows("perRole"),
                recent = objectsInArray(sh ?: "", "recent").map { r -> Shadowed(RingWatch.stringField(r, "at"), RingWatch.stringField(r, "role"), RingWatch.stringField(r, "teacher"), RingWatch.stringField(r, "student"), boolField(r, "agree")) },
                drivenSteps = driven?.let { intField(it, "steps") } ?: 0,
                fallbackPct = driven?.let { numField(it, "fallbackPct", 0.0) } ?: 0.0,
                drivenJobs = driven?.let { intField(it, "jobs") } ?: 0,
                autopilot = if (keyPresent(s, "autopilot")) boolField(s, "autopilot") else true,
                map = stringPairsOf(objectField(s, "map")),
                stages = objectsInArray(s, "stages").map { g ->
                    ModelStage(RingWatch.stringField(g, "key"), RingWatch.stringField(g, "model"), RingWatch.stringField(g, "stage"), RingWatch.stringField(g, "why"),
                        numField(g, "agree", 0.0), numField(g, "good", 0.0), intField(g, "judged"), numField(g, "fallback", 0.0))
                },
            )
        }

        val scopes = objectsInArray(json, "scopes").map { o ->
            val st = objectField(o, "stage")
            Scope(
                level = RingWatch.stringField(o, "level"), name = RingWatch.stringField(o, "name"), key = RingWatch.stringField(o, "key"),
                platform = RingWatch.stringField(o, "platform"), sighted = intField(o, "sighted"), all = intField(o, "all"), exam = intField(o, "exam"), seen = intField(o, "seen"),
                adapter = RingWatch.stringField(o, "adapter"), parentAdapter = RingWatch.stringField(o, "parentAdapter"), model = RingWatch.stringField(o, "model"),
                stage = st?.let { RingWatch.stringField(it, "stage") } ?: "", stageWhy = st?.let { RingWatch.stringField(it, "why") } ?: "",
            )
        }
        val practice = objectField(json, "practice")?.let { p ->
            val cur = objectField(p, "current")
            Practice(
                on = boolField(p, "on"), stoppedBecause = RingWatch.stringField(p, "stoppedBecause"),
                currentRole = cur?.let { RingWatch.stringField(it, "role") } ?: "", currentPrompt = cur?.let { RingWatch.stringField(it, "prompt") } ?: "",
                currentProfile = cur?.let { RingWatch.stringField(it, "profile") } ?: "", currentJob = cur?.let { RingWatch.stringField(it, "jobId") } ?: "",
                queued = intField(p, "queued"), lastHour = intField(p, "lastHour"), capPerHour = intField(p, "capPerHour", 6),
                history = objectsInArray(p, "history").map { h -> Practiced(RingWatch.stringField(h, "at"), RingWatch.stringField(h, "role"), RingWatch.stringField(h, "platform"), RingWatch.stringField(h, "profile"), RingWatch.stringField(h, "prompt"), RingWatch.stringField(h, "jobId")) },
                logins = objectsInArray(p, "logins").map { l -> Login(RingWatch.stringField(l, "profile"), RingWatch.stringField(l, "platform")) },
                autoAct = boolField(p, "autoAct"),
            )
        }
        val platformMap = objectField(json, "platformMap")?.let { m -> objectsInArray(m, "platforms").map { p -> PlatformPages(RingWatch.stringField(p, "name"), intField(p, "turns"), intField(p, "pages")) } } ?: emptyList()

        val rental = { o: String? -> o?.let { r ->
            Rental(
                id = RingWatch.stringField(r, "id"), gpuType = RingWatch.stringField(r, "gpuType"), since = RingWatch.stringField(r, "since"),
                costPerHr = numField(r, "costPerHr"), costSoFar = numField(r, "costSoFar"), tag = RingWatch.stringField(r, "tag"),
                notes = objectsInArray(r, "notes").map { n -> RingWatch.stringField(n, "text") },
                endedAt = RingWatch.stringField(r, "endedAt"), why = RingWatch.stringField(r, "why"),
                hours = numField(r, "hours"), cost = numField(r, "cost"),
            )
        } }
        val gpu = objectField(json, "gpu")?.let { g ->
            Gpu(
                trainOn = RingWatch.stringField(g, "trainOn").ifBlank { "laptop" },
                trainHours = intField(g, "trainHours", 12),
                trainShare = RingWatch.stringField(g, "trainShare").ifBlank { "time" },
                machines = intField(g, "machines", 1),
                provider = RingWatch.stringField(g, "provider"),
                keySet = boolField(g, "keySet"),
                keyHint = RingWatch.stringField(g, "keyHint"),
                gpuType = RingWatch.stringField(g, "gpuType"),
                cloud = RingWatch.stringField(g, "cloud"),
                maxHours = numField(g, "maxHours", 2.0),
                hub = RingWatch.stringField(g, "hub"),
                types = stringsInArray(g, "types"),
                pod = rental(objectField(g, "pod")),
                last = rental(objectField(g, "last")),
            )
        }

        val judge = objectField(json, "judge")?.let { j ->
            Judge(on = boolField(j, "on"), runs = intField(j, "runs"), steps = intField(j, "steps"), wrong = intField(j, "wrong"), reasons = intField(j, "reasons"),
                calls = intField(j, "calls"), left = intField(j, "left", -1), lastWhy = RingWatch.stringField(j, "lastWhy"))
        }

        return View(corpus, dataset, serving, rounds, trainers, byDeviceOf(objectField(json, "byDevice")),
            auto = boolField(json, "auto"), covered = intField(json, "covered"), attempted = intField(json, "attempted"), sizing = sizingOf(objectField(json, "sizing")), nodes = nodesOf(objectField(json, "nodes")), resight = resight,
            plan = plan, readiness = readiness, coverage = coverage, student = student, gpu = gpu, judge = judge,
            scopes = scopes, practice = practice, platformMap = platformMap, pending = pending,
            students = studentsOf(objectField(json, "students")))
    }

    /** The next batch for the owner's settings: hours and turns each, the batch, the epochs, the speed it was cut for. */
    data class Sizing(val mode: String = "time", val share: Int = 1, val hours: Double = 0.0, val hoursEach: Double = 0.0, val turnsEach: Int = 0, val batchTurns: Int = 0, val epochs: Int = 3, val secPerTurn: Double = 90.0)
    private fun sizingOf(o: String?): Sizing? = o?.let {
        Sizing(mode = RingWatch.stringField(it, "mode").ifBlank { "time" }, share = intField(it, "share", 1), hours = numField(it, "hours", 0.0), hoursEach = numField(it, "hoursEach", 0.0),
            turnsEach = intField(it, "turnsEach"), batchTurns = intField(it, "batchTurns"), epochs = intField(it, "epochs", 3), secPerTurn = numField(it, "secPerTurn", 90.0))
    }

    /** A GPU node joined to the hub: its kind, name, the line that runs it, whether it is online. */
    data class NodeJoin(val code: String = "", val kind: String = "gpu", val name: String = "", val deviceId: String = "", val line: String = "", val url: String = "", val online: Boolean = false, val gpu: String = "", val uses: Int = 0, val expired: Boolean = false, val at: String = "")
    /** Modal: whether the hub has the client and the token, the GPU, the auto switch, and what happened last. */
    data class ModalState(val ready: Boolean = false, val configured: Boolean = false, val tokenHint: String = "", val gpu: String = "T4", val auto: Boolean = false, val online: Boolean = false, val starting: String = "", val lastStart: String = "", val lastError: String = "", val app: String = "")
    data class Nodes(val joins: List<NodeJoin> = emptyList(), val modal: ModalState? = null)
    private fun nodesOf(o: String?): Nodes? = o?.let {
        Nodes(
            joins = objectsInArray(it, "joins").map { j -> NodeJoin(code = RingWatch.stringField(j, "code"), kind = RingWatch.stringField(j, "kind").ifBlank { "gpu" }, name = RingWatch.stringField(j, "name"), deviceId = RingWatch.stringField(j, "deviceId"), line = RingWatch.stringField(j, "line"), url = RingWatch.stringField(j, "url"), online = boolField(j, "online"), gpu = RingWatch.stringField(j, "gpu"), uses = intField(j, "uses"), expired = boolField(j, "expired"), at = RingWatch.stringField(j, "at")) },
            modal = objectField(it, "modal")?.let { m -> ModalState(ready = boolField(m, "ready"), configured = boolField(m, "configured"), tokenHint = RingWatch.stringField(m, "tokenHint"), gpu = RingWatch.stringField(m, "gpu").ifBlank { "T4" }, auto = boolField(m, "auto"), online = boolField(m, "online"), starting = RingWatch.stringField(m, "starting"), lastStart = RingWatch.stringField(m, "lastStart"), lastError = RingWatch.stringField(m, "lastError"), app = RingWatch.stringField(m, "app")) },
        )
    }

    /**
     * A CANDIDATE STUDENT AND WHAT IT SCORED BARE.
     *
     * Every candidate sits the same paper the rounds are scored on, with no adapter, so the
     * numbers are comparable to each other and to the start of every round. `trial` is null until
     * one has been run, which is not a zero: never seen is not the same as scored nothing.
     */
    data class Trial(val round: String = "", val at: String = "", val status: String = "", val paper: String = "",
                     val turns: Int = 0, val agreement: Double = -1.0, val args: Double = -1.0,
                     val unusable: Double = -1.0, val collapse: Double = -1.0, val collapseTool: String = "",
                     val why: String = "", val running: Boolean = false)
    data class Candidate(val id: String = "", val name: String = "", val params: String = "", val why: String = "",
                         val trial: Trial? = null, val queued: Boolean = false)
    data class Students(val candidates: List<Candidate> = emptyList(), val queue: List<String> = emptyList(),
                        val leaderId: String = "", val leaderName: String = "", val leader: Double = -1.0,
                        val running: Boolean = false)
    private fun studentsOf(o: String?): Students? = o?.let {
        val lead = objectField(it, "leader")
        Students(
            candidates = objectsInArray(it, "candidates").map { c ->
                Candidate(
                    id = RingWatch.stringField(c, "id"), name = RingWatch.stringField(c, "name"),
                    params = RingWatch.stringField(c, "params"), why = RingWatch.stringField(c, "why"),
                    queued = boolField(c, "queued"),
                    trial = objectField(c, "trial")?.let { r ->
                        Trial(round = RingWatch.stringField(r, "round"), at = RingWatch.stringField(r, "at"),
                            status = RingWatch.stringField(r, "status"), paper = RingWatch.stringField(r, "paper"),
                            turns = intField(r, "turns"), agreement = numField(r, "agreement", -1.0),
                            args = numField(r, "args", -1.0), unusable = numField(r, "unusable", -1.0),
                            collapse = numField(r, "collapse", -1.0), collapseTool = RingWatch.stringField(r, "collapseTool"),
                            why = RingWatch.stringField(r, "why"), running = boolField(r, "running"))
                    },
                )
            },
            queue = stringsInArray(it, "queue"),
            leaderId = lead?.let { l -> RingWatch.stringField(l, "id") } ?: "",
            leaderName = lead?.let { l -> RingWatch.stringField(l, "name") } ?: "",
            leader = lead?.let { l -> numField(l, "agreement", -1.0) } ?: -1.0,
            running = boolField(it, "running"),
        )
    }

    /**
     * ONE MEASURED ROUND, READY TO BE SET BESIDE ANY OTHER.
     *
     * The model is a FIELD, not a filter: a Qwen3 round and a Qwen2.5 round are the same shape and
     * belong in the same table. `start` is null for a trial, which never had one - and null is not
     * zero, because never measured and scored nothing are different things.
     */
    data class ToolScore(val tool: String = "", val seen: Int = 0, val before: Double = -1.0, val after: Double = -1.0, val change: Double = -999.0)
    data class Result(
        val id: String = "", val at: String = "", val model: String = "", val wore: String = "",
        val scope: String = "base", val trial: Boolean = false, val device: String = "",
        val turns: Int = 0, val epochs: Double = -1.0, val lr: Double = -1.0, val answerTokens: Int = 0,
        val start: Double = -1.0, val after: Double = -1.0, val change: Double = -999.0,
        val args: Double = -1.0, val unusable: Double = -1.0,
        val collapse: Double = -1.0, val collapseTool: String = "", val distinct: Int = -1,
        val verdict: String = "", val why: String = "",
        val perTool: List<ToolScore> = emptyList(),
    ) {
        /** The model without its owner, for a column heading. */
        val shortModel: String get() = model.substringAfterLast('/')
    }
    data class Results(
        val rounds: List<Result> = emptyList(),
        val tools: List<String> = emptyList(),
        val models: List<String> = emptyList(),
        val servingId: String = "", val servingModel: String = "", val serving: Double = -1.0,
        val error: String = "",
    )

    fun parseResults(json: String): Results {
        if (json.isBlank()) return Results(error = "nothing came back")
        /*
         * FIRST: a hub that has never heard of this answers with its own error and no `rounds`
         * field at all - not an empty one. Passing that error through verbatim ("Cannot GET
         * /v1/training/results") is true and useless; an empty list is the different, real answer
         * that nothing has been measured, and the two must not read the same on screen.
         */
        if (!json.contains("\"rounds\"")) return Results(error = "This browser is newer than the cluster it is talking to — update the cluster to see the results.")
        val err = RingWatch.stringField(json, "error")
        if (err.isNotBlank() && objectField(json, "serving") == null && objectsInArray(json, "rounds").isEmpty()) return Results(error = err)
        val serving = objectField(json, "serving")
        return Results(
            rounds = objectsInArray(json, "rounds").map { r ->
                Result(
                    id = RingWatch.stringField(r, "id"), at = RingWatch.stringField(r, "at"),
                    model = RingWatch.stringField(r, "model"), wore = RingWatch.stringField(r, "wore"),
                    scope = RingWatch.stringField(r, "scope").ifBlank { "base" },
                    trial = boolField(r, "trial"), device = RingWatch.stringField(r, "device"),
                    turns = intField(r, "turns"), epochs = numField(r, "epochs", -1.0), lr = numField(r, "lr", -1.0),
                    answerTokens = intField(r, "answerTokens"),
                    start = numField(r, "start", -1.0), after = numField(r, "after", -1.0), change = numField(r, "change", -999.0),
                    args = numField(r, "args", -1.0), unusable = numField(r, "unusable", -1.0),
                    collapse = numField(r, "collapse", -1.0), collapseTool = RingWatch.stringField(r, "collapseTool"),
                    distinct = intField(r, "distinct", -1),
                    verdict = RingWatch.stringField(r, "verdict"), why = RingWatch.stringField(r, "why"),
                    perTool = objectsInArray(r, "perTool").map { p ->
                        ToolScore(tool = RingWatch.stringField(p, "tool"), seen = intField(p, "seen"),
                            before = numField(p, "before", -1.0), after = numField(p, "after", -1.0),
                            change = numField(p, "change", -999.0))
                    },
                )
            },
            tools = objectsInArray(json, "tools").map { RingWatch.stringField(it, "tool") },
            models = stringsInArray(json, "models"),
            servingId = serving?.let { RingWatch.stringField(it, "id") } ?: "",
            servingModel = serving?.let { RingWatch.stringField(it, "model") } ?: "",
            serving = serving?.let { numField(it, "agreement", -1.0) } ?: -1.0,
        )
    }

    /**
     * SIDE BY SIDE: one step, two answers.
     *
     * `same` is agreement on the TOOL, which is what the exam scores. The arguments are shown
     * because they are where the interesting disagreements live - two models can both say
     * `scroll` and mean different distances. `raw` carries what the model actually said when it
     * was not a tool call at all, which is how a truncated `finish` was found.
     */
    data class CompareStep(
        val n: Int = 0,
        val teacherTool: String = "", val teacherArgs: String = "",
        val modelTool: String = "", val modelArgs: String = "",
        val raw: String = "", val same: Boolean = false, val seconds: Double = 0.0,
    )

    /** A recorded job that can be replayed: the longest trails show the most. */
    data class CompareJob(val jobId: String = "", val role: String = "", val platform: String = "", val goal: String = "", val turns: Int = 0)

    /** One comparison, recorded or live, as it fills in. */
    data class CompareRun(
        val id: String = "", val mode: String = "recorded", val model: String = "", val jobId: String = "",
        val role: String = "", val goal: String = "", val total: Int = 0,
        val steps: List<CompareStep> = emptyList(),
        val done: Boolean = false, val same: Int = 0, val different: Int = 0, val error: String = "",
    ) {
        val agreement: Double get() = if (steps.isEmpty()) -1.0 else (same * 1000.0 / steps.size).toInt() / 10.0
    }

    /** What the comparison screen may offer: the jobs, and the models that can answer. */
    data class CompareOffer(val jobs: List<CompareJob> = emptyList(), val models: List<String> = emptyList(), val serving: List<String> = emptyList(), val error: String = "")

    fun parseCompareOffer(json: String): CompareOffer {
        if (json.isBlank()) return CompareOffer(error = "nothing came back")
        if (!json.contains("\"jobs\"")) return CompareOffer(error = "This browser is newer than the cluster it is talking to — update the cluster to compare.")
        return CompareOffer(
            jobs = objectsInArray(json, "jobs").map { j ->
                CompareJob(jobId = RingWatch.stringField(j, "jobId"), role = RingWatch.stringField(j, "role"),
                    platform = RingWatch.stringField(j, "platform"), goal = RingWatch.stringField(j, "goal"),
                    turns = intField(j, "turns"))
            },
            models = stringsInArray(json, "models"),
            serving = stringsInArray(json, "serving"),
        )
    }

    fun parseCompareRun(json: String): CompareRun {
        if (json.isBlank()) return CompareRun(error = "nothing came back")
        val err = RingWatch.stringField(json, "error")
        if (err.isNotBlank() && !json.contains("\"steps\"")) return CompareRun(error = err)
        return CompareRun(
            id = RingWatch.stringField(json, "id"),
            mode = RingWatch.stringField(json, "mode").ifBlank { "recorded" },
            model = RingWatch.stringField(json, "model"),
            jobId = RingWatch.stringField(json, "jobId"),
            role = RingWatch.stringField(json, "role"),
            goal = RingWatch.stringField(json, "goal"),
            total = intField(json, "total"),
            done = boolField(json, "done"),
            same = intField(json, "same"),
            different = intField(json, "different"),
            error = err,
            steps = objectsInArray(json, "steps").map { s ->
                CompareStep(
                    n = intField(s, "n"),
                    teacherTool = RingWatch.stringField(s, "teacherTool"), teacherArgs = RingWatch.stringField(s, "teacherArgs"),
                    modelTool = RingWatch.stringField(s, "modelTool"), modelArgs = RingWatch.stringField(s, "modelArgs"),
                    raw = RingWatch.stringField(s, "raw"), same = boolField(s, "same"),
                    seconds = numField(s, "seconds", 0.0),
                )
            },
        )
    }

    /** A share handed to a machine that has not registered its round yet. */
    data class Pending(val device: String = "", val scope: String = "base", val batch: String = "", val share: Int = 1, val turns: Int = 0, val merge: Boolean = false, val at: String = "")

    /** Where a round is, read off its last lines: the phase, how far into it (0..1, or -1), and the detail. */
    data class Stage(val phase: String, val fraction: Float, val detail: String)

    fun stageOf(r: Round): Stage {
        val lines = r.lines
        if (r.status == "done") return Stage("done", 1f, if (r.result >= 0) "${pct(r.result)} against ${pct(r.baseline)}" else "measured")
        if (r.status == "failed") return Stage("failed", -1f, r.why.take(80))
        if (r.status == "stopped") return Stage("stopped", -1f, r.why.take(80))
        val exam = Regex("(\\d+)/(\\d+)\\s+agreement\\s+([0-9.]+)%")
        val train = Regex("(\\d+)/(\\d+) turn-passes.*?loss ([0-9.]+).*?(\\d+) min in, about (\\d+) min left")
        val stepOf = Regex("step (\\d+)/(\\d+)")
        /* Past training: the final validation pass, then the exam. Nothing after "trained on" is training. */
        val trained = lines.any { it.startsWith("trained on") }
        for (i in lines.indices.reversed()) {
            val l = lines[i]
            if (l.contains("adapter handed to the hub")) return Stage("uploaded", 1f, "adapter on the hub")
            if (l.startsWith("after:")) return Stage("measured", 1f, l.removePrefix("after: ").take(60))
            if (l.contains("measuring the trained model") || l.startsWith("the other share") || (trained && l.startsWith("before:"))) return Stage("final exam", 0f, "scoring the trained adapter on the same turns")
            if (l.startsWith("merged ")) return Stage("merging", 0.5f, "averaging the shares")
            if (l.startsWith("trained on") || l.startsWith("final check") || l.startsWith("keeping the checkpoint")) return Stage("final check", -1f, l.take(70))
            if (trained && (l.startsWith("check ") || train.containsMatchIn(l))) return Stage("final check", -1f, "validation pass on the held-out turns, then the exam")
            train.find(l)?.let { m ->
                /* A schedule shortened to the hours reads "step 3/3": that is the whole of it, not 3 of 12. */
                val passes = m.groupValues[1].toFloat() / maxOf(1f, m.groupValues[2].toFloat())
                val st = stepOf.find(l)
                val steps = st?.let { s -> s.groupValues[1].toFloat() / maxOf(1f, s.groupValues[2].toFloat()) } ?: 0f
                val short = st?.let { s -> s.groupValues[2].toInt() < 4 } ?: false
                return Stage("training", if (short) maxOf(passes, steps) else passes,
                    "${m.groupValues[1]} of ${m.groupValues[2]} turn-passes" + (st?.let { s -> " · step ${s.groupValues[1]} of ${s.groupValues[2]}" } ?: "") + " · loss ${m.groupValues[3]} · ${m.groupValues[5]} min left")
            }
            if (l.startsWith("check ") && l.contains("validation")) return Stage("training", -1f, l.take(60))
            if (l.startsWith("before:")) return Stage("training", 0f, "starting to train")
            exam.find(l)?.let { m -> return Stage(if (lines.any { it.contains("measuring the trained model") }) "final exam" else "baseline exam", m.groupValues[1].toFloat() / maxOf(1f, m.groupValues[2].toFloat()), "${m.groupValues[1]} of ${m.groupValues[2]} turns · ${m.groupValues[3]}% agree") }
            if (l.contains("measuring in a separate process")) return Stage(if (trained) "final exam" else "baseline exam", 0f, if (trained) "scoring the trained adapter on the same turns" else "scoring the start")
        }
        return Stage("starting", 0f, lines.lastOrNull()?.take(60) ?: "fetching the slice")
    }

    /** The order of the chain, for the stage strip. */
    val CHAIN = listOf("baseline exam", "training", "final check", "final exam", "uploaded", "merging", "measured", "serving")

    /** 'platform:facebook' → 'facebook (platform)'; 'base' → 'base'. */
    fun scopeLabel(key: String): String {
        val k = key.trim()
        if (k.isBlank() || k == "base") return "base"
        val i = k.indexOf(':')
        return if (i < 0) k else "${k.substring(i + 1)} (${k.substring(0, i)})"
    }

    /** The one line under the practice switch. */
    fun practiceLine(p: Practice): String = when {
        p.autoAct -> "will not run — automatic acting is on; practice needs the act gate to hold outward steps"
        p.on && p.currentRole.isNotBlank() -> "on — ${p.currentRole} in ${p.currentProfile}: ${p.currentPrompt.take(70)}"
        p.on && p.logins.isEmpty() -> "on — no profile holds a login yet, nothing to practise on"
        p.on -> "on — ${p.lastHour} of ${p.capPerHour} runs this hour, ${p.queued} task(s) queued, ${p.logins.size} signed-in platform(s)"
        p.stoppedBecause.isNotBlank() -> "off — ${p.stoppedBecause}"
        else -> "off — a thin role does its own job in its platform's signed-in profile, one walk at a time"
    }

    /** {"a":"x","b":"y"} → [(a, x), (b, y)]. */
    internal fun stringPairsOf(obj: String?): List<Pair<String, String>> {
        if (obj == null) return emptyList()
        val re = Regex("\"([^\"]+)\"\\s*:\\s*\"([^\"]*)\"")
        return re.findAll(obj).map { it.groupValues[1] to it.groupValues[2] }.toList()
    }

    /** The one line under the judge switch. */
    fun judgeLine(j: Judge): String = when {
        j.on && j.left < 0 -> "on — counting the runs to judge"
        j.on -> "on — ${j.runs} run(s) judged, ${j.steps} steps, ${j.wrong} called wrong, ${j.reasons} reasons written, ${j.left} to go"
        j.runs == 0 -> "off — the teacher reads each sighted run once and grades every step (one model call per run)"
        else -> "off — ${j.runs} run(s) judged, ${j.steps} steps, ${j.wrong} called wrong" + (if (j.lastWhy.isNotBlank()) " — ${j.lastWhy}" else "")
    }

    /** GET /v1/training/runs → the rows of the runs browser. */
    fun parseRuns(json: String): List<RunRow> = objectsInArray(json, "runs").map { o ->
        RunRow(
            id = RingWatch.stringField(o, "id"), goal = RingWatch.stringField(o, "goal"), role = RingWatch.stringField(o, "role"),
            profile = RingWatch.stringField(o, "profile"), status = RingWatch.stringField(o, "status"), createdAt = RingWatch.stringField(o, "createdAt"),
            tier = RingWatch.stringField(o, "tier"), grade = RingWatch.stringField(o, "grade"),
            calls = intField(o, "calls"), sighted = intField(o, "sighted"), judged = intField(o, "judged"), human = intField(o, "human"), wrong = intField(o, "wrong"),
            tools = stringsInArray(o, "tools"),
        )
    }

    /** GET /v1/training/runs/:id → one run with its steps and every verdict. */
    fun parseRun(json: String): RunDetail? {
        val s = json.trim()
        if (!s.startsWith("{") || RingWatch.stringField(s, "error").isNotBlank()) return null
        return RunDetail(
            id = RingWatch.stringField(s, "id"), goal = RingWatch.stringField(s, "goal"), role = RingWatch.stringField(s, "role"),
            profile = RingWatch.stringField(s, "profile"), status = RingWatch.stringField(s, "status"), createdAt = RingWatch.stringField(s, "createdAt"),
            report = RingWatch.stringField(s, "report"), tier = RingWatch.stringField(s, "tier"), why = stringsInArray(s, "why"),
            steps = objectsInArray(s, "steps").map { st ->
                val j = objectField(st, "judged"); val h = objectField(st, "human")
                RunStep(
                    n = intField(st, "n"), kind = RingWatch.stringField(st, "kind"), text = RingWatch.stringField(st, "text"),
                    tool = RingWatch.stringField(st, "tool"), args = RingWatch.stringField(st, "args"), content = RingWatch.stringField(st, "content"),
                    marks = intField(st, "marks"),
                    judgedVerdict = j?.let { RingWatch.stringField(it, "verdict") } ?: "", judgedWhy = j?.let { RingWatch.stringField(it, "why") } ?: "",
                    reason = j?.let { RingWatch.stringField(it, "reason") } ?: "", humanVerdict = h?.let { RingWatch.stringField(it, "verdict") } ?: "",
                    resighted = boolField(st, "resighted"),
                )
            },
        )
    }

    /** The one line under the flow switch. */
    fun gpuLine(g: Gpu): String = when {
        g.trainOn != "gpu" && g.machines > 1 -> "${g.machines} laptops share each ${g.trainHours} h batch — ${if (g.trainShare == "work") "each runs the full ${g.trainHours} h on its own share" else "${trim(g.trainHours.toDouble() / g.machines)} h each"}, then the adapters are averaged"
        g.trainOn != "gpu" -> "rounds run on the laptops that offered, ${g.trainHours} h each — a second laptop joins the same batch when it connects"
        !g.keySet -> "GPU flow chosen — paste a RunPod API key below and rounds will rent a card"
        g.pod != null -> "renting ${g.pod.gpuType.ifBlank { g.gpuType }} since ${g.pod.since.take(16).replace('T', ' ')}" +
            (if (g.pod.costSoFar >= 0) " · about $${trimMoney(g.pod.costSoFar)} so far" else "")
        g.last != null -> "ready — last card ran ${trim(g.last.hours)} h for $${trimMoney(g.last.cost)} (${g.last.why})"
        else -> "ready — the next round rents a ${g.gpuType} for up to ${trim(g.maxHours)} h"
    }

    /** trim(), for a screen that edits the number back. */
    fun trimPublic(v: Double): String = trim(v)

    private fun trimMoney(v: Double): String { if (v < 0) return "—"; val c = kotlin.math.round(v * 100).toLong(); return "${c / 100}.${(c % 100).toString().padStart(2, '0')}" }

    /** The one line under the serving mode: what the student is doing, in words. */
    fun studentLine(s: Student): String = when {
        s.reachable == false -> "the model server in the pod is not answering"
        s.model.isBlank() -> "no trained model chosen yet — the teacher answers everything"
        !s.hasModel -> "${s.model} is not on the model server yet"
        s.mode == "off" -> "off — ${s.model} is loaded but never asked"
        s.mode == "shadow" -> "shadow — the teacher drives; ${s.model} answers beside it on every step (${s.seen} so far, ${trim(s.agreePct)}% agree)"
        s.mode == "canary" -> "canary — ${s.model} drives ${s.share}% of the jobs, the teacher the rest (${s.drivenSteps} steps driven, ${trim(s.fallbackPct)}% handed back)"
        else -> "primary — ${s.model} drives every job; the teacher only steps in (${s.drivenSteps} steps, ${trim(s.fallbackPct)}% handed back)"
    }

    /**
     * The line under the title. The planner's own reason when the cluster sends it - it is the
     * sentence that decides whether a round starts, so it is the one to show - and the older
     * corpus rule only when it does not.
     */
    fun headline(v: View): String {
        val p = v.plan ?: return readiness(v.corpus)
        val r = v.readiness
        val score = if (r != null) " · ready ${r.score}%" else ""
        return (if (p.run) "ready — " else "waiting — ") + p.why + score
    }

    /** The one line under the re-sight switch: what it has done, what is left, why it stopped. */
    fun resightLine(r: Resight): String = when {
        r.on && r.left < 0 -> "on — counting the blind reads"
        r.on -> "on — ${r.accepted} recovered, ${r.rejected} stayed blind, ${r.left} to go"
        r.accepted + r.rejected == 0 -> "off — re-opens the pages the old runs read; no model credit spent"
        else -> "off — ${r.accepted} recovered, ${r.rejected} stayed blind" +
            (if (r.left > 0) ", ${r.left} to go" else "") +
            (if (r.lastWhy.isNotBlank() && r.left == 0) " — ${r.lastWhy}" else "")
    }

    /**
     * The collection loop's own state, read from its own endpoint.
     *
     * Separate from parse() because it is a separate call: the training page reads two things and
     * a build talking to an older cluster gets one of them. Merging them into one parser would mean
     * a missing harvest block read as "off", which is a confident wrong answer.
     */
    fun parseHarvest(json: String): Harvest? {
        val s = json.trim()
        if (!s.startsWith("{")) return null
        if (keyPresent(s, "capPerHour").not()) return null
        return Harvest(
            on = boolField(s, "on"),
            queued = intField(s, "queued"),
            next = RingWatch.stringField(s, "next"),
            inLastHour = intField(s, "inLastHour"),
            capPerHour = intField(s, "capPerHour"),
            collected = intField(s, "collected"),
            aiming = stringsInArray(s, "aiming"),
            stoppedBecause = RingWatch.stringField(s, "stoppedBecause"),
            why = objectField(s, "plan")?.let { RingWatch.stringField(it, "why") } ?: "",
            waiting = objectField(s, "plan")?.let { !boolField(it, "run") } ?: false,
            keysUsable = objectField(s, "keys")?.let { intField(it, "usable") } ?: -1,
            keysTotal = objectField(s, "keys")?.let { intField(it, "total") } ?: -1,
            runs = objectsInArray(s, "runs").map { o ->
                Collected(
                    at = RingWatch.stringField(o, "at"),
                    prompt = RingWatch.stringField(o, "prompt"),
                    jobId = RingWatch.stringField(o, "jobId"),
                    state = RingWatch.stringField(o, "state"),
                    grade = RingWatch.stringField(o, "grade"),
                    calls = intField(o, "calls"),
                    tools = stringsInArray(o, "tools"),
                    why = RingWatch.stringField(o, "why"),
                )
            },
            tally = pairsOf(objectField(s, "tally")),
            walks = objectsInArray(s, "walks").map { w ->
                Walk(
                    jobId = RingWatch.stringField(w, "jobId"),
                    profile = RingWatch.stringField(w, "profile"),
                    goal = RingWatch.stringField(w, "goal"),
                    steps = intField(w, "steps"),
                    since = RingWatch.stringField(w, "since"),
                    last = RingWatch.stringField(w, "last"),
                )
            },
        )
    }

    /** One line for the card, and it must never read as progress when nothing is queued. */
    fun harvestLine(h: Harvest?): String = when {
        h == null -> ""
        h.stoppedBecause.isNotBlank() -> "stopped — ${h.stoppedBecause}"
        !h.on -> if (h.collected > 0) "off — ${h.collected} collected so far" else "off"
        /* On, but not running anything: the allowance is spent, or every profile is taken, or the
           hour's cap is reached. The reason is the line, because "on" with nothing moving reads as
           broken. */
        h.keysTotal > 0 && h.keysUsable == 0 -> "on, waiting — the model allowance is spent (0 of ${h.keysTotal} keys usable); resumes by itself"
        h.waiting && h.queued > 0 && h.why.isNotBlank() -> "on, waiting — ${h.why}"
        h.queued == 0 -> "on — asking for the next prompts"
        else -> "on — ${h.queued} queued, ${h.inLastHour} of ${h.capPerHour} run this hour"
    }

    private fun deviceRound(o: String) = DeviceRound(
        roundId = RingWatch.stringField(o, "roundId"),
        status = RingWatch.stringField(o, "status"),
        stale = boolField(o, "stale"),
        silentForMin = intField(o, "silentForMin", missing = -1),
        turns = intField(o, "turns"),
        last = objectField(o, "last")?.let { RingWatch.stringField(it, "text") } ?: "",
        promoted = boolField(o, "promoted"),
        baseline = numField(o, "baseline"),
        result = numField(o, "result"),
    )

    // ── saying it ────────────────────────────────────────────────────────────────────────────────

    /**
     * One line for a device's row in the hub.
     *
     * A device four hours into a round must not read "online, idle" — that invites somebody to close
     * the lid. And a round that has gone silent must not read as progress, because a confident wrong
     * answer is the one thing a status row must never give.
     */
    fun deviceLine(r: DeviceRound?): String = when {
        r == null -> ""
        r.running && r.stale && r.silentForMin >= 0 -> "training — nothing heard for ${r.silentForMin} min"
        r.running && r.last.isNotBlank() -> "training — ${r.last}"
        r.running -> "training — just started"
        r.status == "done" && r.promoted -> "last round: ${pct(r.result)}, in service"
        r.status == "done" && r.baseline >= 0 && r.result >= 0 ->
            "last round: ${pct(r.result)} against ${pct(r.baseline)}" +
                if (r.result > r.baseline) "" else " — not better, not used"
        r.status == "done" -> "last round finished"
        else -> "last round ${r.status}"
    }

    /**
     * Why a machine is or is not going to be given work — the sentence that replaces silence.
     *
     * A machine that simply never gets picked teaches nobody anything. "could train, needs 6 GB on
     * D:" is something a person can act on in a minute.
     */
    fun trainerLine(t: Trainer): String = when {
        !t.online -> "offline"
        t.settingUp -> "setting up — ${t.setupLine.ifBlank { "working" }}"
        t.able && t.allowed -> "ready — ${t.freeGb} GB free"
        t.able && !t.allowed -> "ready, but not switched on for training"
        t.missing.isNotEmpty() -> t.missing.first()
        t.canSetUp -> "can be set up to train"
        else -> "cannot train on this machine"
    }

    /** Whether tonight is worth a machine, in the words somebody would actually use. */
    fun readiness(c: Corpus): String = when {
        c.scanning -> "reading the history — ${c.pending} job(s) still to go"
        c.tiers.judged == 0 -> "nothing judged yet"
        c.enoughForARound -> "ready — ${c.usableSinceLastRound} new usable run(s) since the last round"
        else -> "waiting — ${c.usableSinceLastRound} new usable run(s), a round wants about 200"
    }

    fun pct(v: Double): String = if (v < 0) "—" else "${trim(v)}%"

    /**
     * The recipe as one line a person can compare across rounds. The cluster sends the trainer's
     * own fields; this reads the ones that decide a round and leaves the rest alone, so a trainer
     * that adds a field tomorrow breaks nothing here.
     */
    fun recipeLine(o: String?): String {
        if (o == null) return ""
        val r = intField(o, "loraR")
        val scope = RingWatch.stringField(o, "loraScope")
        val lr = numField(o, "lr")
        val ep = numField(o, "epochs")
        val acc = intField(o, "accum", 1)
        val b = intField(o, "batch", 1)
        val dev = RingWatch.stringField(o, "device")
        val dt = RingWatch.stringField(o, "dtype")
        val bits = mutableListOf<String>()
        if (r > 0) bits += "r$r $scope".trim()
        if (lr > 0) bits += "lr ${sci(lr)}"
        if (ep > 0) bits += "${trim(ep)} epoch${if (ep == 1.0) "" else "s"} × ${b * acc}"
        if (dev.isNotBlank()) bits += "$dev $dt".trim()
        return bits.joinToString(" · ")
    }

    /** 0.0002 → "2e-4": the way a learning rate is written everywhere else. */
    private fun sci(v: Double): String {
        if (v <= 0) return "0"
        var m = v
        var e = 0
        while (m < 1.0) { m *= 10; e-- }
        while (m >= 10.0) { m /= 10; e++ }
        return "${trim(m)}e$e"
    }

    /** Three decimals, for a loss: 1.2345 → "1.235". */
    fun loss(v: Double): String {
        if (v < 0) return "—"
        val r = kotlin.math.round(v * 1000) / 1000.0
        var s = r.toString()
        val dot = s.indexOf('.')
        if (dot < 0) s += ".000" else while (s.length - dot < 4) s += "0"
        return s
    }

    private fun trim(v: Double): String {
        val r = kotlin.math.round(v * 10) / 10.0
        val s = r.toString()
        return if (s.endsWith(".0")) s.dropLast(2) else s
    }

    // ── the bits of JSON reading that RingWatch did not already need ─────────────────────────────

    /** A nested object by name, or null. Null means ABSENT, which is different from empty. */
    internal fun objectField(obj: String, name: String): String? {
        val at = keyAt(obj, name) ?: return null
        var i = at
        while (i < obj.length && obj[i].isWhitespace()) i++
        if (i >= obj.length || obj[i] != '{') return null
        val end = RingWatch.matchingBracket(obj, i, '{', '}')
        return if (end < 0) null else obj.substring(i, end + 1)
    }

    /** Every object inside a named array, in order. */
    internal fun objectsInArray(obj: String, name: String): List<String> {
        val at = keyAt(obj, name) ?: return emptyList()
        var i = at
        while (i < obj.length && obj[i].isWhitespace()) i++
        if (i >= obj.length || obj[i] != '[') return emptyList()
        val end = RingWatch.matchingBracket(obj, i, '[', ']')
        if (end < 0) return emptyList()
        val out = ArrayList<String>()
        var j = i + 1
        while (j < end) {
            when {
                obj[j] == '{' -> {
                    val e = RingWatch.matchingBracket(obj, j, '{', '}')
                    if (e < 0 || e > end) return out
                    out.add(obj.substring(j, e + 1))
                    j = e + 1
                }
                /* Skip strings whole: a goal or a log line inside the array is full of braces. */
                obj[j] == '"' -> j = skipString(obj, j)
                else -> j++
            }
        }
        return out
    }

    /** A flat {name: number} object as pairs — the dropped-turn reasons. */
    internal fun pairsOf(obj: String?): List<Pair<String, Int>> {
        if (obj == null) return emptyList()
        val out = ArrayList<Pair<String, Int>>()
        var i = 1
        while (i < obj.length - 1) {
            if (obj[i] != '"') { i++; continue }
            val close = skipString(obj, i)
            val key = obj.substring(i + 1, close - 1)
            var j = close
            while (j < obj.length && (obj[j].isWhitespace() || obj[j] == ':')) j++
            val start = j
            while (j < obj.length && (obj[j].isDigit() || obj[j] == '-' || obj[j] == '.')) j++
            if (j > start) out.add(key to (obj.substring(start, j).toDoubleOrNull()?.toInt() ?: 0))
            i = if (j > start) j else close
        }
        return out
    }

    private fun tiersOf(obj: String?): Tiers {
        if (obj == null) return Tiers()
        return Tiers(intField(obj, "gold"), intField(obj, "silver"), intField(obj, "bronze"), intField(obj, "void"))
    }

    private fun byDeviceOf(obj: String?): Map<String, DeviceRound> {
        if (obj == null) return emptyMap()
        val out = LinkedHashMap<String, DeviceRound>()
        var i = 1
        while (i < obj.length - 1) {
            if (obj[i] != '"') { i++; continue }
            val close = skipString(obj, i)
            val name = obj.substring(i + 1, close - 1)
            var j = close
            while (j < obj.length && (obj[j].isWhitespace() || obj[j] == ':')) j++
            if (j < obj.length && obj[j] == '{') {
                val e = RingWatch.matchingBracket(obj, j, '{', '}')
                if (e < 0) return out
                out[name] = deviceRound(obj.substring(j, e + 1))
                i = e + 1
            } else i = close
        }
        return out
    }

    /** Whether a key exists at all, which is how an older cluster's reply is told from an off switch. */
    internal fun keyPresent(obj: String, name: String): Boolean = obj.contains("\"" + name + "\"")

    /**
     * A flat array of strings, for the list of gaps it is going after.
     *
     * Walks the same way objectsInArray does - bracket-matched, strings skipped whole - because a
     * prompt inside the array is full of punctuation and a naive split would tear one in half.
     */
    internal fun stringsInArray(obj: String, name: String): List<String> {
        val at = keyAt(obj, name) ?: return emptyList()
        var i = at
        while (i < obj.length && obj[i].isWhitespace()) i++
        if (i >= obj.length || obj[i] != '[') return emptyList()
        val end = RingWatch.matchingBracket(obj, i, '[', ']')
        if (end < 0) return emptyList()
        val out = ArrayList<String>()
        var j = i + 1
        while (j < end) {
            if (obj[j] == '"') {
                val e = skipString(obj, j)
                if (e <= j) break
                out.add(obj.substring(j + 1, e - 1))
                j = e
            } else j++
        }
        return out
    }

    internal fun numField(obj: String, name: String, missing: Double = -1.0): Double {
        val at = keyAt(obj, name) ?: return missing
        var i = at
        while (i < obj.length && obj[i].isWhitespace()) i++
        val start = i
        while (i < obj.length && (obj[i].isDigit() || obj[i] == '-' || obj[i] == '.' || obj[i] == 'e' || obj[i] == 'E' || obj[i] == '+')) i++
        if (i == start) return missing
        return obj.substring(start, i).toDoubleOrNull() ?: missing
    }

    internal fun intField(obj: String, name: String, missing: Int = 0): Int {
        val v = numField(obj, name, Double.NaN)
        return if (v.isNaN()) missing else v.toInt()
    }

    internal fun boolField(obj: String, name: String): Boolean {
        val at = keyAt(obj, name) ?: return false
        var i = at
        while (i < obj.length && obj[i].isWhitespace()) i++
        return obj.startsWith("true", i)
    }

    /**
     * Where a key's VALUE starts, at the top level of this object only.
     *
     * Depth-aware on purpose: `"tiers"` appears inside `corpus` and again inside `dataset`, and a
     * plain indexOf would read the wrong one depending on which happened to come first in the body —
     * a bug that shows up as two plausible numbers swapping places for no visible reason.
     */
    private fun keyAt(obj: String, name: String): Int? {
        val key = "\"$name\""
        var i = 0
        var depth = 0
        while (i < obj.length) {
            val c = obj[i]
            when {
                c == '"' -> {
                    val end = skipString(obj, i)
                    if (depth == 1 && obj.startsWith(key, i)) {
                        var j = end
                        while (j < obj.length && obj[j].isWhitespace()) j++
                        if (j < obj.length && obj[j] == ':') return j + 1
                    }
                    i = end
                    continue
                }
                c == '{' || c == '[' -> depth++
                c == '}' || c == ']' -> depth--
            }
            i++
        }
        return null
    }

    /** Past the closing quote of the string starting at [start], honouring escapes. */
    private fun skipString(s: String, start: Int): Int {
        var i = start + 1
        while (i < s.length) {
            val c = s[i]
            if (c == '\\') { i += 2; continue }
            if (c == '"') return i + 1
            i++
        }
        return i
    }
}
