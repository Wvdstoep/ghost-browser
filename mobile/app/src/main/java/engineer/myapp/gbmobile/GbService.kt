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

/**
 * Keeps GB Mobile alive when the screen goes off. A foreground service (persistent notification) stops
 * Android from killing the process, and a partial wake lock keeps the CPU up so the poll loop and the
 * WebView keep working — so the phone stays a reachable cluster node while the screen is dark.
 */
class GbService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val channelId = "gb_connected"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(channelId) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(channelId, "GB Mobile", NotificationManager.IMPORTANCE_LOW)
                )
            }
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notif: Notification = NotificationCompat.Builder(this, channelId)
            .setContentTitle("GB Mobile — connected")
            .setContentText("Keeping the browser reachable for hunts")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .setContentIntent(open)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(1, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(1, notif)
        }

        if (wakeLock == null) {
            val pm = getSystemService(PowerManager::class.java)
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gb:poll").apply { acquire() }
        }
        // revived by the watchdog after the app was killed: bring the app back so the ring + its browser live
        // again (the ring needs the app process, a headless service cannot drive a WebView). Best-effort —
        // Android may refuse a background Activity start, in which case the next launch or watchdog tick retries.
        if (intent?.getStringExtra("reason") == "watchdog") {
            try { startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (e: Exception) {}
        }
        return START_STICKY
    }

    // Swiped away from recents: re-arm the self-hosted watchdog so the OS revives us within ~15 min. No push service.
    override fun onTaskRemoved(rootIntent: Intent?) {
        try {
            val req = androidx.work.OneTimeWorkRequestBuilder<RingWatchdogWorker>()
                .setInitialDelay(10, java.util.concurrent.TimeUnit.SECONDS).build()
            androidx.work.WorkManager.getInstance(applicationContext).enqueue(req)
        } catch (e: Exception) {}
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (e: Exception) {}
        wakeLock = null
        super.onDestroy()
    }
}
