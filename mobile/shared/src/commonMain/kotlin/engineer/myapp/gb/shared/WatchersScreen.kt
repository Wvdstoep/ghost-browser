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
    onSave: (id: String?, name: String, mode: String, role: String, goal: String, profile: String, automationId: String, intervalMin: Int) -> Unit,
    onToggle: (id: String, active: Boolean) -> Unit,
    onOpenResults: (id: String) -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    topInset: Modifier = Modifier,
) {
    val cs = MaterialTheme.colorScheme
    var formOpen by remember { mutableStateOf(false) }
    var editTarget by remember { mutableStateOf<Watcher?>(null) }

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

        if (formOpen) {
            WatcherForm(editTarget, roles, profiles, automations,
                onCancel = { formOpen = false; editTarget = null },
                onSave = { id, name, mode, role, goal, profile, autoId, iv -> onSave(id, name, mode, role, goal, profile, autoId, iv); formOpen = false; editTarget = null })
        } else {
            Button(onClick = { editTarget = null; formOpen = true }, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("+ New watcher", style = MaterialTheme.typography.labelLarge) }
        }
        Spacer(Modifier.height(18.dp))

        if (watchers.isEmpty()) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(cs.surface)
                .border(1.dp, cs.outline, RoundedCornerShape(14.dp)).padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("No watchers yet", style = MaterialTheme.typography.titleMedium, color = cs.onSurface)
                Spacer(Modifier.height(4.dp))
                Text("Create one to watch your notifications, a site, or leads — or run a saved automation — on a schedule, in the background.", style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
        } else {
            watchers.forEach { w -> WatcherCard(w, onToggle, onOpenResults, onEdit = { editTarget = w; formOpen = true }); Spacer(Modifier.height(10.dp)) }
        }
    }
}

@Composable
private fun WatcherForm(
    edit: Watcher?, roles: List<String>, profiles: List<String>, automations: List<FlowInfo>,
    onCancel: () -> Unit,
    onSave: (id: String?, name: String, mode: String, role: String, goal: String, profile: String, automationId: String, intervalMin: Int) -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    var name by remember { mutableStateOf(edit?.name ?: "") }
    var mode by remember { mutableStateOf(edit?.mode ?: "role") }        // role | automation
    var role by remember { mutableStateOf(edit?.role?.takeIf { it.isNotBlank() && it != "general" } ?: roles.firstOrNull { it != "(none)" } ?: "") }
    var goal by remember { mutableStateOf(edit?.goal ?: "") }
    var profile by remember { mutableStateOf(edit?.profile?.ifBlank { null } ?: profiles.firstOrNull() ?: "facebook") }
    var automationId by remember { mutableStateOf("") }
    var interval by remember { mutableStateOf(edit?.intervalMin ?: 5) }

    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(cs.surface).border(1.dp, cs.outline, RoundedCornerShape(14.dp)).padding(14.dp)) {
        Text(if (edit == null) "New watcher" else "Edit watcher", style = MaterialTheme.typography.titleMedium, color = cs.onSurface)
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp))
        Spacer(Modifier.height(12.dp))

        Text("WHAT SHOULD IT DO?", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = cs.onSurfaceVariant, letterSpacing = 1.sp)
        Spacer(Modifier.height(6.dp))
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).border(1.dp, cs.outline, RoundedCornerShape(10.dp))) {
            listOf("role" to "Watch with a role", "automation" to "Run an automation").forEach { (m, lbl) ->
                val on = mode == m
                Box(Modifier.weight(1f).background(if (on) Brand else Color.Transparent).clickable { mode = m }.padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
                    Text(lbl, color = if (on) BrandOn else cs.onSurface, fontSize = 12.sp)
                }
            }
        }
        Spacer(Modifier.height(12.dp))

        if (mode == "role") {
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
            listOf(1, 5, 10).forEach { m ->
                val on = interval == m
                Box(Modifier.weight(1f).background(if (on) Brand else Color.Transparent).clickable { interval = m }.padding(vertical = 11.dp), contentAlignment = Alignment.Center) {
                    Text("$m min", color = if (on) BrandOn else cs.onSurface, fontSize = 13.sp)
                }
            }
        }
        Spacer(Modifier.height(14.dp))
        val valid = name.isNotBlank() && (if (mode == "role") role.isNotBlank() else automationId.isNotBlank())
        Row {
            Button(onClick = { if (valid) onSave(edit?.id, name.trim(), mode, role, goal.trim(), profile, automationId, interval) }, enabled = valid,
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
                Text("$what · every ${w.intervalMin} min · ${w.profile}", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = cs.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Switch(checked = w.active, onCheckedChange = { onToggle(w.id, it) },
                colors = SwitchDefaults.colors(checkedThumbColor = BrandOn, checkedTrackColor = Brand))
        }
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.clip(RoundedCornerShape(50)).background(if (w.active) BrandSoft else cs.surfaceVariant).padding(horizontal = 9.dp, vertical = 3.dp)) {
                Text(if (w.active) "watching" else "paused", color = if (w.active) Brand else cs.onSurfaceVariant, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
            }
            Spacer(Modifier.width(8.dp))
            Text(w.lastRun, fontSize = 11.sp, color = cs.onSurfaceVariant, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            TextButton(onClick = onEdit) { Text("Edit", color = cs.onSurfaceVariant) }
            TextButton(onClick = { onOpenResults(w.id) }) { Text(if (w.resultCount > 0) "Results (${w.resultCount})" else "Results", color = Brand) }
        }
    }
}
