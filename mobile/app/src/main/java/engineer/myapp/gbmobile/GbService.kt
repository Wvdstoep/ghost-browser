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
    private var browser: ServiceBrowser? = null
    @Volatile private var ringOn = false
    private val ringExec = java.util.concurrent.Executors.newSingleThreadExecutor()

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
        // The ring runs here, not in the app: revived by the watchdog or started by the app, this is enough —
        // nothing has to be opened on the owner's screen.
        startRing()
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

    // ── the device ring ────────────────────────────────────────────────────────────────────────────
    private val sp by lazy { getSharedPreferences("gb", MODE_PRIVATE) }
    private fun deviceToken(): String {
        var t = sp.getString("token", null)
        if (t == null) { t = java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 24); sp.edit().putString("token", t).apply() }
        return t
    }
    private fun ringHttp(method: String, path: String, body: String?, timeoutMs: Int): Pair<Int, String> {
        val c = java.net.URL((sp.getString("clusterUrl", "") ?: "").trim().trimEnd('/') + path).openConnection() as java.net.HttpURLConnection
        c.requestMethod = method; c.connectTimeout = 15000; c.readTimeout = timeoutMs
        c.setRequestProperty("Authorization", "Bearer ${sp.getString("clusterKey", "")}"); c.setRequestProperty("Accept", "application/json")
        if (body != null) { c.doOutput = true; c.setRequestProperty("Content-Type", "application/json"); c.outputStream.use { it.write(body.toByteArray()) } }
        val code = c.responseCode
        val txt = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        return code to txt
    }
    private fun caps(): org.json.JSONObject = try { org.json.JSONObject(sp.getString("ringCaps", null) ?: "") } catch (e: Exception) {
        org.json.JSONObject().put("platform", "android").put("mobileApp", true).put("model", false).put("realIp", true)
            .put("profiles", org.json.JSONArray().put("default")).put("features", org.json.JSONArray().put("native_tap"))
    }

    /** Commands for the default browser run in the service's own window; logged-in profiles and anything
     *  else run in the app (reopened in the background when it is not open). */
    private fun dispatch(path: String, body: org.json.JSONObject): String {
        val prof = body.optString("profile", "")
        val plain = prof.isBlank() || prof == "default"
        if (plain && path in ServiceBrowser.PATHS) {
            val b = browser ?: ServiceBrowser(applicationContext).also { browser = it }
            if (b.ensure()) return b.run(path, body)
        }
        val screen = MainActivity.live?.takeIf { it.ringReady() } ?: MainActivity.live?.ringTarget()
            ?: run {
                try { startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION).putExtra("forRing", true)) } catch (e: Exception) {}
                val until = System.currentTimeMillis() + 20000
                var s: MainActivity? = null
                while (s == null && System.currentTimeMillis() < until) { Thread.sleep(500); s = MainActivity.live?.takeIf { it.ringReady() } }
                s
            }
        return screen?.runDeviceCommand(path, body.toString())
            ?: "{\"error\":\"This needs the Ghost Browser app (a signed-in profile); it could not be opened on the phone.\"}"
    }

    private fun startRing() {
        if (ringOn || (sp.getString("clusterKey", "") ?: "").isBlank() || (sp.getString("clusterUrl", "") ?: "").isBlank()) return
        ringOn = true
        MainActivity.ringRunning.set(true)
        ringExec.execute {
            var registered = false
            while (ringOn) {
                try {
                    if (!registered) {
                        val reg = ringHttp("POST", "/v1/device/register", org.json.JSONObject().put("deviceId", deviceToken()).put("name", Build.MODEL).put("caps", caps()).toString(), 20000)
                        if (reg.first == 401) { sp.edit().putString("clusterKey", "").apply(); break }
                        registered = reg.first in 200..299
                        if (!registered) { Thread.sleep(4000); continue }
                    }
                    val (code, txt) = ringHttp("GET", "/v1/device/poll?deviceId=" + java.net.URLEncoder.encode(deviceToken(), "UTF-8"), null, 35000)
                    if (code == 401) { sp.edit().putString("clusterKey", "").apply(); break }
                    if (code == 404) { registered = false; continue }
                    if (code == 200 && txt.isNotBlank()) {
                        val cmd = try { org.json.JSONObject(txt) } catch (e: Exception) { null }
                        val cid = cmd?.optString("id") ?: ""
                        if (cmd != null && cid.isNotBlank()) {
                            val out = dispatch(cmd.optString("path", "/v1/info"), cmd.optJSONObject("body") ?: org.json.JSONObject())
                            try { ringHttp("POST", "/v1/device/result", org.json.JSONObject().put("deviceId", deviceToken()).put("id", cid).put("result", out).toString(), 20000) } catch (e: Exception) {}
                        }
                    }
                } catch (e: Exception) { Thread.sleep(3000) }
            }
            ringOn = false
            MainActivity.ringRunning.set(false)
        }
    }

    override fun onDestroy() {
        ringOn = false
        try { browser?.close() } catch (e: Exception) {}
        browser = null
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (e: Exception) {}
        wakeLock = null
        super.onDestroy()
    }
}
