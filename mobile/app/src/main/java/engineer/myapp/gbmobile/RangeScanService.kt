package engineer.myapp.gbmobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** User-started foreground scan of one saved, bounded range. No cluster is involved. */
class RangeScanService : Service() {
    private val db by lazy { RangeScanDb(applicationContext) }
    private val probes = Executors.newFixedThreadPool(16)
    private val webProbes = Executors.newSingleThreadExecutor()
    @Volatile private var stopAs: String? = null
    @Volatile private var worker: Thread? = null
    @Volatile private var finishing = false
    @Volatile private var destroyed = false
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        active = true
        if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(CHANNEL) == null)
                manager.createNotificationChannel(NotificationChannel(CHANNEL, "Range discovery", NotificationManager.IMPORTANCE_LOW))
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PAUSE, ACTION_STOP -> {
                stopAs = if (intent.action == ACTION_PAUSE) "paused" else "stopped"
                db.read()?.let { job ->
                    db.status(job.runId, if (worker?.isAlive == true) {
                        if (stopAs == "paused") "pausing" else "stopping"
                    } else stopAs!!)
                    if (worker?.isAlive != true) {
                        db.read()?.let { notifyProgress(it, finished = true) }
                        stopSelf()
                    }
                }
                return START_NOT_STICKY
            }
            ACTION_START, ACTION_RESUME -> {
                if (worker?.isAlive == true) return START_NOT_STICKY
                val job = db.read() ?: run { stopSelf(); return START_NOT_STICKY }
                val plan = RangePlan.parse(job.cidr) ?: run { db.status(job.runId, "failed"); stopSelf(); return START_NOT_STICKY }
                if (plan.scope == RangePlan.Scope.PUBLIC && PublicRangePresets.load(this).none { it.cidr == plan.cidr }) {
                    db.status(job.runId, "failed"); stopSelf(); return START_NOT_STICKY
                }
                if (job.nextIndex >= job.total || job.status in listOf("completed", "stopped")) {
                    stopSelf(); return START_NOT_STICKY
                }
                stopAs = null
                try {
                    promote(job)
                    db.status(job.runId, "running")
                    db.read()?.let { notifyProgress(it) }
                    holdCpu()
                    worker = Thread({ scan(job.runId, plan) }, "gb-range-scan").also { it.start() }
                } catch (_: Exception) {
                    db.status(job.runId, "failed")
                    releaseCpu()
                    stopSelf()
                }
            }
        }
        return START_NOT_STICKY
    }

    private fun scan(runId: Long, plan: RangePlan) {
        val rate = db.read()?.attemptsPerSecond?.coerceIn(2, 50) ?: 10
        val gate = ConnectionRateGate(rate)
        var final = "completed"
        try {
            while (true) {
                val job = db.read() ?: break
                if (job.runId != runId) break
                if (stopAs != null) { final = stopAs!!; break }
                if (job.nextIndex >= plan.hosts.size) break
                val host = plan.hosts[job.nextIndex]
                val timeout = if (plan.scope == RangePlan.Scope.PUBLIC) 1000 else 600
                val tasks = job.ports.map { port -> Callable<Int?> {
                    try {
                        gate.awaitTurn()
                        Socket().use { it.connect(InetSocketAddress(host, port), timeout) }
                        port
                    } catch (_: Exception) { null }
                } }
                val open = probes.invokeAll(tasks).mapNotNull { it.get() }
                val web = if (job.webFollowUp && stopAs == null) open.filter(WebServiceProbe::supports)
                    .mapNotNull { port -> webProbes.submit(Callable { WebServiceProbe.inspect(host, port) }).get() }
                    else emptyList()
                db.checkpoint(job, host, open, job.nextIndex + 1, web)
                val current = db.read() ?: break
                if (current.nextIndex == current.total || current.nextIndex % 4 == 0) notifyProgress(current)
            }
        } catch (_: InterruptedException) { final = stopAs ?: "paused" }
        catch (_: Exception) { final = "failed" }
        db.status(runId, stopAs ?: final)
        db.read()?.let { notifyProgress(it, finished = true) }
        releaseCpu()
        finishing = true
        stopForeground(STOP_FOREGROUND_DETACH)
        stopSelf()
        if (destroyed) db.close()
    }

    private fun promote(job: RangeScanJob) {
        val notification = notification(job)
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(NOTIFICATION_ID, notification)
    }

    private fun notifyProgress(job: RangeScanJob, finished: Boolean = false) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(job, finished))
    }

    private fun notification(job: RangeScanJob, finished: Boolean = false): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val builder = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_search)
            .setContentTitle("Range discovery · ${job.cidr}")
            .setContentText("${job.status.replaceFirstChar { it.uppercase() }} · ${job.nextIndex}/${job.total} hosts · ${job.hits} matches")
            .setContentIntent(open).setOnlyAlertOnce(true).setOngoing(!finished)
            .setProgress(job.total, job.nextIndex, false)
        if (!finished) {
            builder.addAction(android.R.drawable.ic_media_pause, "Pause", serviceAction(ACTION_PAUSE, foreground = false))
            builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", serviceAction(ACTION_STOP, foreground = false))
        } else if (job.status == "paused") builder.addAction(android.R.drawable.ic_media_play, "Resume", serviceAction(ACTION_RESUME, foreground = true))
        return builder.build()
    }

    private fun serviceAction(action: String, foreground: Boolean): PendingIntent {
        val intent = Intent(this, RangeScanService::class.java).setAction(action)
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        return if (foreground) PendingIntent.getForegroundService(this, action.hashCode(), intent, flags)
            else PendingIntent.getService(this, action.hashCode(), intent, flags)
    }

    private fun holdCpu() {
        val manager = getSystemService(PowerManager::class.java)
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gb:range-scan").apply { acquire(60 * 60 * 1000L) }
    }

    private fun releaseCpu() { try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}; wakeLock = null }

    override fun onDestroy() {
        destroyed = true
        active = false
        if (worker?.isAlive == true && !finishing) {
            stopAs = "paused"
            worker?.interrupt()
            db.read()?.let { db.status(it.runId, "paused") }
        }
        probes.shutdownNow()
        webProbes.shutdownNow()
        releaseCpu()
        if (worker?.isAlive != true || finishing) db.close()
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "engineer.myapp.gbmobile.range.START"
        const val ACTION_RESUME = "engineer.myapp.gbmobile.range.RESUME"
        const val ACTION_PAUSE = "engineer.myapp.gbmobile.range.PAUSE"
        const val ACTION_STOP = "engineer.myapp.gbmobile.range.STOP"
        private const val CHANNEL = "gb_range_discovery"
        private const val NOTIFICATION_ID = 209
        @Volatile var active = false
            private set
    }
}

/** Serializes connection starts across the bounded socket pool. */
class ConnectionRateGate(rate: Int) {
    private val gapNanos = TimeUnit.SECONDS.toNanos(1) / rate.coerceIn(2, 50)
    private var nextAt = 0L

    @Synchronized fun awaitTurn() {
        val now = System.nanoTime()
        if (nextAt > now) TimeUnit.NANOSECONDS.sleep(nextAt - now)
        nextAt = maxOf(nextAt, System.nanoTime()) + gapNanos
    }
}
