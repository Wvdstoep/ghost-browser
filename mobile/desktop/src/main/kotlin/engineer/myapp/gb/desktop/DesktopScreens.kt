package engineer.myapp.gb.desktop

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import engineer.myapp.gb.shared.*
import org.json.JSONObject
import kotlin.concurrent.thread

/** Reactive desktop state the screens read; the node + loaders write to it. */
class DesktopState {
    val flows = mutableStateOf<List<FlowInfo>>(emptyList())
    val flowsHint = mutableStateOf("Load your automations from the cluster.")
    val devices = mutableStateOf<List<HubDevice>>(emptyList())
    val hubSummary = mutableStateOf("")
    val platforms = mutableStateOf<List<PlatformOpt>>(emptyList())
    val activity = mutableStateOf("")
    val nodeStatus = mutableStateOf("node: connecting…")
    val dark = mutableStateOf(true)
    fun log(line: String) { nodeStatus.value = line; activity.value = (activity.value + line + "\n").takeLast(6000) }
}

private fun bg(block: () -> Unit) = thread(isDaemon = true) { block() }

fun loadFlows(st: DesktopState) = bg {
    val r = Cluster.authed("GET", "/v1/workflows", null)
    try {
        val arr = JSONObject(r).optJSONArray("workflows") ?: return@bg
        val out = ArrayList<FlowInfo>()
        for (i in 0 until arr.length()) {
            val w = arr.optJSONObject(i) ?: continue
            val id = w.optString("id"); if (id.isBlank()) continue
            val runs = w.optInt("runs", 0)
            val last = if (runs > 0) "$runs runs, last ${w.optString("lastRunStatus", "?")}" else "never run"
            out.add(FlowInfo(id, w.optString("name", id), w.optJSONArray("nodes")?.length() ?: 0, last))
        }
        st.flows.value = out
        st.flowsHint.value = if (out.isEmpty()) "No automations yet." else "${out.size} automations — click Run to fire one."
    } catch (e: Exception) { st.flowsHint.value = "Sign in first (open Ghost Browser from my-app Tools)." }
}

fun loadDevices(st: DesktopState) = bg {
    val r = Cluster.authed("GET", "/v1/device/list", null)
    try {
        val arr = JSONObject(r).optJSONArray("devices") ?: return@bg
        val out = ArrayList<HubDevice>(); var online = 0
        for (i in 0 until arr.length()) {
            val d = arr.optJSONObject(i) ?: continue
            val on = d.optBoolean("online"); if (on) online++
            val caps = d.optJSONObject("caps"); val plat = caps?.optString("platform") ?: ""
            val type = when { plat == "android" -> "PHONE"; plat == "desktop" -> "LAPTOP"; plat == "cluster" -> "CLUSTER"; else -> "NODE" }
            out.add(HubDevice(d.optString("name").ifBlank { d.optString("deviceId") }, d.optString("owner"), type, on, d.optLong("lastSeen", 0), d.optInt("queued", 0)))
        }
        st.devices.value = out; st.hubSummary.value = "$online online · ${arr.length()} registered"
    } catch (e: Exception) {}
}

fun loadPlatforms(st: DesktopState) = bg {
    val r = Cluster.authed("GET", "/v1/profiles/presets", null)
    try {
        val arr = JSONObject(r).optJSONArray("presets") ?: return@bg
        val out = ArrayList<PlatformOpt>()
        for (i in 0 until arr.length()) {
            val p = arr.optJSONObject(i) ?: continue
            val key = p.optString("key"); val site = p.optString("site"); if (key.isBlank() || site.isBlank()) continue
            out.add(PlatformOpt(p.optString("label", key).ifBlank { key }, site, "p_" + key.lowercase(), false))
        }
        st.platforms.value = out
    } catch (e: Exception) {}
}

fun runFlow(id: String, st: DesktopState) = bg {
    st.log("▶ running $id on the cluster…")
    val r = Cluster.authed("POST", "/v1/workflows/$id/run", "{}")
    val runId = try { JSONObject(r).optString("runId") } catch (e: Exception) { "" }
    st.log(if (runId.isNotBlank()) "● started run $runId" else "! run: ${r.take(120)}")
}

/* ── Flows ─────────────────────────────────────────────────────────────────────────────────── */
@Composable
fun FlowsScreenD(st: DesktopState) {
    val cs = MaterialTheme.colorScheme
    LaunchedEffect(Unit) { if (st.flows.value.isEmpty()) loadFlows(st) }
    Column(Modifier.fillMaxSize().background(cs.background).verticalScroll(rememberScrollState()).padding(20.dp)) {
        Text("Automations", style = MaterialTheme.typography.headlineSmall)
        Text(st.flowsHint.value, color = cs.onSurfaceVariant, fontSize = 12.sp)
        Spacer(Modifier.height(12.dp))
        OutlinedButton(onClick = { loadFlows(st) }, shape = RoundedCornerShape(12.dp)) { Text("Load from cluster") }
        Spacer(Modifier.height(14.dp))
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            st.flows.value.forEach { f ->
                Surface(color = cs.surface, shape = RoundedCornerShape(14.dp), border = androidx.compose.foundation.BorderStroke(1.dp, cs.outline), modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(f.name, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${f.steps} step(s) · ${f.sub}", color = cs.onSurfaceVariant, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        Button(onClick = { runFlow(f.id, st) }, shape = RoundedCornerShape(10.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Run") }
                    }
                }
            }
        }
    }
}

/* ── Device Hub ────────────────────────────────────────────────────────────────────────────── */
@Composable
fun DeviceHubScreenD(st: DesktopState) {
    val cs = MaterialTheme.colorScheme
    LaunchedEffect(Unit) { loadDevices(st) }
    Column(Modifier.fillMaxSize().background(cs.background)) {
        Row(Modifier.fillMaxWidth().padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Device Hub", style = MaterialTheme.typography.headlineSmall)
                Text(st.hubSummary.value.ifBlank { "Every node on your account" }, color = cs.onSurfaceVariant, fontSize = 12.sp)
            }
            IconButton(onClick = { loadDevices(st) }) { Icon(Icons.Default.Refresh, "Refresh", tint = cs.onSurface) }
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            st.devices.value.forEach { d ->
                Surface(color = cs.surface, shape = RoundedCornerShape(16.dp), border = androidx.compose.foundation.BorderStroke(1.dp, cs.outline), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(10.dp).clip(CircleShape).background(if (d.online) Brand else cs.onSurfaceVariant))
                            Spacer(Modifier.width(10.dp))
                            Text(d.name, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(8.dp)) { Text(d.type, Modifier.padding(horizontal = 10.dp, vertical = 4.dp), color = cs.onSurfaceVariant, fontSize = 10.sp, fontWeight = FontWeight.SemiBold) }
                        }
                        if (d.owner.isNotBlank()) Text(d.owner, color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.padding(start = 20.dp, top = 2.dp))
                        Spacer(Modifier.height(8.dp))
                        Text(if (d.online) "online · queued ${d.queued}" else "offline", color = if (d.online) Brand else cs.onSurfaceVariant, fontFamily = FontFamily.Monospace, fontSize = 12.sp, modifier = Modifier.padding(start = 20.dp))
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}

/* ── Settings ──────────────────────────────────────────────────────────────────────────────── */
@Composable
fun SettingsScreenD(st: DesktopState, onOpenUrl: (String) -> Unit, onOpenDevices: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    LaunchedEffect(Unit) { if (st.platforms.value.isEmpty()) loadPlatforms(st); if (st.devices.value.isEmpty()) loadDevices(st) }
    Column(Modifier.fillMaxSize().background(cs.background).verticalScroll(rememberScrollState()).padding(20.dp)) {
        Text("Settings", style = MaterialTheme.typography.headlineSmall)
        Text("Everything for this device and your account", color = cs.onSurfaceVariant, fontSize = 12.sp)
        Spacer(Modifier.height(16.dp))

        SectionD("☁  Account & sync") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(9.dp).clip(CircleShape).background(if (Cluster.connected) Brand else cs.onSurfaceVariant))
                Spacer(Modifier.width(8.dp))
                Text(if (Cluster.connected) "Cluster: connected ✓" else "Cluster: connecting…", color = cs.onSurface, fontSize = 13.sp)
            }
            Spacer(Modifier.height(6.dp))
            Text(Cluster.clusterUrl, color = cs.onSurfaceVariant, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
            Spacer(Modifier.height(10.dp))
            OutlinedButton(onClick = { loadPlatforms(st); loadDevices(st); loadFlows(st) }, shape = RoundedCornerShape(12.dp)) { Text("Re-sync now") }
            Note("Sign in on the Browser tab (my-app.engineer → open Ghost Browser from Tools). The node then auto-registers — one account, same data on every device.")
        }

        SectionD("👤  Profiles") {
            Text("Open a platform", color = cs.onSurfaceVariant, fontSize = 12.sp)
            Spacer(Modifier.height(6.dp))
            if (st.platforms.value.isEmpty()) Text("Load your platforms from the cluster.", color = cs.onSurfaceVariant, fontSize = 12.sp)
            else Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                st.platforms.value.forEach { p ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(cs.surfaceVariant).clickable { onOpenUrl(p.site) }.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(p.label, fontSize = 14.sp, modifier = Modifier.weight(1f)); Text("open", color = Brand, fontSize = 12.sp)
                    }
                }
            }
            TextButton(onClick = { loadPlatforms(st) }) { Text("Load platforms from cluster") }
        }

        SectionD("🖥  Devices & ring") {
            Text("This machine", color = cs.onSurfaceVariant, fontSize = 12.sp)
            Text("desktop · real Chromium (JCEF) · CDP", fontFamily = FontFamily.Monospace, fontSize = 12.sp)
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(st.hubSummary.value.ifBlank { "Connected devices" }, color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.weight(1f))
                TextButton(onClick = { loadDevices(st) }) { Text("Refresh") }
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                st.devices.value.forEach { d ->
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(cs.surfaceVariant).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(if (d.online) Brand else cs.onSurfaceVariant))
                        Spacer(Modifier.width(8.dp))
                        Text(d.name, fontSize = 13.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(d.type, color = cs.onSurfaceVariant, fontSize = 10.sp)
                    }
                }
            }
            TextButton(onClick = onOpenDevices) { Text("Open full Device Hub") }
        }

        SectionD("🛡  Network & exit") {
            Text("This desktop operates on its own machine network. The cluster GB keeps its own in-image exit node.", fontSize = 13.sp)
        }

        SectionD("🎨  Appearance") {
            Segmented(listOf("Dark", "Light"), if (st.dark.value) 0 else 1) { st.dark.value = it == 0 }
        }

        SectionD("📜  Activity") {
            Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
                Text(st.activity.value.ifBlank { "No activity yet." }, Modifier.heightIn(min = 60.dp, max = 200.dp).verticalScroll(rememberScrollState()).padding(12.dp), color = cs.onSurfaceVariant, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Note(text: String) { Spacer(Modifier.height(10.dp)); Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, lineHeight = 15.sp) }

@Composable
private fun Segmented(options: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).border(1.dp, cs.outline, RoundedCornerShape(12.dp))) {
        options.forEachIndexed { i, opt ->
            val on = i == selected
            Box(Modifier.weight(1f).background(if (on) Brand else androidx.compose.ui.graphics.Color.Transparent).clickable { onSelect(i) }.padding(vertical = 12.dp), contentAlignment = Alignment.Center) {
                Text(opt, color = if (on) BrandOn else cs.onSurface, fontSize = 13.sp)
            }
        }
    }
}

@Composable
private fun SectionD(title: String, content: @Composable ColumnScope.() -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(16.dp), border = androidx.compose.foundation.BorderStroke(1.dp, cs.outline), modifier = Modifier.fillMaxWidth().padding(bottom = 14.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(12.dp))
            content()
        }
    }
}
