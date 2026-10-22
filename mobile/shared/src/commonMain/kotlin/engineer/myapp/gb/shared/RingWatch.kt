package engineer.myapp.gb.shared

/**
 * ONE POLL, FOR EVERY SURFACE.
 *
 * The phone, the desktop and the web console all need the same answer to "what is the ring working
 * on", and it is the same question whichever of them is asking. Written once here so the three
 * cannot answer it differently — the reason the role, the requirement wording and the device
 * capabilities all live in one place too.
 *
 * Each platform supplies only the two things that genuinely differ: how it reaches the cluster, and
 * what this device is called (so the strip can say "working on your desktop" rather than just
 * "working", which on one UI across two machines means nothing).
 */
object RingWatch {

    /**
     * Read one answer and apply it. Platform-agnostic: it is handed the raw JSON body.
     *
     * Parsed at string level, the same way AgentCore reads model replies, because commonMain
     * deliberately carries no JSON parser — one dependency that would have to be satisfied on
     * android, jvm and wasm alike to render a status line.
     */
    fun apply(json: String, myDeviceName: String) {
        val working = firstWorkingObject(json)
        if (working == null) { RingWork.applyCluster("", "", emptyList(), myDeviceName); return }
        RingWork.applyCluster(
            device = stringField(working, "name"),
            g = stringField(working, "goal"),
            ls = stringArrayField(working, "lines"),
            mine = myDeviceName,
        )
    }

    /** The first entry of `working`, or null when nothing is running anywhere. */
    internal fun firstWorkingObject(json: String): String? {
        val key = "\"working\""
        val at = json.indexOf(key)
        if (at < 0) return null
        val open = json.indexOf('[', at)
        if (open < 0) return null
        val firstBrace = json.indexOf('{', open)
        if (firstBrace < 0) return null
        /* Only within the array: a later object elsewhere in the body is not a working entry. */
        val close = matchingBracket(json, open, '[', ']')
        if (close in 1 until firstBrace) return null
        val end = matchingBracket(json, firstBrace, '{', '}')
        if (end < 0) return null
        return json.substring(firstBrace, end + 1)
    }

    /** Depth-matched, and blind to brackets inside strings — a goal or a log line is full of them. */
    internal fun matchingBracket(s: String, from: Int, open: Char, close: Char): Int {
        var depth = 0
        var i = from
        var inStr = false
        var esc = false
        while (i < s.length) {
            val c = s[i]
            when {
                esc -> esc = false
                c == '\\' && inStr -> esc = true
                c == '"' -> inStr = !inStr
                inStr -> { }
                c == open -> depth++
                c == close -> { depth--; if (depth == 0) return i }
            }
            i++
        }
        return -1
    }

    /** One string field of a flat object, unescaped enough for display. */
    internal fun stringField(obj: String, name: String): String {
        val key = "\"$name\""
        var at = obj.indexOf(key)
        while (at >= 0) {
            var i = at + key.length
            while (i < obj.length && obj[i].isWhitespace()) i++
            if (i < obj.length && obj[i] == ':') {
                i++
                while (i < obj.length && obj[i].isWhitespace()) i++
                if (i < obj.length && obj[i] == '"') return readString(obj, i).first
                return ""
            }
            at = obj.indexOf(key, at + 1)
        }
        return ""
    }

    /** An array of strings — the log lines. */
    internal fun stringArrayField(obj: String, name: String): List<String> {
        val key = "\"$name\""
        val at = obj.indexOf(key)
        if (at < 0) return emptyList()
        val open = obj.indexOf('[', at)
        if (open < 0) return emptyList()
        val end = matchingBracket(obj, open, '[', ']')
        if (end < 0) return emptyList()
        val out = ArrayList<String>()
        var i = open + 1
        while (i < end) {
            if (obj[i] == '"') { val (s, next) = readString(obj, i); out.add(s); i = next } else i++
        }
        return out
    }

    /** From an opening quote to past the closing one, honouring escapes. */
    private fun readString(s: String, start: Int): Pair<String, Int> {
        val sb = StringBuilder()
        var i = start + 1
        while (i < s.length) {
            val c = s[i]
            if (c == '\\' && i + 1 < s.length) {
                when (val n = s[i + 1]) {
                    'n' -> sb.append('\n'); 't' -> sb.append('\t'); 'r' -> sb.append('\r')
                    'u' -> {
                        if (i + 5 < s.length) {
                            val code = s.substring(i + 2, i + 6).toIntOrNull(16)
                            if (code != null) { sb.append(code.toChar()); i += 6; continue }
                        }
                        sb.append(n)
                    }
                    else -> sb.append(n)
                }
                i += 2
                continue
            }
            if (c == '"') return sb.toString() to (i + 1)
            sb.append(c)
            i++
        }
        return sb.toString() to i
    }
}
