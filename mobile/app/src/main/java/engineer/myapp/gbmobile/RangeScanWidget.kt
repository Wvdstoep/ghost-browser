package engineer.myapp.gbmobile

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import androidx.core.content.ContextCompat

const val ACTION_WIDGET_RANGE_OPEN = "engineer.myapp.gbmobile.WIDGET_RANGE_OPEN"
const val ACTION_WIDGET_RANGE_RESULTS = "engineer.myapp.gbmobile.WIDGET_RANGE_RESULTS"

/** The widget mirrors the one durable on-device scan job. All widget instances show the same run. */
data class RangeScanWidgetState(
    val title: String, val status: String, val progress: Int, val total: Int,
    val matches: Int, val recent: String, val startLabel: String, val canPause: Boolean, val canStop: Boolean,
) {
    companion object {
        fun from(job: RangeScanJob?, latest: RangeEvidence?, start: RangeScanWidgetCommand.StartDecision): RangeScanWidgetState {
            if (job == null) return RangeScanWidgetState("No scan configured", "READY", 0, 1, 0,
                "Choose a range in Ghost Browser", "Set up", false, false)
            val state = when (job.status) {
                "running" -> "SCANNING"; "starting" -> "STARTING"; "pausing" -> "PAUSING"
                "paused" -> "PAUSED"; "completed" -> "COMPLETE"; "stopped" -> "STOPPED"
                "stopping" -> "STOPPING"; else -> "NEEDS ATTENTION"
            }
            val recent = latest?.let { "Latest · ${it.host} · ${it.ports.joinToString(", ") { port -> ":$port" }}" }
                ?: if (job.hits == 0) "Waiting for an open service" else "${job.hits} hosts with open ports"
            return RangeScanWidgetState(job.cidr, state, job.nextIndex.coerceIn(0, job.total), job.total.coerceAtLeast(1),
                job.hits, recent, when {
                    job.status in setOf("running", "starting", "pausing", "stopping") -> "Running"
                    start == RangeScanWidgetCommand.StartDecision.RESUME -> "Resume"
                    start == RangeScanWidgetCommand.StartDecision.RESTART -> "Start"
                    else -> "Set up"
                },
                job.status == "running", job.status in setOf("running", "starting", "paused", "pausing"))
        }
    }
}

object RangeScanWidgetCommand {
    enum class StartDecision { NONE, RESUME, RESTART }

    fun decideStart(job: RangeScanJob, savedPublicCidrs: Set<String>): StartDecision {
        if (job.status in setOf("running", "starting", "pausing", "stopping")) return StartDecision.NONE
        val plan = RangePlan.parse(job.cidr) ?: return StartDecision.NONE
        if (plan.scope == RangePlan.Scope.PUBLIC && plan.cidr !in savedPublicCidrs) return StartDecision.NONE
        if (job.ports.isEmpty() || job.ports.size > 24 || job.ports.any { it !in 1..65535 }) return StartDecision.NONE
        if (job.status == "paused" && job.nextIndex >= job.total) return StartDecision.NONE
        return if (job.status == "paused") StartDecision.RESUME else StartDecision.RESTART
    }
}

class RangeScanWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val db = RangeScanDb(context)
        val state = try {
            var job = db.read()
            if (job != null && job.status in setOf("running", "starting") && !RangeScanService.active &&
                System.currentTimeMillis() - job.updatedAt > 10_000L) {
                db.status(job.runId, "paused")
                job = db.read()
            }
            val decision = job?.let { RangeScanWidgetCommand.decideStart(it,
                PublicRangePresets.load(context).map { preset -> preset.cidr }.toSet()) } ?: RangeScanWidgetCommand.StartDecision.NONE
            RangeScanWidgetState.from(job, job?.let { db.reviewItems(it.runId, 1).firstOrNull() }, decision)
        } finally { db.close() }
        ids.forEach { id ->
            val views = RemoteViews(context.packageName, R.layout.widget_range_scan)
            views.setTextViewText(R.id.scan_widget_target, state.title)
            views.setTextViewText(R.id.scan_widget_status, state.status)
            views.setTextViewText(R.id.scan_widget_progress, "${state.progress} / ${state.total} hosts")
            views.setTextViewText(R.id.scan_widget_matches, "${state.matches} MATCHES")
            views.setTextViewText(R.id.scan_widget_recent, state.recent)
            views.setTextViewText(R.id.scan_widget_start, state.startLabel)
            views.setProgressBar(R.id.scan_widget_bar, state.total, state.progress, false)
            views.setOnClickPendingIntent(R.id.scan_widget_header, open(context, ACTION_WIDGET_RANGE_OPEN, 31))
            views.setOnClickPendingIntent(R.id.scan_widget_recent, open(context, ACTION_WIDGET_RANGE_RESULTS, 32))
            views.setOnClickPendingIntent(R.id.scan_widget_setup, open(context, ACTION_WIDGET_RANGE_OPEN, 33))
            views.setOnClickPendingIntent(R.id.scan_widget_start,
                if (state.startLabel == "Set up") open(context, ACTION_WIDGET_RANGE_OPEN, 34)
                else if (state.startLabel == "Running") null
                else command(context, RangeScanWidgetActionReceiver.ACTION_START_LAST, 35))
            views.setOnClickPendingIntent(R.id.scan_widget_pause,
                if (state.canPause) command(context, RangeScanWidgetActionReceiver.ACTION_PAUSE, 36) else null)
            views.setOnClickPendingIntent(R.id.scan_widget_stop,
                if (state.canStop) command(context, RangeScanWidgetActionReceiver.ACTION_STOP, 37) else null)
            views.setInt(R.id.scan_widget_pause, "setTextColor", if (state.canPause) 0xffeaf3ff.toInt() else 0xff73859c.toInt())
            views.setInt(R.id.scan_widget_stop, "setTextColor", if (state.canStop) 0xffffc3c9.toInt() else 0xff73859c.toInt())
            manager.updateAppWidget(id, views)
        }
    }

    companion object {
        @Volatile private var lastRefreshAt = 0L

        @Synchronized fun refresh(context: Context, force: Boolean = false) {
            val now = android.os.SystemClock.elapsedRealtime()
            if (!force && lastRefreshAt != 0L && now - lastRefreshAt < 1_000L) return
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, RangeScanWidgetProvider::class.java))
            if (ids.isNotEmpty()) {
                lastRefreshAt = now
                RangeScanWidgetProvider().onUpdate(context, manager, ids)
            }
        }

        private fun open(context: Context, action: String, code: Int) = PendingIntent.getActivity(context, code,
            Intent(context, MainActivity::class.java).setAction(action)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        private fun command(context: Context, action: String, code: Int) = PendingIntent.getBroadcast(context, code,
            Intent(context, RangeScanWidgetActionReceiver::class.java).setAction(action).addFlags(Intent.FLAG_RECEIVER_FOREGROUND),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}

/** Non-exported receiver: widget clicks may control the existing scan, but not alter its scope. */
class RangeScanWidgetActionReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val db = RangeScanDb(context)
        try {
            val job = db.read() ?: return
            when (intent.action) {
                ACTION_PAUSE -> if (job.status == "running") {
                    val delivered = if (RangeScanService.active) runCatching { context.startService(
                        Intent(context, RangeScanService::class.java).setAction(RangeScanService.ACTION_PAUSE)) }.isSuccess else false
                    if (!delivered) db.status(job.runId, "paused")
                }
                ACTION_STOP -> if (job.status in setOf("running", "starting", "paused", "pausing")) {
                    val delivered = if (RangeScanService.active) runCatching { context.startService(
                        Intent(context, RangeScanService::class.java).setAction(RangeScanService.ACTION_STOP)) }.isSuccess else false
                    if (!delivered) db.status(job.runId, "stopped")
                }
                ACTION_START_LAST -> {
                    val decision = RangeScanWidgetCommand.decideStart(job,
                        PublicRangePresets.load(context).map { it.cidr }.toSet())
                    if (decision == RangeScanWidgetCommand.StartDecision.NONE) return
                    val action = if (decision == RangeScanWidgetCommand.StartDecision.RESUME) RangeScanService.ACTION_RESUME else {
                        val plan = requireNotNull(RangePlan.parse(job.cidr))
                        db.begin(plan, job.ports, job.attemptsPerSecond.coerceIn(2, 50), job.webFollowUp)
                        RangeScanService.ACTION_START
                    }
                    try {
                        ContextCompat.startForegroundService(context, Intent(context, RangeScanService::class.java).setAction(action))
                    } catch (_: Exception) { db.read()?.let { db.status(it.runId, "failed") } }
                }
            }
        } finally { db.close(); RangeScanWidgetProvider.refresh(context, force = true) }
    }

    companion object {
        const val ACTION_START_LAST = "engineer.myapp.gbmobile.range.widget.START_LAST"
        const val ACTION_PAUSE = "engineer.myapp.gbmobile.range.widget.PAUSE"
        const val ACTION_STOP = "engineer.myapp.gbmobile.range.widget.STOP"
    }
}
