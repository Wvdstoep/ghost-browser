package engineer.myapp.gb.shared

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
 * A watcher's collected results — schema-agnostic. Each item shows whatever fields it has plus a link,
 * and carries a "run a flow on this" control: pick one of your flows, and it runs on that item, its
 * action landing in Approvals. The interactive twin of the mobile HTML artifact, native on desktop.
 */
@Composable
fun ResultsScreen(
    watcherName: String,
    items: List<ResultItem>,
    flows: List<FlowInfo>,
    loading: Boolean,
    onRunFlow: (flowId: String, item: ResultItem) -> Unit,
    onOpenUrl: (String) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.fillMaxSize().background(cs.background)) {
        Row(Modifier.fillMaxWidth().background(cs.surface).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(watcherName, style = MaterialTheme.typography.titleLarge, color = cs.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(if (loading) "loading…" else "${items.size} item${if (items.size == 1) "" else "s"} collected", fontSize = 12.sp, color = cs.onSurfaceVariant, fontFamily = FontFamily.Monospace)
            }
            OutlinedButton(onClick = onClose, shape = RoundedCornerShape(9.dp)) { Text("Close", color = cs.onSurface) }
        }
        if (items.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(if (loading) "Loading results…" else "Nothing collected yet. When this watcher next runs and finds something, it appears here.",
                    color = cs.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(32.dp))
            }
        } else {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
                items.forEach { it -> ResultCard(it, flows, onRunFlow, onOpenUrl); Spacer(Modifier.height(12.dp)) }
            }
        }
    }
}

@Composable
private fun ResultCard(item: ResultItem, flows: List<FlowInfo>, onRunFlow: (String, ResultItem) -> Unit, onOpenUrl: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var picked by remember(item.title) { mutableStateOf<FlowInfo?>(null) }
    var status by remember(item.title) { mutableStateOf("") }

    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(cs.surface).border(1.dp, cs.outline, RoundedCornerShape(14.dp)).padding(14.dp)) {
        Text(item.kind.uppercase().ifBlank { "ITEM" }, color = Brand, fontSize = 10.sp, fontFamily = FontFamily.Monospace, letterSpacing = 1.sp)
        Text(item.title.ifBlank { "Untitled" }, style = MaterialTheme.typography.titleMedium, color = cs.onSurface)
        if (item.url.isNotBlank()) {
            Spacer(Modifier.height(2.dp))
            Text("Open ↗", color = Brand, fontSize = 13.sp, modifier = Modifier.clickable { onOpenUrl(item.url) })
        }
        if (item.fields.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(cs.background).padding(10.dp)) {
                item.fields.forEach { (k, v) ->
                    Row(Modifier.padding(vertical = 2.dp)) {
                        Text(k, color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.width(120.dp))
                        Text(v, color = cs.onSurface, fontSize = 12.sp, modifier = Modifier.weight(1f))
                    }
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { FlowPicker(picked, flows) { picked = it } }
            Spacer(Modifier.width(10.dp))
            Button(onClick = {
                val f = picked
                if (f == null) status = "Pick a flow first." else { onRunFlow(f.id, item); status = "Started ✓ — approve it in Approvals."; picked = null }
            }, shape = RoundedCornerShape(9.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Run") }
        }
        if (status.isNotBlank()) { Spacer(Modifier.height(6.dp)); Text(status, fontSize = 11.sp, color = cs.onSurfaceVariant) }
    }
}

@Composable
private fun FlowPicker(picked: FlowInfo?, flows: List<FlowInfo>, onPick: (FlowInfo) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var open by remember { mutableStateOf(false) }
    Box {
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(9.dp)).background(cs.surfaceVariant).clickable { open = true }.padding(horizontal = 12.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(picked?.name ?: "Run a flow on this…", color = if (picked == null) cs.onSurfaceVariant else cs.onSurface, fontSize = 13.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("▾", color = cs.onSurfaceVariant)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (flows.isEmpty()) DropdownMenuItem(text = { Text("No flows — create one first") }, onClick = { open = false })
            flows.forEach { f -> DropdownMenuItem(text = { Text(f.name) }, onClick = { onPick(f); open = false }) }
        }
    }
}
