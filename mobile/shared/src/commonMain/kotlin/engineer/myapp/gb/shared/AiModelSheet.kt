package engineer.myapp.gb.shared

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * THE AI MODEL — one place, and it is Ghost Browser's own setting: the agent runs there, so the model
 * (and the key, kept there and never shown) is configured there. The app reads GET /v1/agent/settings,
 * lists what the host serves (POST /v1/agent/models), proves the trio works (POST /v1/agent/test) and
 * saves (PUT /v1/agent/settings). No model call ever leaves the phone or the desktop.
 */
class AiModelUi {
    val info = mutableStateOf<AiModelInfo?>(null)       // what the cluster has now
    val models = mutableStateOf<List<String>>(emptyList())
    val busy = mutableStateOf(false)
    val note = mutableStateOf("")                        // last outcome, one line
    val loading = mutableStateOf(false)
}

class AiModelActions(
    val onLoad: () -> Unit,
    val onList: (host: String, key: String) -> Unit,
    val onTest: (host: String, key: String, model: String) -> Unit,
    val onSave: (host: String, key: String, model: String) -> Unit,
)

@Composable
fun AiModelSheet(ui: AiModelUi, act: AiModelActions, connected: Boolean, onConnect: () -> Unit, onClose: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val info = ui.info.value
    var model by remember(info?.model) { mutableStateOf(info?.model ?: "") }
    var host by remember(info?.host) { mutableStateOf(info?.host ?: "") }
    var key by remember { mutableStateOf("") }
    var advanced by remember { mutableStateOf(false) }
    LaunchedEffect(connected) { if (connected) act.onLoad() }
    Box(Modifier.fillMaxSize().background(Color(0x99000000)).clickable { onClose() }, contentAlignment = Alignment.BottomCenter) {
        Surface(color = cs.surface, contentColor = cs.onSurface, shape = RoundedCornerShape(20.dp, 20.dp, 0.dp, 0.dp), tonalElevation = 6.dp,
            modifier = Modifier.fillMaxWidth().widthIn(max = 560.dp).clickable(enabled = false) {}) {
            Column(Modifier.padding(horizontal = 20.dp, vertical = 14.dp).verticalScroll(rememberScrollState())) {
                Box(Modifier.align(Alignment.CenterHorizontally).width(36.dp).height(4.dp).clip(CircleShape).background(cs.outline))
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("AI model", style = MaterialTheme.typography.titleLarge)
                        Text("The brain your agent runs on, inside your Ghost Browser.", color = cs.onSurfaceVariant, fontSize = 12.sp)
                    }
                    IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Close", tint = cs.onSurfaceVariant) }
                }
                Spacer(Modifier.height(14.dp))
                if (!connected) {
                    Text("Connect this device to your Ghost Browser first — the model is set there, once, for every device.", color = cs.onSurfaceVariant, fontSize = 13.sp, lineHeight = 18.sp)
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = onConnect, shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Connect") }
                    Spacer(Modifier.height(8.dp)); return@Column
                }
                // current
                Surface(color = cs.surfaceVariant.copy(alpha = 0.5f), shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("NOW", color = cs.onSurfaceVariant, fontSize = 10.sp, letterSpacing = 1.sp, fontWeight = FontWeight.SemiBold)
                            Text(info?.model?.ifBlank { "no model set" } ?: if (ui.loading.value) "loading…" else "no model set", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(hostLabel(info?.host ?: "") + (if (info?.keySet == true) " · key ${info.keyHint}" else " · no key") + (info?.keyState?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""), color = cs.onSurfaceVariant, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        if (ui.loading.value) CircularProgressIndicator(Modifier.size(16.dp), color = Brand, strokeWidth = 2.dp)
                    }
                }
                Spacer(Modifier.height(16.dp))
                // pick a model
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Choose a model", Modifier.weight(1f), fontWeight = FontWeight.Medium, fontSize = 14.sp)
                    if (ui.busy.value) CircularProgressIndicator(Modifier.size(15.dp), color = Brand, strokeWidth = 2.dp)
                    else TextButton(onClick = { act.onList(host, key) }, contentPadding = PaddingValues(horizontal = 8.dp)) { Text(if (ui.models.value.isEmpty()) "List models" else "Refresh", fontSize = 12.sp) }
                }
                if (ui.models.value.isNotEmpty()) {
                    Column(Modifier.fillMaxWidth().heightIn(max = 220.dp).verticalScroll(rememberScrollState()).border1(cs.outline.copy(alpha = 0.5f))) {
                        ui.models.value.forEach { m ->
                            val on = m == model
                            Row(Modifier.fillMaxWidth().clickable { model = m }.background(if (on) Brand.copy(alpha = 0.12f) else Color.Transparent).padding(horizontal = 12.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(m, Modifier.weight(1f), fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (on) Icon(Icons.Default.Check, null, tint = Brand, modifier = Modifier.size(16.dp))
                            }
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                }
                OutlinedTextField(model, { model = it }, label = { Text("Model name") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp))
                Spacer(Modifier.height(10.dp))
                // advanced: host + key (stored on the cluster)
                Row(Modifier.clickable { advanced = !advanced }, verticalAlignment = Alignment.CenterVertically) {
                    Icon(if (advanced) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(4.dp)); Text("Host & key", color = cs.onSurfaceVariant, fontSize = 13.sp)
                }
                if (advanced) {
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(host, { host = it }, label = { Text("Host (e.g. https://ollama.com)") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp))
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(key, { key = it }, label = { Text(if (info?.keySet == true) "API key (leave empty to keep ${info.keyHint})" else "API key") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), visualTransformation = PasswordVisualTransformation())
                    Text("Stored on your Ghost Browser only — never on this device.", color = cs.onSurfaceVariant, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
                }
                if (ui.note.value.isNotBlank()) { Spacer(Modifier.height(8.dp)); Text(ui.note.value, color = if (ui.note.value.startsWith("✓")) Brand else cs.onSurfaceVariant, fontSize = 12.sp) }
                Spacer(Modifier.height(14.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { act.onTest(host, key, model) }, enabled = model.isNotBlank() && !ui.busy.value, modifier = Modifier.weight(1f), shape = RoundedCornerShape(12.dp)) { Text("Test") }
                    Button(onClick = { act.onSave(host, key, model); onClose() }, enabled = model.isNotBlank(), modifier = Modifier.weight(1f), shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Save") }
                }
                Spacer(Modifier.height(8.dp))
            }
        }
    }
}

private fun hostLabel(h: String) = h.removePrefix("https://").removePrefix("http://").removeSuffix("/").ifBlank { "ollama.com" }

private fun Modifier.border1(c: Color) = this.border(BorderStroke(1.dp, c), RoundedCornerShape(10.dp))
