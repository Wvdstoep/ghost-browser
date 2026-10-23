package engineer.myapp.gbmobile

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.WorkManager
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Runs due, phone-owned recon watchers. WorkManager may defer a run to protect battery. */
class LocalReconWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val now = System.currentTimeMillis()
        val flows = LocalReconStore.flows(applicationContext)
        for (i in 0 until flows.length()) {
            val flow = flows.optJSONObject(i) ?: continue
            val recon = LocalReconStore.firstRecon(flow) ?: continue
            val target = recon.optString("target")
            val trigger = flow.optJSONArray("nodes")?.optJSONObject(0)?.optJSONObject("trigger")
            val minutes = maxOf(15, trigger?.optInt("n", 60) ?: 60)
            if (!LocalReconSchedule.due(flow.optBoolean("active"), LocalReconStore.isScheduled(flow), target,
                    now, flow.optLong("lastLocalRun", 0), minutes)) continue
            // Reserve the interval before I/O so a worker retry cannot duplicate a pass.
            flow.put("lastLocalRun", now)
            LocalReconStore.save(applicationContext, flow)
            val item = try {
                val report = OnDeviceAuditor.audit(target)
                JSONObject().put("title", "Recon: $target")
                    .put("url", target).put("kind", "security")
                    .put("fields", JSONObject().put("time", report.timestamp)
                        .put("status", "completed on this phone")
                        .put("grade", report.grade).put("findings", report.findingsCount)
                        .put("openPorts", report.openPorts.filter { it.state.equals("OPEN", true) }.joinToString(", ") { it.port.toString() }))
            } catch (error: Exception) {
                JSONObject().put("title", "Recon failed: $target")
                    .put("url", target).put("kind", "security")
                    .put("fields", JSONObject().put("time", now).put("status", "failed")
                        .put("error", error.message ?: "unknown error"))
            }
            LocalReconStore.addResult(applicationContext, flow.optString("id"), item)
        }
        return Result.success()
    }

    companion object {
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<LocalReconWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("gb-local-recon", ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
