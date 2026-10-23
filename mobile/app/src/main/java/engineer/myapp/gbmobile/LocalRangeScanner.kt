package engineer.myapp.gbmobile

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.ContextCompat
import java.net.Inet4Address
import java.net.NetworkInterface

/** Compose-facing controller for the durable, notification-backed scan service. */
class LocalRangeScanner(private val context: Context) {
    val open = mutableStateOf(false)
    val status = mutableStateOf("Ready")
    val progress = mutableStateOf(0)
    val total = mutableStateOf(0)
    val matches = mutableStateOf(0)
    val selected = mutableStateOf("192.168.1.0/24")
    /** Connection attempts per second, not hosts per second. */
    val rate = mutableStateOf(10)
    val portPreset = mutableStateOf("Common services")
    val customPorts = mutableStateOf("")
    val webFollowUp = mutableStateOf(false)
    val savedPublic = mutableStateListOf<PublicRangePreset>().also { it.addAll(PublicRangePresets.load(context)) }
    private val db = RangeScanDb(context)

    init {
        db.read()?.let { selected.value = it.cidr; rate.value = it.attemptsPerSecond; webFollowUp.value = it.webFollowUp }
        refresh()
    }

    fun presets(): List<Pair<String, String>> {
        val local = try {
            NetworkInterface.getNetworkInterfaces().toList().asSequence()
                .filter { it.isUp && !it.isLoopback && (it.name.startsWith("wlan") || it.name.startsWith("eth")) }
                .flatMap { it.inetAddresses.toList().asSequence() }.filterIsInstance<Inet4Address>()
                .mapNotNull { RangePlan.parse("${it.hostAddress}/24")?.takeIf { plan -> plan.scope == RangePlan.Scope.PRIVATE }?.cidr }
                .firstOrNull()
        } catch (_: Exception) { null }
        return listOfNotNull(local?.let { "Current Wi-Fi/LAN" to it }) + listOf(
            "Home 192.168.1" to "192.168.1.0/24", "Home 192.168.0" to "192.168.0.0/24",
            "Private 10" to "10.0.0.0/24", "Private 172" to "172.16.0.0/24")
    }

    fun addPublicPreset(name: String, cidr: String): Boolean {
        val preset = PublicRangePreset.create(name, cidr) ?: return false
        if (savedPublic.size >= 32 && savedPublic.none { it.cidr == preset.cidr }) return false
        savedPublic.removeAll { it.cidr == preset.cidr }
        savedPublic.add(0, preset)
        PublicRangePresets.save(context, savedPublic)
        selected.value = preset.cidr
        return true
    }

    fun removePublicPreset(cidr: String) {
        savedPublic.removeAll { it.cidr == cidr }
        PublicRangePresets.save(context, savedPublic)
    }

    fun start(): Boolean {
        if (isRunning()) return false
        val plan = RangePlan.parse(selected.value) ?: return false
        if (plan.scope == RangePlan.Scope.PUBLIC && savedPublic.none { it.cidr == plan.cidr }) return false
        val ports = if (portPreset.value == "Custom") ScanPorts.parseCustom(customPorts.value)
            else ScanPorts.presets[portPreset.value]
        if (ports.isNullOrEmpty()) return false
        db.begin(plan, ports, rate.value.coerceIn(2, 50), webFollowUp.value)
        refresh()
        return try {
            ContextCompat.startForegroundService(context, Intent(context, RangeScanService::class.java).setAction(RangeScanService.ACTION_START))
            true
        } catch (_: Exception) {
            db.read()?.let { db.status(it.runId, "failed") }
            refresh()
            false
        }
    }

    fun pauseOrResume() {
        val action = if (isPaused()) RangeScanService.ACTION_RESUME else RangeScanService.ACTION_PAUSE
        try {
            val intent = Intent(context, RangeScanService::class.java).setAction(action)
            if (action == RangeScanService.ACTION_RESUME) ContextCompat.startForegroundService(context, intent)
            else context.startService(intent)
        } catch (_: Exception) { db.read()?.let { db.status(it.runId, "paused") } }
        refresh()
    }

    fun stop() {
        try { context.startService(Intent(context, RangeScanService::class.java).setAction(RangeScanService.ACTION_STOP)) }
        catch (_: Exception) { db.read()?.let { db.status(it.runId, "stopped") } }
        refresh()
    }

    fun refresh() {
        val job = db.read() ?: return
        if (job.status == "running" && !RangeScanService.active && System.currentTimeMillis() - job.updatedAt > 10_000)
            db.status(job.runId, "paused")
        val current = db.read() ?: return
        progress.value = current.nextIndex
        total.value = current.total
        matches.value = current.hits
        status.value = when (current.status) {
            "starting" -> "Starting ${current.cidr}"
            "running" -> "Scanning ${current.cidr}"
            "pausing" -> "Pausing"
            "stopping" -> "Stopping"
            "paused" -> "Paused · ${current.cidr}"
            "completed" -> "Completed · ${current.cidr}"
            "stopped" -> "Stopped · ${current.cidr}"
            else -> "Scan failed"
        }
    }

    fun isRunning() = db.read()?.status in listOf("starting", "running", "pausing", "stopping")
    fun isPaused() = db.read()?.status == "paused"
    fun close() = db.close()
}
