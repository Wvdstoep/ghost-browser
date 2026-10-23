package engineer.myapp.gbmobile

/** A local watcher is due only after its full interval; Android decides when the worker wakes. */
object LocalReconSchedule {
    fun due(active: Boolean, scheduled: Boolean, target: String, now: Long, lastRun: Long, intervalMin: Int): Boolean =
        active && scheduled && (target.startsWith("https://") || target.startsWith("http://")) &&
            now >= lastRun && now - lastRun >= maxOf(15, intervalMin).toLong() * 60_000L
}
