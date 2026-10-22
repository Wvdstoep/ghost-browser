package engineer.myapp.gb.desktop

import java.io.File

/**
 * ORPHANED BROWSER HELPERS. Every install, crash or forced close of this app left its Chromium
 * renderers (`jcef_helper.exe`) alive with a dead parent - and a renderer with no parent spins at
 * full CPU for ever. Seven of them were found on one laptop eating most of eight cores, which is
 * why "the laptop is slow" and why a training round crawled at a tenth of its speed.
 *
 * Two answers, both here: on start and every five minutes, any jcef helper whose parent is gone is
 * ended; and when this app exits, its own helpers go with it, so the next instance finds nothing
 * to reap. Only helpers with NO living parent are touched - a second running instance keeps its own.
 */
object Housekeeping {
    private const val HELPER = "jcef_helper"

    fun start() {
        Runtime.getRuntime().addShutdownHook(Thread { try { endMine() } catch (_: Throwable) {} })
        Thread {
            while (true) {
                try { reapOrphans() } catch (_: Throwable) {}
                try { Thread.sleep(5 * 60 * 1000L) } catch (_: InterruptedException) { return@Thread }
            }
        }.apply { isDaemon = true; name = "gb-housekeeping" }.start()
    }

    /** Helpers whose parent process no longer exists: nobody will ever tell them to stop. */
    fun reapOrphans(): Int {
        var n = 0
        ProcessHandle.allProcesses().forEach { h ->
            val cmd = h.info().command().orElse("")
            if (!cmd.lowercase().contains(HELPER)) return@forEach
            val parentAlive = h.parent().map { it.isAlive }.orElse(false)
            if (!parentAlive) { try { if (h.destroyForcibly()) n++ } catch (_: Throwable) {} }
        }
        if (n > 0) note("ended $n orphaned browser helper process(es)")
        return n
    }

    /** This instance's own helpers, ended with it. */
    private fun endMine() {
        ProcessHandle.current().descendants().forEach { h ->
            val cmd = h.info().command().orElse("")
            if (cmd.lowercase().contains(HELPER)) { try { h.destroyForcibly() } catch (_: Throwable) {} }
        }
    }

    private fun note(line: String) {
        try {
            val f = File(System.getProperty("user.home"), ".ghostbrowser/housekeeping.log")
            f.parentFile?.mkdirs()
            f.appendText("[" + java.util.Date() + "] " + line + "\n")
        } catch (_: Throwable) {}
    }
}
