package engineer.myapp.gbmobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import engineer.myapp.gbmobile.LocalRangeScanner
import engineer.myapp.gbmobile.RangeEvidence
import engineer.myapp.gbmobile.PublicRangePreset
import engineer.myapp.gbmobile.RangePlan
import engineer.myapp.gbmobile.ScanPorts
import kotlinx.coroutines.delay

@Composable
fun RangeScanDialog(scanner: LocalRangeScanner, onResults: () -> Unit, clusterForResearch: Boolean,
                    onResearch: (RangeEvidence, String?) -> Unit, onOpenApp: (RangeEvidence) -> Unit) {
    if (!scanner.open.value) return
    LaunchedEffect(scanner) {
        while (true) { scanner.refresh(); delay(1000) }
    }
    val cs = MaterialTheme.colorScheme
    var scope by remember { mutableStateOf(RangePlan.parse(scanner.selected.value)?.scope ?: RangePlan.Scope.PRIVATE) }
    var input by remember { mutableStateOf(scanner.selected.value) }
    var adding by remember { mutableStateOf(false) }
    var page by remember { mutableIntStateOf(if (scanner.focusEvidenceId.value > 0) 1 else 0) }
    LaunchedEffect(scanner.focusEvidenceId.value) {
        page = if (scanner.focusEvidenceId.value > 0) 1 else 0
    }
    var name by remember { mutableStateOf("") }
    var cidr by remember { mutableStateOf("") }
    val plan = RangePlan.parse(input)?.takeIf { it.scope == scope }
    val ports = if (scanner.portPreset.value == "Custom") ScanPorts.parseCustom(scanner.customPorts.value)
        else ScanPorts.presets[scanner.portPreset.value]
    val saved = plan != null && scanner.savedPublic.any { it.cidr == plan.cidr }
    val canStart = plan != null && ports != null && (scope == RangePlan.Scope.PRIVATE || saved) && !scanner.isRunning()
    LaunchedEffect(scanner, page) {
        if (page == 1) while (true) { scanner.refreshEvidence(); delay(1200) }
    }

    Dialog(onDismissRequest = { scanner.open.value = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxSize().background(cs.background).statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Surface(shape = RoundedCornerShape(14.dp), color = cs.primaryContainer, modifier = Modifier.size(48.dp)) {
                    Box(contentAlignment = Alignment.Center) { Icon(Icons.Default.Radar, null, tint = cs.onPrimaryContainer) }
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text("Protection workflow", style = MaterialTheme.typography.titleLarge)
                    Text("DISCOVER  ·  IDENTIFY  ·  REVIEW  ·  NOTIFY", style = MaterialTheme.typography.labelSmall, color = cs.primary)
                }
                IconButton(onClick = { scanner.open.value = false }) { Icon(Icons.Default.Close, "Close") }
            }
            HorizontalDivider(color = cs.outlineVariant)

            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 18.dp, vertical = 9.dp),
                horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                FilterChip(selected = page == 0, onClick = { page = 0 }, label = { Text("1  Configure scan") })
                FilterChip(selected = page == 1, onClick = { page = 1; scanner.refreshEvidence() }, label = { Text("2  Review evidence") })
            }

            if (page == 0) {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(18.dp)) {
                Text("Choose your scope", style = MaterialTheme.typography.headlineSmall)
                Text("Select one bounded IPv4 subnet for this run.", color = cs.onSurfaceVariant)
                Spacer(Modifier.height(16.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    ScopeTile("Local network", "Private subnets", Icons.Default.Wifi,
                        scope == RangePlan.Scope.PRIVATE, Modifier.weight(1f), !scanner.isRunning()) {
                        scope = RangePlan.Scope.PRIVATE
                        input = scanner.presets().firstOrNull()?.second ?: "192.168.1.0/24"
                    }
                    ScopeTile("Public range", "Saved scopes", Icons.Default.Public,
                        scope == RangePlan.Scope.PUBLIC, Modifier.weight(1f), !scanner.isRunning()) {
                        scope = RangePlan.Scope.PUBLIC
                        input = scanner.savedPublic.firstOrNull()?.cidr ?: ""
                    }
                }
                Spacer(Modifier.height(22.dp))

                SectionHeading(if (scope == RangePlan.Scope.PRIVATE) "LOCAL PRESETS" else "SAVED PUBLIC RANGES")
                Spacer(Modifier.height(10.dp))
                if (scope == RangePlan.Scope.PRIVATE) {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                        scanner.presets().forEach { (label, value) ->
                            PresetTile(label, value, input == value, !scanner.isRunning()) { input = value }
                        }
                    }
                } else {
                    if (scanner.savedPublic.isEmpty()) SectionSurface {
                        Text("No public ranges saved yet. Add a named CIDR to make it a one-tap preset.", color = cs.onSurfaceVariant)
                    }
                    else Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                        scanner.savedPublic.forEach { preset ->
                            PublicPresetTile(preset, input == preset.cidr, !scanner.isRunning(),
                                onSelect = { input = preset.cidr }, onDelete = {
                                    scanner.removePublicPreset(preset.cidr)
                                    if (input == preset.cidr) input = scanner.savedPublic.firstOrNull()?.cidr ?: ""
                                })
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    if (!adding) OutlinedButton(onClick = { adding = true }, enabled = !scanner.isRunning()) {
                        Icon(Icons.Default.Add, null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp)); Text("Add public range")
                    } else SectionSurface {
                        Text("New public preset", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(10.dp))
                        OutlinedTextField(name, { name = it }, label = { Text("Name") },
                            placeholder = { Text("My server range") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(cidr, { cidr = it }, label = { Text("Public IPv4 CIDR") },
                            placeholder = { Text("Address/24") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                            supportingText = { Text("/24 to /32 · up to 254 usable hosts") })
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = {
                                if (scanner.addPublicPreset(name, cidr)) {
                                    input = scanner.selected.value; name = ""; cidr = ""; adding = false
                                }
                            }, enabled = PublicRangePreset.create(name, cidr) != null) { Text("Save preset") }
                            TextButton(onClick = { adding = false }) { Text("Cancel") }
                        }
                    }
                }
                Spacer(Modifier.height(16.dp))
                SectionSurface {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.MyLocation, null, tint = cs.primary, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Target subnet", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                        if (plan != null) Text("${plan.hosts.size} hosts", color = cs.primary, style = MaterialTheme.typography.labelMedium)
                    }
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(input, { input = it }, enabled = !scanner.isRunning(),
                        label = { Text("IPv4 CIDR") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                        isError = input.isNotBlank() && plan == null,
                        supportingText = { Text(when {
                            plan == null -> "Enter a ${if (scope == RangePlan.Scope.PRIVATE) "private" else "public"} /24–/32 CIDR"
                            scope == RangePlan.Scope.PUBLIC && !saved -> "Save this range above before scanning"
                            else -> "One subnet per scan · network and broadcast excluded"
                        }) })
                }
                Spacer(Modifier.height(22.dp))

                SectionHeading("SERVICE PROFILE")
                Spacer(Modifier.height(10.dp))
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    (ScanPorts.presets.keys + "Custom").forEach { label ->
                        FilterChip(selected = scanner.portPreset.value == label, onClick = { scanner.portPreset.value = label },
                            enabled = !scanner.isRunning(), label = { Text(label) })
                    }
                }
                SectionSurface {
                    if (scanner.portPreset.value == "Custom") OutlinedTextField(scanner.customPorts.value,
                        { scanner.customPorts.value = it }, label = { Text("TCP ports") }, placeholder = { Text("22,80,443") },
                        supportingText = { Text("Comma-separated · up to 24 ports") },
                        isError = scanner.customPorts.value.isNotBlank() && ports == null,
                        enabled = !scanner.isRunning(), singleLine = true, modifier = Modifier.fillMaxWidth())
                    else {
                        Text("${ports?.size ?: 0} ports", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(3.dp))
                        Text(ports?.joinToString(" · ") ?: "", color = cs.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                    }
                }
                Spacer(Modifier.height(12.dp))
                SectionSurface {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Identify web services", style = MaterialTheme.typography.titleMedium)
                            Text("After an open web port is found, request its home page once and save the HTTP status, server header, and page title. No redirects or login attempts.",
                                color = cs.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                        }
                        Switch(checked = scanner.webFollowUp.value, onCheckedChange = { scanner.webFollowUp.value = it },
                            enabled = !scanner.isRunning())
                    }
                }
                Spacer(Modifier.height(22.dp))

                SectionHeading("CONNECTION RATE")
                Spacer(Modifier.height(10.dp))
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(2, 10, 25, 50).forEach { value ->
                        FilterChip(selected = scanner.rate.value == value, onClick = { scanner.rate.value = value },
                            enabled = !scanner.isRunning(), label = { Text("$value attempts/s") })
                    }
                }
                Spacer(Modifier.height(16.dp))
                SectionSurface {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(scanner.status.value, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                        Text("${scanner.progress.value}/${scanner.total.value}", color = cs.primary, style = MaterialTheme.typography.labelLarge)
                    }
                    Spacer(Modifier.height(10.dp))
                    LinearProgressIndicator(progress = { if (scanner.total.value == 0) 0f else scanner.progress.value.toFloat() / scanner.total.value },
                        modifier = Modifier.fillMaxWidth())
                    Spacer(Modifier.height(9.dp))
                    Text("${scanner.matches.value} hosts with open ports · Background notification; progress is saved if Android interrupts the job", color = cs.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall)
                }
                Spacer(Modifier.height(20.dp))
            }

            HorizontalDivider(color = cs.outlineVariant)
            Surface(color = cs.surface, shadowElevation = 8.dp) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                    OutlinedButton(onClick = { page = 1; scanner.refreshEvidence() }) { Text("Review") }
                    Spacer(Modifier.weight(1f))
                    if (scanner.isPaused()) {
                        OutlinedButton(onClick = scanner::stop) { Text("Stop") }
                        Button(onClick = scanner::pauseOrResume) { Text("Resume") }
                    } else if (scanner.isRunning()) {
                        OutlinedButton(onClick = scanner::stop) { Text("Stop") }
                        Button(onClick = scanner::pauseOrResume) { Text(if (scanner.isPaused()) "Resume" else "Pause") }
                    } else Button(onClick = { scanner.selected.value = input; scanner.start() }, enabled = canStart) {
                        Icon(Icons.Default.PlayArrow, null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(5.dp)); Text("Start scan")
                    }
                }
            }
            } else Box(Modifier.weight(1f)) {
                RangeReviewScreen(scanner, onHistory = { scanner.open.value = false; onResults() },
                    clusterForResearch = clusterForResearch, onResearch = onResearch, onOpenApp = onOpenApp)
            }
        }
    }
}

@Composable private fun SectionHeading(label: String) {
    Text(label, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
}

@Composable private fun SectionSurface(content: @Composable ColumnScope.() -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(shape = RoundedCornerShape(18.dp), color = cs.surface, border = BorderStroke(1.dp, cs.outlineVariant),
        modifier = Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), content = content) }
}

@Composable private fun ScopeTile(title: String, subtitle: String, icon: ImageVector, selected: Boolean,
    modifier: Modifier, enabled: Boolean, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(modifier = modifier.clickable(enabled = enabled, onClick = onClick), shape = RoundedCornerShape(18.dp),
        color = if (selected) cs.primaryContainer else cs.surface,
        border = BorderStroke(if (selected) 2.dp else 1.dp, if (selected) cs.primary else cs.outlineVariant)) {
        Column(Modifier.padding(14.dp)) {
            Icon(icon, null, tint = if (selected) cs.onPrimaryContainer else cs.onSurfaceVariant, modifier = Modifier.size(23.dp))
            Spacer(Modifier.height(12.dp))
            Text(title, style = MaterialTheme.typography.titleSmall, color = if (selected) cs.onPrimaryContainer else cs.onSurface)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = if (selected) cs.onPrimaryContainer else cs.onSurfaceVariant)
        }
    }
}

@Composable private fun PresetTile(name: String, cidr: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(modifier = Modifier.width(154.dp).clickable(enabled = enabled, onClick = onClick),
        shape = RoundedCornerShape(15.dp), color = if (selected) cs.primaryContainer else cs.surface,
        border = BorderStroke(if (selected) 2.dp else 1.dp, if (selected) cs.primary else cs.outlineVariant)) {
        Column(Modifier.padding(13.dp)) {
            Text(name, style = MaterialTheme.typography.titleSmall, color = if (selected) cs.onPrimaryContainer else cs.onSurface)
            Spacer(Modifier.height(4.dp))
            Text(cidr, style = MaterialTheme.typography.bodySmall, color = if (selected) cs.onPrimaryContainer else cs.onSurfaceVariant)
        }
    }
}

@Composable private fun PublicPresetTile(preset: PublicRangePreset, selected: Boolean, enabled: Boolean,
    onSelect: () -> Unit, onDelete: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(shape = RoundedCornerShape(15.dp), color = if (selected) cs.primaryContainer else cs.surface,
        border = BorderStroke(if (selected) 2.dp else 1.dp, if (selected) cs.primary else cs.outlineVariant)) {
        Row(Modifier.width(190.dp).heightIn(min = 76.dp).clickable(enabled = enabled, onClick = onSelect).padding(start = 13.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(preset.name, style = MaterialTheme.typography.titleSmall, color = if (selected) cs.onPrimaryContainer else cs.onSurface)
                Text(preset.cidr, style = MaterialTheme.typography.bodySmall, color = if (selected) cs.onPrimaryContainer else cs.onSurfaceVariant)
            }
            IconButton(onClick = onDelete, enabled = enabled) { Icon(Icons.Default.Close, "Remove ${preset.name}", modifier = Modifier.size(17.dp)) }
        }
    }
}
