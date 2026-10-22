package engineer.myapp.gb.shared

/**
 * WHAT A DEVICE DID, IN THE SHAPE THE CLUSTER ALREADY UNDERSTANDS.
 *
 * The device ring exists for the work that cannot be done anywhere else: the sites that need a real
 * login and a residential address, which is the most valuable and least reproducible browsing there
 * is. And until now none of it taught the model anything, because a device run was journalled as
 * prose — `steps: [{ line: "hello" }]` — into a store nothing reads, while the training set is built
 * only from cluster jobs whose steps are `{kind, tool, args, text}`.
 *
 * The information was never missing. [AgentHost.pushToolCall] and [AgentHost.pushToolResult] already
 * carry the call and its observation separately, because the two apps render them differently. They
 * were being drawn on screen and dropped. This records them instead.
 *
 * TWO DETAILS THAT DECIDE WHETHER THE RESULT IS USABLE AT ALL.
 *
 *   THE OBSERVATION MUST HAVE A KIND. The set builder walks a job looking for observation steps and
 *     tool steps in alternation; a result with no kind it recognises is not history, so the turn
 *     after it looks like a decision made having seen nothing, and gets dropped.
 *   A LOOK MUST KEEP ITS NUMBERED LIST. This is the whole reason 2,987 click and type turns were
 *     unlearnable: the list that makes "13" mean something was thrown away. On a device the look's
 *     result IS that list, so it is carried as `marks` exactly as the cluster now does.
 */
object DeviceTrace {

    /** A step in the shape `/profiles/jobs` uses, so everything downstream needs no special case. */
    data class Step(
        val n: Int,
        val kind: String,
        val tool: String = "",
        val args: String = "",
        val text: String = "",
        val marks: String = "",
    )

    /**
     * Which observation kind a tool's result is.
     *
     * The names match the builder's own OBSERVE set. Anything unrecognised becomes `read`, which is
     * the honest generic: something was observed. Returning an unknown kind instead would make the
     * step invisible to the builder and quietly cost the turn that follows it.
     */
    fun kindFor(tool: String): String = when (tool.lowercase()) {
        "look" -> "look"
        "read", "read_table", "dig", "content" -> "read"
        "open", "navigate", "current_url" -> "open"
        "click", "click_text", "click_xy", "act" -> "click"
        "scroll" -> "scroll"
        "note" -> "note"
        else -> "read"
    }

    /** How much of a result is kept. Long enough to be evidence, bounded because this goes on disk. */
    const val MAX_TEXT = 1200
    const val MAX_MARKS = 2000

    /**
     * One device run, accumulated as it happens.
     *
     * Not a singleton: a desktop node can be handed a goal while the owner is driving the browser
     * themselves, and two runs sharing one step counter would interleave into a single incoherent
     * history that looks like one agent contradicting itself.
     */
    /*
     * `runId` is the cluster's own job id when the ring HANDED this goal over: the cluster created
     * that job and the master is already polling it, so the run is filed into it rather than as a new
     * job nobody is watching. Empty for a run the owner started here.
     */
    class Run(val goal: String, val role: String = "", val profile: String = "", val runId: String = "") {
        private val steps = mutableListOf<Step>()
        private var n = 0

        init {
            /* The goal is step one, the same as a cluster job. The builder relies on it: a job with
               no goal yields no turns at all. */
            steps.add(Step(++n, "you", text = goal.take(4000)))
        }

        fun tool(name: String, argsJson: String) {
            steps.add(Step(++n, "tool", tool = name, args = argsJson.take(4000)))
        }

        fun observed(tool: String, result: String) {
            val kind = kindFor(tool)
            /* A look's result IS the numbered list, and it is the only thing that makes an index
               learnable. Kept whole rather than summarised, which is the mistake the cluster made
               for months. */
            val marks = if (kind == "look") result.take(MAX_MARKS) else ""
            steps.add(Step(++n, kind, text = result.take(MAX_TEXT), marks = marks))
        }

        /** Anything the device wants on the record that is not a tool: a refusal, a stall, a note. */
        fun note(text: String) {
            steps.add(Step(++n, "note", text = text.take(MAX_TEXT)))
        }

        fun stepCount(): Int = steps.size

        /**
         * The run as the cluster's job-ingest expects it.
         *
         * Hand-built rather than serialised, because commonMain deliberately carries no JSON parser
         * — the same reason RingWatch reads responses at string level.
         */
        fun body(status: String, report: String, deviceName: String): String {
            val end = Step(n + 1, if (status == "idle" || status == "done") "done" else "end", text = report.take(4000))
            val all = steps + end
            val sb = StringBuilder()
            sb.append('{')
            sb.append("\"goal\":").append(q(goal)).append(',')
            sb.append("\"role\":").append(q(role)).append(',')
            sb.append("\"profile\":").append(q(profile)).append(',')
            sb.append("\"status\":").append(q(if (status == "done") "idle" else status)).append(',')
            sb.append("\"report\":").append(q(report)).append(',')
            sb.append("\"deviceName\":").append(q(deviceName)).append(',')
            if (runId.isNotEmpty()) sb.append("\"runId\":").append(q(runId)).append(',')
            sb.append("\"steps\":[")
            all.forEachIndexed { i, s ->
                if (i > 0) sb.append(',')
                sb.append('{')
                sb.append("\"n\":").append(s.n)
                sb.append(",\"kind\":").append(q(s.kind))
                if (s.tool.isNotEmpty()) sb.append(",\"tool\":").append(q(s.tool))
                /* args is already JSON; it goes in raw or the model's own object becomes a string. */
                if (s.args.isNotEmpty()) sb.append(",\"args\":").append(rawObject(s.args))
                if (s.text.isNotEmpty()) sb.append(",\"text\":").append(q(s.text))
                if (s.marks.isNotEmpty()) sb.append(",\"marks\":").append(q(s.marks))
                sb.append('}')
            }
            sb.append("]}")
            return sb.toString()
        }

        /** An args blob that is not a JSON object would break the body; fall back to naming it. */
        private fun rawObject(s: String): String {
            val t = s.trim()
            return if (t.startsWith("{") && t.endsWith("}")) t else "{\"raw\":" + q(t) + "}"
        }
    }

    /** JSON string escaping, enough for goals, reports and page text. */
    internal fun q(s: String): String {
        val sb = StringBuilder("\"")
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (c < ' ') sb.append("\\u").append(c.code.toString(16).padStart(4, '0')) else sb.append(c)
            }
        }
        return sb.append('"').toString()
    }
}
