package engineer.myapp.gb.shared

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Catalog rules stay independent of Compose so search and status cannot drift between devices. */
internal object FlowCatalog {
    fun platform(f: FlowInfo): String {
        val p = f.profile.lowercase()
        val n = (f.name + " " + f.role).lowercase()
        return listOf("Facebook", "LinkedIn", "Google", "CapCut", "Reddit", "Useme", "Herald", "Probe")
            .firstOrNull { p.contains(it.lowercase()) || n.contains(it.lowercase()) }
            ?: f.profile.takeIf { it.isNotBlank() }?.replaceFirstChar { it.uppercase() }
            ?: "Other"
    }

    fun status(f: FlowInfo): String = when {
        f.lastStatus.contains("fail", true) || f.lastStatus.contains("error", true) -> "Needs attention"
        f.verified -> "Verified"
        f.runs == 0 -> "Never run"
        else -> f.lastStatus.ifBlank { "Ready" }.replaceFirstChar { it.uppercase() }
    }

    fun filter(flows: List<FlowInfo>, query: String, platform: String): List<FlowInfo> = flows.filter { f ->
        (platform == "All" || platform(f) == platform) &&
            (query.isBlank() || listOf(f.name, f.profile, f.role, f.sub).any { it.contains(query, true) })
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
    var query by remember { mutableStateOf("") }
    var platform by remember { mutableStateOf("All") }
    var selectedId by remember { mutableStateOf<String?>(null) }
    var building by remember { mutableStateOf(false) }
    val listScroll = rememberScrollState()
    LaunchedEffect(query, platform) { listScroll.scrollTo(0) }
    val platforms = listOf("All") + flows.map(FlowCatalog::platform).distinct().sorted()
    if (platform !in platforms) platform = "All"
    val visible = FlowCatalog.filter(flows, query, platform)
    val selected = visible.firstOrNull { it.id == selectedId } ?: visible.firstOrNull()

    BoxWithConstraints(modifier.background(cs.background)) {
        val wide = maxWidth >= 800.dp
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Automations", style = MaterialTheme.typography.headlineSmall, color = cs.onSurface)
                    Text("Browse, inspect and run your workflows", color = cs.onSurfaceVariant, fontSize = 12.sp)
                }
                IconButton(onClick = onLoad) { Icon(Icons.Default.Refresh, "Refresh automations", tint = cs.onSurfaceVariant) }
                Button(onClick = { building = !building; selectedId = null },
                    shape = RoundedCornerShape(11.dp), contentPadding = PaddingValues(horizontal = 13.dp, vertical = 8.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) {
                    Icon(Icons.Default.Add, null, modifier = Modifier.size(17.dp)); Spacer(Modifier.width(4.dp))
                    Text(if (building) "Catalog" else "Create")
                }
            }
            if (building) {
                FlowBuilder(onCreate = { name, steps -> onCreate(name, steps); building = false },
                    modifier = Modifier.weight(1f).fillMaxWidth())
                return@Column
            }
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FlowMetric("Workflows", "${flows.size}")
                FlowMetric("Verified", "${flows.count { it.verified }}")
                FlowMetric("Need attention", "${flows.count { FlowCatalog.status(it) == "Needs attention" }}")
            }
            Spacer(Modifier.height(12.dp))
            Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Search, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(9.dp))
                    BasicTextField(query, { query = it; selectedId = null }, singleLine = true,
                        modifier = Modifier.weight(1f), textStyle = TextStyle(color = cs.onSurface, fontSize = 14.sp),
                        cursorBrush = SolidColor(Brand),
                        decorationBox = { inner -> if (query.isEmpty()) Text("Search name, profile or role", color = cs.onSurfaceVariant, fontSize = 14.sp); inner() })
                }
            }
            Spacer(Modifier.height(9.dp))
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                platforms.forEach { p ->
                    val active = p == platform
                    Surface(color = if (active) Brand else cs.surfaceVariant, shape = RoundedCornerShape(9.dp),
                        modifier = Modifier.clip(RoundedCornerShape(9.dp)).clickable { platform = p; selectedId = null }) {
                        Text(p, color = if (active) BrandOn else cs.onSurface, fontSize = 12.sp,
                            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
            if (wide) {
                Row(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    FlowList(visible, selected?.id, listScroll, onSelect = { selectedId = it },
                        modifier = Modifier.width(336.dp).fillMaxHeight())
                    FlowDetails(selected, onRun, onBack = null, modifier = Modifier.weight(1f).fillMaxHeight())
                }
            } else if (selectedId != null && selected != null) {
                FlowDetails(selected, onRun, onBack = { selectedId = null }, modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp))
            } else {
                FlowList(visible, null, listScroll, onSelect = { selectedId = it },
                    modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp))
            }
        }
    }
}

@Composable
private fun FlowMetric(label: String, value: String) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(11.dp), border = BorderStroke(1.dp, cs.outline)) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(value, color = cs.onSurface, fontSize = 16.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.width(7.dp))
            Text(label, color = cs.onSurfaceVariant, fontSize = 11.sp)
        }
    }
}

@Composable
private fun FlowList(flows: List<FlowInfo>, selectedId: String?, scroll: ScrollState,
    onSelect: (String) -> Unit, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.verticalScroll(scroll), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        if (flows.isEmpty()) {
            Surface(color = cs.surface, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(20.dp)) {
                    Text("No matching automations", color = cs.onSurface, fontWeight = FontWeight.SemiBold)
                    Text("Try another search or create a workflow.", color = cs.onSurfaceVariant, fontSize = 12.sp)
                }
            }
        }
        flows.forEach { f ->
            val active = selectedId == f.id
            Surface(color = if (active) BrandSoft else cs.surface, shape = RoundedCornerShape(13.dp),
                border = BorderStroke(1.dp, if (active) Brand else cs.outline),
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(13.dp)).clickable { onSelect(f.id) }) {
                Row(Modifier.padding(horizontal = 13.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(if (FlowCatalog.status(f) == "Needs attention") cs.error else Brand))
                    Spacer(Modifier.width(11.dp))
                    Column(Modifier.weight(1f)) {
                        Text(f.name, color = cs.onSurface, fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${FlowCatalog.platform(f)} · ${f.steps} steps · ${FlowCatalog.status(f)}", color = cs.onSurfaceVariant,
                            fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Icon(Icons.Default.ChevronRight, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(18.dp))
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun FlowDetails(f: FlowInfo?, onRun: (String, String) -> Unit, onBack: (() -> Unit)?, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, cs.outline), modifier = modifier) {
        if (f == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Select an automation to see its setup and steps.", color = cs.onSurfaceVariant, fontSize = 13.sp)
            }
        } else Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
            if (onBack != null) {
                TextButton(onClick = onBack, contentPadding = PaddingValues(0.dp)) {
                    Icon(Icons.Default.ArrowBack, null, modifier = Modifier.size(17.dp)); Spacer(Modifier.width(5.dp)); Text("All automations")
                }
                Spacer(Modifier.height(6.dp))
            }
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(f.name, color = cs.onSurface, style = MaterialTheme.typography.titleLarge)
                    Text(FlowCatalog.platform(f), color = cs.onSurfaceVariant, fontSize = 12.sp)
                }
                StatusPill(FlowCatalog.status(f))
            }
            if (f.sub.isNotBlank()) { Spacer(Modifier.height(10.dp)); Text(f.sub, color = cs.onSurfaceVariant, fontSize = 13.sp) }
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                FlowFact("Profile", f.profile.ifBlank { "Default" }, Modifier.weight(1f))
                FlowFact("Role", f.role.ifBlank { "Not set" }, Modifier.weight(1f))
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                FlowFact("Runs", "${f.runs}", Modifier.weight(1f))
                FlowFact("Last result", f.lastStatus.ifBlank { if (f.runs == 0) "Never run" else "Unknown" }, Modifier.weight(1f))
            }
            Spacer(Modifier.height(18.dp))
            Button(onClick = { onRun(f.id, f.name) }, modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(11.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) {
                Text("Run automation")
            }
            Spacer(Modifier.height(20.dp))
            HorizontalDivider(color = cs.outline)
            Spacer(Modifier.height(16.dp))
            Text("Workflow · ${f.steps} steps", color = cs.onSurface, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(11.dp))
            if (f.goals.isEmpty()) Text("Step details are not available from this workflow.", color = cs.onSurfaceVariant, fontSize = 12.sp)
            f.goals.forEachIndexed { index, goal ->
                Row(Modifier.fillMaxWidth().padding(bottom = 11.dp), verticalAlignment = Alignment.Top) {
                    Surface(color = BrandSoft, shape = CircleShape) {
                        Box(Modifier.size(25.dp), contentAlignment = Alignment.Center) {
                            Text("${index + 1}", color = cs.secondary, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                    Spacer(Modifier.width(11.dp))
                    Text(goal, color = cs.onSurface, fontSize = 13.sp, lineHeight = 18.sp, modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun FlowFact(label: String, value: String, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(10.dp), modifier = modifier) {
        Column(Modifier.padding(10.dp)) {
            Text(label.uppercase(), color = cs.onSurfaceVariant, fontSize = 10.sp, letterSpacing = 0.6.sp)
            Text(value, color = cs.onSurface, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun StatusPill(status: String) {
    val cs = MaterialTheme.colorScheme
    val attention = status == "Needs attention"
    Surface(color = if (attention) cs.error.copy(alpha = 0.15f) else BrandSoft, shape = RoundedCornerShape(9.dp)) {
        Text(status, color = if (attention) cs.error else cs.secondary, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 6.dp))
    }
}

@Composable
private fun FlowBuilder(onCreate: (String, String) -> Unit, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    var name by remember { mutableStateOf("") }
    var steps by remember { mutableStateOf("") }
    Column(modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 6.dp)) {
        Surface(color = cs.surface, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, cs.outline),
            modifier = Modifier.widthIn(max = 720.dp).fillMaxWidth()) {
            Column(Modifier.padding(18.dp)) {
                Text("New automation", style = MaterialTheme.typography.titleLarge, color = cs.onSurface)
                Text("Start manually, then let the agent work through each goal in order.",
                    color = cs.onSurfaceVariant, fontSize = 12.sp)
                Spacer(Modifier.height(16.dp))
                OutlinedTextField(name, { name = it }, label = { Text("Automation name") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(steps, { steps = it }, label = { Text("Goals · one per line") },
                    supportingText = { Text("${steps.lines().count { it.isNotBlank() }} agent steps") },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 160.dp))
                Spacer(Modifier.height(12.dp))
                Button(onClick = { onCreate(name.trim(), steps) },
                    enabled = name.isNotBlank() && steps.lines().any { it.isNotBlank() },
                    shape = RoundedCornerShape(11.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) {
                    Text("Create automation")
                }
            }
        }
    }
}
