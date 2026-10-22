package engineer.myapp.gb.shared

import androidx.compose.runtime.mutableStateOf

/**
 * WHAT THIS DEVICE IS DOING FOR THE RING — said in two directions at once.
 *
 * A walk handed to a device has no cluster job, and that made it invisible from both sides:
 *
 *   - THE ASSISTANT could not see it. Seen live: the hand-over succeeded, the assistant called
 *     gb_walk_wait with the device's NAME, got "no such job", read the cluster log in a loop, and
 *     then handed the same goal over a second time. The hub has kept a per-device log all along
 *     (POST /v1/device/log) and nothing ever wrote to it.
 *   - THE PERSON AT THE DEVICE could not see it either, and that is the worse of the two: their own
 *     machine moving on its own with nothing on screen to say why.
 *
 * One call reports in both directions, so they cannot drift. Shared, because the phone and the
 * desktop are both nodes and both needed exactly this — the phone's version of "invisible while it
 * works" is the same bug as the desktop's.
 */
object RingWork {
    /**
     * Where a line goes besides the screen: the platform sets this to post to /v1/device/log. Left
     * unset it is simply a UI log, which is what a device that is not connected should be.
     */
    var upstream: ((String) -> Unit)? = null

    /** The goal the ring handed over, while one is being worked. */
    val goal = mutableStateOf("")

    /** Recent lines, newest last. Bounded: this is a status strip, not a log file. */
    val lines = mutableStateOf<List<String>>(emptyList())

    /** True while the ring is driving this device — what the UI strip keys off. */
    val busy = mutableStateOf(false)

    private const val KEEP = 40

    /** One line, on screen and up to the cluster. */
    fun say(line: String) {
        val l = line.trim()
        if (l.isEmpty()) return
        val cur = lines.value
        lines.value = (if (cur.size >= KEEP) cur.drop(cur.size - KEEP + 1) else cur) + l
        /* A status line must never be able to stall or break the work it is describing. */
        try { upstream?.invoke(l) } catch (e: Throwable) { }
    }

    /** The ring handed us a goal. */
    fun started(g: String, role: String) {
        goal.value = g
        busy.value = true
        lines.value = emptyList()
        say("▶ took the goal as ${role.ifBlank { "general" }} — working on it")
    }

    /** Done, either way. The lines stay on screen: they are the account of what happened. */
    fun finished(how: String) {
        busy.value = false
        say("■ $how")
    }

    /** Which device is doing the work, when it is not this one. Empty means this device, or nothing. */
    val onDevice = mutableStateOf("")

    /** Forget everything — a sign-out, or a cluster this device is no longer connected to. */
    fun clear() {
        busy.value = false
        onDevice.value = ""
        goal.value = ""
        lines.value = emptyList()
    }

    /**
     * WHAT THE RING IS WORKING ON, FROM THE CLUSTER — the half that makes this one UI.
     *
     * Ask on the phone and the job may run on the desktop; ask on the desktop and it may run on the
     * phone. Progress that a device only knows about itself therefore shows nothing on the surface
     * where the question was actually asked, which is the surface that matters. GET /v1/ring/work is
     * the one answer, and the phone, the desktop and the web console all render it through here.
     *
     * The cluster wins over local lines while a remote device is working: they are the same stream
     * (a node posts every line it shows), and the cluster's copy is the one that includes work this
     * device is not doing.
     *
     * @param device  the device the cluster says is working, "" for nothing
     * @param g       the goal it was handed
     * @param ls      every line it has reported
     * @param mine    this device's own name, so it can tell its own work from another's
     */
    fun applyCluster(device: String, g: String, ls: List<String>, mine: String) {
        if (device.isBlank()) {
            /* Nothing running anywhere. Keep whatever this device last did on screen — the account of
               a finished job is worth reading — but stop claiming it is busy. */
            busy.value = false
            onDevice.value = ""
            return
        }
        busy.value = true
        onDevice.value = if (device.equals(mine, ignoreCase = true)) "" else device
        if (g.isNotBlank()) goal.value = g
        /* Never shrink what is on screen: a poll that raced a restart would otherwise blank the
           account of a job that is still going. */
        if (ls.size >= lines.value.size) lines.value = ls.takeLast(KEEP)
    }
}
