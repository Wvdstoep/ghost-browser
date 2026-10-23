package engineer.myapp.gbmobile

import android.content.Context
import androidx.compose.runtime.mutableStateOf
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.Callable

/** Foreground, phone-owned discovery of a single bounded private subnet. */
class LocalRangeScanner(private val context: Context, private val onUi: ((() -> Unit) -> Unit)) {
    val open = mutableStateOf(false)
    val status = mutableStateOf("Ready")
    val progress = mutableStateOf(0)
    val total = mutableStateOf(0)
    val matches = mutableStateOf(0)
    val selected = mutableStateOf("192.168.1.0/24")
    val rate = mutableStateOf(10)
    val portPreset = mutableStateOf("Common services")
    val customPorts = mutableStateOf("")
    private val worker = Executors.newSingleThreadExecutor()
    private val probes = Executors.newFixedThreadPool(18)
    @Volatile private var paused = false
    @Volatile private var stopped = false
    @Volatile private var running = false

    fun presets(): List<Pair<String, String>> {
        val local = try {
            NetworkInterface.getNetworkInterfaces().toList().asSequence()
                .filter { it.isUp && !it.isLoopback && (it.name.startsWith("wlan") || it.name.startsWith("eth")) }
                .flatMap { it.inetAddresses.toList().asSequence() }.filterIsInstance<Inet4Address>()
                .mapNotNull { PrivateRangePlan.parse("${it.hostAddress}/24")?.cidr }.firstOrNull()
        } catch (_: Exception) { null }
        return listOfNotNull(local?.let { "Current Wi-Fi/LAN" to it }) + listOf(
            "Home 192.168.1" to "192.168.1.0/24", "Home 192.168.0" to "192.168.0.0/24",
            "Private 10" to "10.0.0.0/24", "Private 172" to "172.16.0.0/24")
    }

    fun start(): Boolean {
        if (running) return false
        val plan = PrivateRangePlan.parse(selected.value) ?: return false
        val scanPorts = if (portPreset.value == "Custom") ScanPorts.parseCustom(customPorts.value)
            else ScanPorts.presets[portPreset.value]
        if (scanPorts.isNullOrEmpty()) return false
        stopped = false; paused = false; running = true
        progress.value = 0; total.value = plan.hosts.size; matches.value = 0; status.value = "Scanning ${plan.cidr}"
        worker.execute {
            try { for (host in plan.hosts) {
                if (stopped) break
                while (paused && !stopped) Thread.sleep(100)
                if (stopped) break
                val started = System.currentTimeMillis()
                val checks = scanPorts.map { port -> Callable {
                    try { Socket().use { it.connect(InetSocketAddress(host, port), 250) }; port }
                    catch (_: Exception) { null }
                } }
                val ports = probes.invokeAll(checks).mapNotNull { it.get() }
                if (ports.isNotEmpty()) {
                    val fields = JSONObject().put("recordedAt", System.currentTimeMillis())
                        .put("status", "completed on this phone").put("videoCandidate", ports.any { it == 554 || it == 8554 })
                        .put("openPorts", ports.joinToString(", ")).put("scope", plan.cidr)
                        .put("source", "On-device private range scan")
                    val evidence = JSONArray().also { arr -> ports.forEach { arr.put(JSONObject().put("port", it).put("service", "TCP connection accepted")) } }
                    LocalReconStore.addResult(context, "local-recon-range", JSONObject()
                        .put("title", "Open TCP ports: $host").put("url", "http://$host")
                        .put("kind", "security").put("fields", fields).put("ports", evidence))
                }
                onUi { progress.value += 1; if (ports.isNotEmpty()) matches.value += 1 }
                val delay = 1000L / rate.value.coerceIn(1, 50) - (System.currentTimeMillis() - started)
                if (delay > 0) Thread.sleep(delay)
            } } catch (_: InterruptedException) { stopped = true }
            onUi { status.value = if (stopped) "Stopped" else "Completed"; running = false }
        }
        return true
    }

    fun pauseOrResume() { if (running) { paused = !paused; status.value = if (paused) "Paused" else "Scanning ${selected.value}" } }
    fun stop() { stopped = true; paused = false }
    fun isRunning() = running
    fun isPaused() = paused
    fun close() { stop(); worker.shutdownNow(); probes.shutdownNow() }
}
