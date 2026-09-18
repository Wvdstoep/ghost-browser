package engineer.myapp.gbmobile

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * The self-hosted presence watchdog — no third-party push (no Firebase). Android's own job scheduler wakes
 * this roughly every 15 minutes, even after the app was swiped away or the phone rebooted, and it revives the
 * foreground service so the device ring reconnects to the platform. While the service is alive the platform
 * drives the device instantly through the ring's long-poll; this only exists to bring the service back when
 * the OS killed it. It reads the saved cluster key straight from prefs, so it needs no running Activity.
 */
class RingWatchdogWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        return try {
            val sp = applicationContext.getSharedPreferences("gb", Context.MODE_PRIVATE)
            val key = sp.getString("clusterKey", "") ?: ""
            if (key.isNotBlank()) {
                // revive the ring service; if it is already running this is a no-op that just refreshes it
                ContextCompat.startForegroundService(applicationContext, Intent(applicationContext, GbService::class.java).putExtra("reason", "watchdog"))
            }
            Result.success()
        } catch (e: Exception) { Result.success() }   // never fail the chain; try again next tick
    }
}
