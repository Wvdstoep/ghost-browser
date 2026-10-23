package engineer.myapp.gb.shared

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
 * Watchers — background tasks that run on a schedule (1/5/10 min) on the always-on cluster, so they
 * keep working even when the app is closed. A watcher does one of two things each tick:
 *   • WATCH with a role + a goal (gather items), or
 *   • RUN a saved automation (a multi-step flow).
 * Either way its collected items land in the Results view (viewable/exportable) and any action it
 * wants to take waits in Approvals. Phone and desktop share this screen.
 */
@Composable
fun WatchersScreen(
    watchers: List<Watcher>,
    roles: List<String>,
    profiles: List<String>,
    automations: List<FlowInfo>,
    loading: Boolean,
    onSave: (id: String?, name: String, mode: String, role: String, goal: String, profile: String, automationId: String, intervalMin: Int, followUpFlowId: String, followUpRepliesOnly: Boolean) -> Unit,
    onToggle: (id: String, active: Boolean) -> Unit,
    onOpenResults: (id: String) -> Unit,
    onRefresh: () -> Unit,
    securitySync: Boolean = false,
    onSecuritySync: (Boolean) -> Unit = {},
    showSecuritySync: Boolean = false,
    modifier: Modifier = Modifier,
    topInset: Modifier = Modifier,
) {
    val cs = MaterialTheme.colorScheme
    var formOpen by remember { mutableStateOf(false) }
    var editTarget by remember { mutableStateOf<Watcher?>(null) }
    var kind by remember { mutableStateOf("browser") }
    val scopedWatchers = watchers.filter { it.kind == kind }
    val scopedAutomations = automations.filter { it.kind == kind && (kind != "security" || it.goals.none { goal -> goal.startsWith("prompt:") }) }

    Column(modifier.fillMaxSize().background(cs.background).then(topInset).verticalScroll(rememberScrollState())
        .padding(start = 16.dp, end = 16.dp, bottom = 24.dp, top = 14.dp)) {

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Watchers", style = MaterialTheme.typography.headlineSmall, color = cs.onSurface)
                Text("Background tasks that keep running even when the app is closed", style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
            TextButton(onClick = onRefresh) { Text(if (loading) "…" else "Refresh", color = Brand) }
        }
        Spacer(Modifier.height(14.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("browser" to "Browser", "security" to "Security Recon").forEach { (value, label) ->
                FilterChip(selected = kind == value, onClick = { kind = value; formOpen = false; editTarget = null }, label = { Text(label) })
            }
        }
        Spacer(Modifier.height(12.dp))

        if (kind == "security" && showSecuritySync) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Share new recon watchers with cluster", color = cs.onSurface, fontSize = 13.sp)
                    Text(if (securitySync) "Phone schedule stays active; a cluster copy is uploaded" else "Runs and results stay on this phone", color = cs.onSurfaceVariant, fontSize = 11.sp)
                }
                Switch(checked = securitySync, onCheckedChange = onSecuritySync)
            }
            Spacer(Modifier.height(12.dp))
        }

        if (formOpen) {
            WatcherForm(editTarget, kind, roles, profiles, scopedAutomations,
                onCancel = { formOpen = false; editTarget = null },
                onSave = { id, name, mode, role, goal, profile, autoId, iv, fuFlow, fuReplies -> onSave(id, name, mode, role, goal, profile, autoId, iv, fuFlow, fuReplies); formOpen = false; editTarget = null })
        } else {
            Button(onClick = { editTarget = null; formOpen = true }, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("+ New watcher", style = MaterialTheme.typography.labelLarge) }
        }
        Spacer(Modifier.height(18.dp))

        if (scopedWatchers.isEmpty()) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(cs.surface)
                .border(1.dp, cs.outline, RoundedCornerShape(14.dp)).padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("No watchers yet", style = MaterialTheme.typography.titleMedium, color = cs.onSurface)
                Spacer(Modifier.height(4.dp))
                Text("Create one to watch your notifications, a site, or leads — or run a saved automation — on a schedule, in the background.", style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
        } else {
            scopedWatchers.forEach { w -> WatcherCard(w, onToggle, onOpenResults, onEdit = { editTarget = w; formOpen = true }); Spacer(Modifier.height(10.dp)) }
        }
    }
}

@Composable
private fun WatcherForm(
    edit: Watcher?, kind: String, roles: List<String>, profiles: List<String>, automations: List<FlowInfo>,
    onCancel: () -> Unit,
    onSave: (id: String?, name: String, mode: String, role: String, goal: String, profile: String, automationId: String, intervalMin: Int, followUpFlowId: String, followUpRepliesOnly: Boolean) -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    var name by remember { mutableStateOf(edit?.name ?: "") }
    var mode by remember(edit?.id, kind) { mutableStateOf(edit?.mode ?: if (kind == "security") "security" else "role") }
    var role by remember { mutableStateOf(edit?.role?.takeIf { it.isNotBlank() && it != "general" } ?: roles.firstOrNull { it != "(none)" } ?: "") }
    var goal by remember { mutableStateOf(edit?.goal ?: "") }
    var securityScan by remember { mutableStateOf(edit?.role?.takeIf { it in listOf("exposure", "perimeter") } ?: "exposure") }
    var profile by remember { mutableStateOf(edit?.profile?.ifBlank { null } ?: profiles.firstOrNull() ?: "facebook") }
    var automationId by remember { mutableStateOf("") }
    var interval by remember { mutableStateOf(edit?.intervalMin ?: if (kind == "security") 60 else 5) }
    // Routing: each notification kind → its own flow. Older single-flow configs arrive as one route.
    var routes by remember {
        mutableStateOf(
            edit?.followUps?.takeIf { it.isNotEmpty() }
                ?: edit?.followUpFlowId?.takeIf { it.isNotBlank() }?.let { listOf(FollowUpRoute(if (edit.followUpRepliesOnly) listOf("reply", "comment", "mention") else emptyList(), it)) }
                ?: emptyList()
        )
    }

    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(cs.surface).border(1.dp, cs.outline, RoundedCornerShape(14.dp)).padding(14.dp)) {
        Text(if (edit == null) "New watcher" else "Edit watcher", style = MaterialTheme.typography.titleMedium, color = cs.onSurface)
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp))
        Spacer(Modifier.height(12.dp))

        Text("WHAT SHOULD IT DO?", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = cs.onSurfaceVariant, letterSpacing = 1.sp)
        Spacer(Modifier.height(6.dp))
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).border(1.dp, cs.outline, RoundedCornerShape(10.dp))) {
            (if (kind == "security") listOf("security" to "Run a recon scan", "automation" to "Run an automation") else listOf("role" to "Watch with a role", "automation" to "Run an automation")).forEach { (m, lbl) ->
                val on = mode == m
                Box(Modifier.weight(1f).background(if (on) Brand else Color.Transparent).clickable { mode = m }.padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
                    Text(lbl, color = if (on) BrandOn else cs.onSurface, fontSize = 12.sp)
                }
            }
        }
        Spacer(Modifier.height(12.dp))

        if (mode == "security") {
            Text("TARGET", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = cs.onSurfaceVariant)
            Spacer(Modifier.height(6.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("exposure" to "Port to Proof", "perimeter" to "Perimeter").forEach { (value, label) ->
                    FilterChip(selected = securityScan == value, onClick = { securityScan = value }, label = { Text(label) })
                }
            }
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(goal, { goal = it }, label = { Text("HTTP(S) target") }, placeholder = { Text("https://example.com") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        } else if (mode == "role") {
            Text("ROLE", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = cs.onSurfaceVariant, letterSpacing = 1.sp)
            Spacer(Modifier.height(6.dp))
            PickerField(role.ifBlank { "Pick a role" }, roles.filter { it != "(none)" }) { role = it }
            Spacer(Modifier.height(10.dp))
            Text("GOAL — what specifically to do (optional; the role has its own default)", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = cs.onSurfaceVariant, letterSpacing = 0.5.sp)
            Spacer(Modifier.height(6.dp))
            OutlinedTextField(value = goal, onValueChange = { goal = it }, modifier = Modifier.fillMaxWidth().heightIn(min = 70.dp),
                placeholder = { Text("e.g. check my notifications and collect every reaction & comment on my posts", fontSize = 13.sp) }, minLines = 2, shape = RoundedCornerShape(10.dp))
            Spacer(Modifier.height(10.dp))
            Text("PROFILE — the login it runs as", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = cs.onSurfaceVariant, letterSpacing = 0.5.sp)
            Spacer(Modifier.height(6.dp))
            PickerField(profile.ifBlank { "Pick a profile" }, profiles) { profile = it }
        } else {
            Text("AUTOMATION — a saved flow to run each time", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = cs.onSurfaceVariant, letterSpacing = 0.5.sp)
            Spacer(Modifier.height(6.dp))
            val autoLabel = automations.firstOrNull { it.id == automationId }?.name ?: "Pick an automation"
            PickerField(autoLabel, automations.map { it.name }) { picked -> automationId = automations.firstOrNull { it.name == picked }?.id ?: "" }
            if (automations.isEmpty()) { Spacer(Modifier.height(6.dp)); Text("No automations yet — create one in the Automations tab first.", fontSize = 11.sp, color = cs.onSurfaceVariant) }
        }

        Spacer(Modifier.height(12.dp))
        Text("CHECK EVERY", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = cs.onSurfaceVariant, letterSpacing = 1.sp)
        Spacer(Modifier.height(6.dp))
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).border(1.dp, cs.outline, RoundedCornerShape(10.dp))) {
            (if (kind == "security") listOf(15, 60, 360, 1440) else listOf(1, 5, 10, 15)).forEach { m ->
                val on = interval == m
                Box(Modifier.weight(1f).background(if (on) Brand else Color.Transparent).clickable { interval = m }.padding(vertical = 11.dp), contentAlignment = Alignment.Center) {
                    Text(if (m >= 1440) "${m / 1440} d" else if (m >= 60) "${m / 60} h" else "$m min", color = if (on) BrandOn else cs.onSurface, fontSize = 13.sp)
                }
            }
        }
        if (kind == "browser") {
        // Routing — the engine: each kind of notification this watcher collects goes to its own flow.
        Spacer(Modifier.height(14.dp))
        Text("ROUTING — what happens to each kind of item", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = cs.onSurfaceVariant, letterSpacing = 1.sp)
        Text("Pick the kinds, then the flow that runs on them. No kinds = every kind. First matching route wins.", fontSize = 11.sp, color = cs.onSurfaceVariant)
        // DEFAULT ROUTES as toggles (roadmap Phase 2): one tap wires a kind to the flow that ships for it.
        Spacer(Modifier.height(8.dp))
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            DEFAULT_ROUTES.forEach { d ->
                val flowKnown = automations.any { it.id == d.flowId }
                val on = routes.any { it.flowId == d.flowId && d.kinds.all { k -> k in it.kinds } }
                Box(Modifier.padding(end = 6.dp).clip(RoundedCornerShape(50)).background(if (on) Brand.copy(alpha = 0.16f) else Color.Transparent).border(1.dp, if (on) Brand else cs.outline, RoundedCornerShape(50))
                    .clickable(enabled = flowKnown) { routes = if (on) routes.filterNot { it.flowId == d.flowId } else routes + FollowUpRoute(d.kinds, d.flowId) }
                    .padding(horizontal = 10.dp, vertical = 5.dp)) {
                    Text((if (on) "✓ " else "") + d.label + (if (!flowKnown) " (flow missing)" else ""), color = if (!flowKnown) cs.onSurfaceVariant else if (on) Brand else cs.onSurface, fontSize = 11.sp)
                }
            }
        }
        routes.forEachIndexed { idx, r ->
            Spacer(Modifier.height(8.dp))
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(cs.background).border(1.dp, cs.outline, RoundedCornerShape(10.dp)).padding(10.dp)) {
                // kinds as toggle chips
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                    FOLLOW_UP_KINDS.forEach { k ->
                        val on = k in r.kinds
                        Box(Modifier.padding(end = 6.dp).clip(RoundedCornerShape(50)).background(if (on) Brand else Color.Transparent).border(1.dp, if (on) Brand else cs.outline, RoundedCornerShape(50))
                            .clickable { routes = routes.toMutableList().also { it[idx] = r.copy(kinds = if (on) r.kinds - k else r.kinds + k) } }
                            .padding(horizontal = 10.dp, vertical = 5.dp)) { Text(k, color = if (on) BrandOn else cs.onSurface, fontSize = 11.sp) }
                    }
                }
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) {
                        val lbl = automations.firstOrNull { it.id == r.flowId }?.name ?: "Pick the flow to run"
                        PickerField(lbl, automations.map { it.name }) { picked -> routes = routes.toMutableList().also { it[idx] = r.copy(flowId = automations.firstOrNull { a -> a.name == picked }?.id ?: "") } }
                    }
                    Spacer(Modifier.width(8.dp))
                    OutlinedButton(onClick = { routes = routes.filterIndexed { i, _ -> i != idx } }, shape = RoundedCornerShape(9.dp)) { Text("✕", color = cs.error) }
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = { routes = routes + FollowUpRoute(emptyList(), "") }, shape = RoundedCornerShape(9.dp)) { Text(if (routes.isEmpty()) "+ Add a route (e.g. replies → draft a reply)" else "+ Add another route", color = cs.onSurface) }
        Spacer(Modifier.height(14.dp))
        }
        val valid = name.isNotBlank() && when (mode) { "role" -> role.isNotBlank(); "security" -> goal.startsWith("http://") || goal.startsWith("https://"); else -> automationId.isNotBlank() }
        Row {
            // Routes travel in the legacy followUpFlowId slot as JSON (starts with "[") — the platforms send them as `followUps`.
            Button(onClick = { if (valid) onSave(edit?.id, name.trim(), mode, if (mode == "security") securityScan else role, goal.trim(), profile, automationId, interval, if (kind == "security") "" else routesToJson(routes).takeIf { it != "[]" } ?: "", false) }, enabled = valid,
                modifier = Modifier.weight(1f).height(46.dp), shape = RoundedCornerShape(10.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text(if (edit == null) "Create watcher" else "Save changes", style = MaterialTheme.typography.labelLarge) }
            Spacer(Modifier.width(10.dp))
            OutlinedButton(onClick = onCancel, modifier = Modifier.height(46.dp), shape = RoundedCornerShape(10.dp)) { Text("Cancel", color = cs.onSurfaceVariant) }
        }
    }
}

@Composable
private fun PickerField(current: String, options: List<String>, onPick: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var open by remember { mutableStateOf(false) }
    Box {
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(cs.surfaceVariant).clickable { open = true }.padding(horizontal = 13.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(current, color = cs.onSurface, fontSize = 14.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("▾", color = cs.onSurfaceVariant)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { o -> DropdownMenuItem(text = { Text(o) }, onClick = { onPick(o); open = false }) }
        }
    }
}

@Composable
private fun WatcherCard(w: Watcher, onToggle: (String, Boolean) -> Unit, onOpenResults: (String) -> Unit, onEdit: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(cs.surface).border(1.dp, if (w.active) Brand else cs.outline, RoundedCornerShape(14.dp)).padding(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(w.name, style = MaterialTheme.typography.titleMedium, color = cs.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val what = if (w.mode == "automation") "automation · ${w.stepCount} steps" else w.role
                Text(if (w.kind == "security") "$what · every ${w.intervalMin} min · ${w.goal}" else "$what · every ${w.intervalMin} min · ${w.profile}", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = cs.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Switch(checked = w.active, onCheckedChange = { onToggle(w.id, it) },
                colors = SwitchDefaults.colors(checkedThumbColor = BrandOn, checkedTrackColor = Brand))
        }
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            // Pass state as form: running / watching / paused / QUIET (active but no pass for too long).
            val chip = when { w.running -> "running"; w.stale -> "quiet — no pass"; w.active -> "watching"; else -> "paused" }
            val chipBg = when { w.stale -> cs.errorContainer; w.active || w.running -> BrandSoft; else -> cs.surfaceVariant }
            val chipFg = when { w.stale -> cs.error; w.active || w.running -> Brand; else -> cs.onSurfaceVariant }
            Box(Modifier.clip(RoundedCornerShape(50)).background(chipBg).padding(horizontal = 9.dp, vertical = 3.dp)) {
                Text(chip, color = chipFg, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
            }
            Spacer(Modifier.width(8.dp))
            Text(w.lastRun, fontSize = 11.sp, color = cs.onSurfaceVariant, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            TextButton(onClick = onEdit) { Text("Edit", color = cs.onSurfaceVariant) }
            TextButton(onClick = { onOpenResults(w.id) }) { Text(if (w.resultCount > 0) "Results (${w.resultCount})" else "Results", color = Brand) }
        }
        // The last pass in one line — what it read, verified, corrected, drafted, and any error. A
        // watcher that says nothing here has done nothing, and that is visible.
        if (w.health.isNotBlank()) {
            Spacer(Modifier.height(6.dp))
            Text(w.health, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = if (w.stale || w.health.contains("error")) cs.error else cs.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}
