package engineer.myapp.gb.shared

import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * S9 — ONE Automations screen shared by phone and desktop: search, grouped by platform, each flow
 * expandable to its full detail (profile/role/runs/verified + step goals), and a collapsible build
 * panel. Both platforms feed it the same [FlowInfo] list + callbacks.
 */
private fun groupOf(f: FlowInfo): String {
    val p = f.profile.lowercase(); val n = (f.name + " " + f.role).lowercase()
    return when {
        p.contains("facebook") || n.contains("facebook") -> "Facebook"
        p.contains("linkedin") || n.contains("linkedin") -> "LinkedIn"
        p.contains("google") || n.contains("google") -> "Google"
        p.contains("capcut") || n.contains("capcut") -> "CapCut"
        p.contains("reddit") || n.contains("reddit") -> "Reddit"
        p.contains("useme") || n.contains("useme") -> "Useme"
        p.contains("herald") || n.contains("herald") -> "Herald"
        p.contains("probe") || n.contains("probe") -> "Probe"
        f.profile.isNotBlank() -> f.profile.replaceFirstChar { it.uppercase() }
        else -> "Other"
    }
}

@Composable
fun FlowsScreen(
    flows: List<FlowInfo>,
    onLoad: () -> Unit,
    onRun: (String, String) -> Unit,
    onCreate: (String, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val cs = MaterialTheme.colorScheme
    var q by remember { mutableStateOf("") }
    var showBuild by remember { mutableStateOf(false) }
    val all = flows.filter { q.isBlank() || it.name.contains(q, true) || it.profile.contains(q, true) || it.role.contains(q, true) }
    val groups = all.groupBy { groupOf(it) }.toList().sortedByDescending { it.second.size }
    Column(modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Automations", style = MaterialTheme.typography.headlineSmall)
                Text("${flows.size} flows · ${groups.size} groups", color = cs.onSurfaceVariant, fontSize = 12.sp)
            }
            TextButton(onClick = onLoad) { Text("Reload") }
        }
        Spacer(Modifier.height(10.dp))
        Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
            Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Search, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(18.dp)); Spacer(Modifier.width(10.dp))
                BasicTextField(q, { q = it }, singleLine = true, modifier = Modifier.weight(1f),
                    textStyle = TextStyle(color = cs.onSurface, fontSize = 15.sp), cursorBrush = SolidColor(Brand),
                    decorationBox = { inner -> if (q.isEmpty()) Text("Search automations", color = cs.onSurfaceVariant, fontSize = 15.sp); inner() })
            }
        }
        Spacer(Modifier.height(12.dp))
        if (flows.isEmpty()) Text("No automations yet — Reload, or build one below.", color = cs.onSurfaceVariant, fontSize = 13.sp)
        groups.forEach { (group, gf) -> FlowGroup(group, gf, onRun) }

        Spacer(Modifier.height(20.dp)); HorizontalDivider(color = cs.outline); Spacer(Modifier.height(12.dp))
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { showBuild = !showBuild }) {
            Text("Build a new automation", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            Icon(if (showBuild) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null, tint = cs.onSurfaceVariant)
        }
        if (showBuild) {
            Spacer(Modifier.height(8.dp))
            var name by remember { mutableStateOf("") }
            var steps by remember { mutableStateOf("") }
            Text("A manual trigger + one agent step per line, chained for you.", color = cs.onSurfaceVariant, fontSize = 11.sp)
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(steps, { steps = it }, label = { Text("Steps — one goal per line") }, modifier = Modifier.fillMaxWidth().height(140.dp))
            Spacer(Modifier.height(10.dp))
            Button(onClick = { if (name.isNotBlank() && steps.isNotBlank()) { onCreate(name, steps); name = ""; steps = "" } },
                shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Create on cluster") }
        }
        Spacer(Modifier.height(28.dp))
    }
}

@Composable
private fun FlowGroup(group: String, flows: List<FlowInfo>, onRun: (String, String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var open by remember { mutableStateOf(false) }
    Column(Modifier.padding(bottom = 10.dp)) {
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(cs.surfaceVariant).clickable { open = !open }.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(group, color = cs.onSurface, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text("${flows.size}", color = cs.onSurfaceVariant, fontSize = 13.sp); Spacer(Modifier.width(8.dp))
            Icon(if (open) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null, tint = cs.onSurfaceVariant)
        }
        if (open) Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            flows.forEach { f -> FlowCard(f) { onRun(f.id, f.name) } }
        }
    }
}

@Composable
private fun FlowCard(f: FlowInfo, onRun: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    var open by remember { mutableStateOf(false) }
    Surface(color = cs.surface, shape = RoundedCornerShape(14.dp),
        border = BorderStroke(1.dp, if (f.verified) Brand else cs.outline), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).clickable { open = !open }) {
                    Text(f.name, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${f.steps} step(s) · ${f.sub}", color = cs.onSurfaceVariant, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Spacer(Modifier.width(8.dp))
                Icon(if (open) Icons.Default.ExpandLess else Icons.Default.ExpandMore, "Details", tint = cs.onSurfaceVariant, modifier = Modifier.clickable { open = !open })
                Spacer(Modifier.width(6.dp))
                Button(onClick = onRun, shape = RoundedCornerShape(10.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Run") }
            }
            if (open) {
                Spacer(Modifier.height(10.dp)); HorizontalDivider(color = cs.outline); Spacer(Modifier.height(10.dp))
                if (f.profile.isNotBlank()) DetailRow("Profile", f.profile)
                if (f.role.isNotBlank()) DetailRow("Role", f.role)
                DetailRow("Runs", if (f.runs > 0) "${f.runs} · last ${f.lastStatus.ifBlank { "?" }}" else "never run")
                if (f.verified) DetailRow("Verified", "✓ last run verified")
                if (f.goals.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp)); Text("Steps", color = cs.onSurfaceVariant, fontSize = 11.sp); Spacer(Modifier.height(4.dp))
                    f.goals.forEachIndexed { i, g -> Text("${i + 1}. $g", color = cs.onSurface, fontSize = 12.sp, lineHeight = 17.sp, modifier = Modifier.padding(bottom = 3.dp)) }
                }
            }
        }
    }
}

@Composable
private fun DetailRow(k: String, v: String) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.padding(bottom = 4.dp)) {
        Text(k, color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.width(64.dp))
        Text(v, color = cs.onSurface, fontSize = 12.sp, modifier = Modifier.weight(1f))
    }
}
