package engineer.myapp.gb.shared

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * S9 — ONE Run sheet for phone and desktop: pick WHERE to run (live device list + Cluster + Auto),
 * enter the goal, run, watch progress. [DeviceOpt] lives in shared Models.
 */
@Composable
fun RunSheet(
    visible: Boolean,
    flowName: String?,
    devices: List<DeviceOpt>,
    phase: String,          // "pick" | "running" | "done"
    status: String,
    goalInitial: String,
    onRun: (targetId: String, goal: String) -> Unit,
    onStop: () -> Unit,
    onClose: () -> Unit,
) {
    if (!visible) return
    val cs = MaterialTheme.colorScheme
    var selected by remember(visible) { mutableStateOf(devices.firstOrNull { it.online }?.id ?: "cluster") }
    var goal by remember(visible) { mutableStateOf(goalInitial) }

    Box(Modifier.fillMaxSize().background(Color(0xB3000000)).clickable(enabled = phase != "running") { onClose() }, contentAlignment = Alignment.BottomCenter) {
        Surface(color = cs.surface, contentColor = cs.onSurface, shape = RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp), tonalElevation = 3.dp,
            modifier = Modifier.fillMaxWidth().clickable(enabled = false) {}) {
            Column(Modifier.padding(20.dp).verticalScroll(rememberScrollState())) {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Box(Modifier.width(38.dp).height(4.dp).background(cs.outline, RoundedCornerShape(4.dp)))
                }
                Spacer(Modifier.height(16.dp))
                Text(if (phase == "pick") "Run a flow" else flowName ?: "Running", style = MaterialTheme.typography.headlineSmall, color = cs.onSurface)
                if (flowName != null && phase == "pick") { Spacer(Modifier.height(4.dp)); Text("flow · $flowName", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = cs.onSurfaceVariant) }
                Spacer(Modifier.height(18.dp))
                if (phase == "pick") {
                    Text("WHERE SHOULD THIS RUN?", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = cs.onSurfaceVariant, letterSpacing = 1.5.sp)
                    Spacer(Modifier.height(10.dp))
                    devices.forEach { d -> DeviceRow(d, d.id == selected) { if (d.online) selected = d.id }; Spacer(Modifier.height(8.dp)) }
                    Spacer(Modifier.height(10.dp))
                    Text("WHAT SHOULD IT DO?", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = cs.onSurfaceVariant, letterSpacing = 1.5.sp)
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(value = goal, onValueChange = { goal = it }, modifier = Modifier.fillMaxWidth().heightIn(min = 88.dp),
                        placeholder = { Text("Describe the goal, or leave as the flow's own goal…") }, minLines = 3,
                        keyboardOptions = KeyboardOptions.Default, shape = RoundedCornerShape(12.dp))
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = { onRun(selected, goal) }, modifier = Modifier.fillMaxWidth().height(50.dp), shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) {
                        val where = devices.firstOrNull { it.id == selected }?.name ?: "selected device"
                        Text("Run on $where", style = MaterialTheme.typography.labelLarge)
                    }
                    Spacer(Modifier.height(8.dp))
                } else {
                    if (phase == "running") {
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(6.dp)), color = Brand, trackColor = cs.surfaceVariant)
                        Spacer(Modifier.height(14.dp))
                    }
                    Text(status.ifBlank { if (phase == "running") "Working…" else "Done." }, style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
                    Spacer(Modifier.height(18.dp))
                    if (phase == "running") {
                        OutlinedButton(onClick = onStop, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(12.dp)) { Text("Stop", style = MaterialTheme.typography.labelLarge, color = cs.error) }
                        Spacer(Modifier.height(8.dp))
                    }
                    if (phase == "done") {
                        Button(onClick = onClose, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(12.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Done", style = MaterialTheme.typography.labelLarge) }
                        Spacer(Modifier.height(8.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun DeviceRow(d: DeviceOpt, sel: Boolean, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (sel) BrandSoft else cs.surfaceVariant)
        .border(1.dp, if (sel) Brand else cs.outline, RoundedCornerShape(12.dp)).clickable(enabled = d.online) { onClick() }
        .padding(horizontal = 13.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(d.emoji, fontSize = 18.sp)
        Spacer(Modifier.width(11.dp))
        Column(Modifier.weight(1f)) {
            Text(d.name, style = MaterialTheme.typography.titleMedium, color = if (d.online) cs.onSurface else cs.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(d.sub, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = cs.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text(if (d.online) "online" else "offline", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = if (d.online) Brand else cs.onSurfaceVariant)
    }
}
