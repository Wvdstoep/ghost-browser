package engineer.myapp.gbmobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
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
 * S5 — the redesigned settings, in Compose. Replaces the old bottom-sheet "chaos" with six structured
 * sections (Account & sync · Profiles · Devices & ring · Automations & roles · Network & exit ·
 * Appearance). Every value is a reactive [SettingsUi] MutableState the Activity keeps in sync; every
 * action is a lambda in [SettingsActions]. The old view-based panel stays until S6 reaches full parity.
 */

/** Reactive state the Activity updates; the screen recomposes off it. */
class SettingsUi {
    val clusterStatus = mutableStateOf("Cluster: off")
    val connected = mutableStateOf(false)
    var clusterUrl = ""

    val profiles = mutableStateOf<List<String>>(listOf("default"))
    val currentProfile = mutableStateOf("default")
    val roleNames = mutableStateOf<List<String>>(listOf("(none)"))
    val roleForCurrent = mutableStateOf("(none)")
    val platforms = mutableStateOf<List<PlatformOpt>>(emptyList())

    val phoneCaps = mutableStateOf("")
    val devices = mutableStateOf<List<DeviceOpt>>(emptyList())
    val useLocal = mutableStateOf(false)
    val modelLabels = mutableStateOf<List<String>>(emptyList())
    val modelIndex = mutableStateOf(0)
    val modelStatus = mutableStateOf("not downloaded")
    val modelProgress = mutableStateOf(-1)   // -1 hidden, else 0..100
    var endpoint = ""; var apiKey = ""; var ollamaModel = ""; var hfToken = ""

    val rolesLoadedNote = mutableStateOf("")
    val flowCount = mutableStateOf(0)

    val themeMode = mutableStateOf(0)        // 0 dark, 1 light
}

/** Actions wired to the Activity's existing logic (so both UIs drive the same code paths). */
class SettingsActions(
    val onSaveClusterUrl: (String) -> Unit,
    val onSignIn: () -> Unit,
    val onConnectToggle: () -> Unit,
    val onResync: () -> Unit,
    val onOpenHub: () -> Unit,
    val onSwitchProfile: (String) -> Unit,
    val onAddProfile: (String) -> Unit,
    val onSetRole: (String) -> Unit,
    val onLoadRoles: () -> Unit,
    val onLoadPlatforms: () -> Unit,
    val onOpenPlatform: (String, String) -> Unit,
    val onSetUseLocal: (Boolean) -> Unit,
    val onSelectModelIndex: (Int) -> Unit,
    val onDownloadModel: () -> Unit,
    val onSaveOllama: (endpoint: String, apiKey: String, model: String, hfToken: String) -> Unit,
    val onRefreshDevices: () -> Unit,
    val onOpenTailscale: () -> Unit,
    val onSetTheme: (Int) -> Unit,
)

@Composable
fun SettingsScreen(visible: Boolean, ui: SettingsUi, act: SettingsActions, onClose: () -> Unit) {
    if (!visible) return
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.background, contentColor = cs.onBackground, modifier = Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            // Header
            Row(
                Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 16.dp, bottom = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Settings", style = MaterialTheme.typography.headlineSmall)
                    Text("Everything for this device and your account", color = cs.onSurfaceVariant, fontSize = 12.sp)
                }
                IconButton(onClick = onClose) { Icon(Icons.Default.Close, contentDescription = "Close") }
            }
            HorizontalDivider(color = cs.outline)

            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {

                // 1 ─ Account & sync ------------------------------------------------------------------
                SectionCard("☁", "Account & sync", "Sign in to my-app.engineer, connect this device, keep data in sync") {
                    var url by remember { mutableStateOf(ui.clusterUrl) }
                    Field("Cluster URL", url, { url = it; act.onSaveClusterUrl(it) }, mono = true)
                    Spacer(Modifier.height(10.dp))
                    StatusPill(ui.connected.value, ui.clusterStatus.value)
                    Spacer(Modifier.height(12.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Ghost("Sign in", Modifier.weight(1f), act.onSignIn)
                        Primary(if (ui.connected.value) "Disconnect" else "Connect", Modifier.weight(1f), act.onConnectToggle)
                    }
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Ghost("Re-sync now", Modifier.weight(1f), act.onResync)
                        Ghost("Open Device Hub", Modifier.weight(1f), act.onOpenHub)
                    }
                    Note("Profiles, automations and roles auto-sync from the cluster on sign-in — one account, same data on every device.")
                }

                // 2 ─ Profiles ------------------------------------------------------------------------
                SectionCard("👤", "Profiles", "Isolated browser identities — each its own cookies and role") {
                    Text("Open a platform", color = cs.onSurfaceVariant, fontSize = 12.sp)
                    Spacer(Modifier.height(6.dp))
                    if (ui.platforms.value.isEmpty()) Text("Load your platforms from the cluster to open & sign in here.", color = cs.onSurfaceVariant, fontSize = 12.sp)
                    else Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        ui.platforms.value.forEach { p ->
                            Row(
                                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(cs.surfaceVariant)
                                    .clickable { act.onOpenPlatform(p.profile, p.site) }.padding(12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(p.label, fontSize = 14.sp)
                                    Text(if (p.signedIn) "signed in on this phone" else "tap to open & sign in", color = if (p.signedIn) GbGreen else cs.onSurfaceVariant, fontSize = 11.sp)
                                }
                                Box(Modifier.size(9.dp).clip(RoundedCornerShape(5.dp)).background(if (p.signedIn) GbGreen else cs.onSurfaceVariant))
                            }
                        }
                    }
                    TextButton(onClick = act.onLoadPlatforms) { Text("Load platforms from cluster") }
                    Spacer(Modifier.height(8.dp)); HorizontalDivider(color = cs.outline); Spacer(Modifier.height(12.dp))
                    Text("Active", color = cs.onSurfaceVariant, fontSize = 12.sp)
                    Spacer(Modifier.height(6.dp))
                    FlowChips(ui.profiles.value, ui.currentProfile.value) { act.onSwitchProfile(it) }
                    Spacer(Modifier.height(12.dp))
                    var np by remember { mutableStateOf("") }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.weight(1f)) { Field("New profile name", np, { np = it }) }
                        Primary("Add") { if (np.isNotBlank()) { act.onAddProfile(np); np = "" } }
                    }
                    Spacer(Modifier.height(14.dp))
                    Text("Role for “${ui.currentProfile.value}”", color = cs.onSurfaceVariant, fontSize = 12.sp)
                    Spacer(Modifier.height(6.dp))
                    Dropdown(ui.roleNames.value, ui.roleNames.value.indexOf(ui.roleForCurrent.value).coerceAtLeast(0)) { i ->
                        act.onSetRole(ui.roleNames.value.getOrElse(i) { "(none)" })
                    }
                    TextButton(onClick = act.onLoadRoles) { Text("Reload roles from cluster") }
                }

                // 3 ─ Devices & ring ------------------------------------------------------------------
                SectionCard("📱", "Devices & ring", "What this phone can do, the on-device model, and the connected devices") {
                    Text("This phone", color = cs.onSurfaceVariant, fontSize = 12.sp)
                    Spacer(Modifier.height(4.dp))
                    Text(ui.phoneCaps.value.ifBlank { "android · native touch · real IP" }, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                    Spacer(Modifier.height(14.dp))

                    ToggleRow("Use on-device model", "Run the agent locally on this phone (no cluster needed)", ui.useLocal.value) { act.onSetUseLocal(it) }
                    Spacer(Modifier.height(10.dp))
                    Dropdown(ui.modelLabels.value, ui.modelIndex.value) { act.onSelectModelIndex(it) }
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(ui.modelStatus.value, color = if (ui.modelStatus.value.contains("✓")) GbGreen else cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.weight(1f))
                        Primary(if (ui.modelStatus.value.contains("✓")) "Re-download" else "Download", onClick = act.onDownloadModel)
                    }
                    if (ui.modelProgress.value in 0..100) {
                        Spacer(Modifier.height(8.dp))
                        LinearProgressIndicator(progress = { ui.modelProgress.value / 100f }, modifier = Modifier.fillMaxWidth(), color = GbGreen)
                    }
                    Spacer(Modifier.height(14.dp))
                    Text("Or an Ollama / OpenAI-compatible endpoint", color = cs.onSurfaceVariant, fontSize = 12.sp)
                    Spacer(Modifier.height(6.dp))
                    var ep by remember { mutableStateOf(ui.endpoint) }
                    var ak by remember { mutableStateOf(ui.apiKey) }
                    var om by remember { mutableStateOf(ui.ollamaModel) }
                    var hf by remember { mutableStateOf(ui.hfToken) }
                    Field("Endpoint (http://host:11434)", ep, { ep = it }, mono = true)
                    Spacer(Modifier.height(8.dp)); Field("API key (optional)", ak, { ak = it }, mono = true)
                    Spacer(Modifier.height(8.dp)); Field("Model name", om, { om = it }, mono = true)
                    Spacer(Modifier.height(8.dp)); Field("Hugging Face token (for gated downloads)", hf, { hf = it }, mono = true)
                    Spacer(Modifier.height(10.dp))
                    Ghost("Save endpoint", Modifier.fillMaxWidth()) { act.onSaveOllama(ep, ak, om, hf) }

                    Spacer(Modifier.height(16.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Connected devices", color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.weight(1f))
                        TextButton(onClick = act.onRefreshDevices) { Text("Refresh") }
                    }
                    val ds = ui.devices.value.filter { it.id != "local" && it.id != "cluster" && it.id != "auto" }
                    if (ds.isEmpty()) Text("No other devices online.", color = cs.onSurfaceVariant, fontSize = 12.sp)
                    else Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { ds.forEach { DeviceRow(it) } }
                }

                // 4 ─ Automations & roles -------------------------------------------------------------
                SectionCard("🔗", "Automations & roles", "Your flows and the roles the agent adopts") {
                    Text("${ui.flowCount.value} automation(s) synced", fontSize = 13.sp)
                    Text("${(ui.roleNames.value.size - 1).coerceAtLeast(0)} role(s) available", color = cs.onSurfaceVariant, fontSize = 12.sp)
                    Note("Browse, run and create flows from the Flows tab. Full flow management moves into this screen next (S6).")
                    Ghost("Reload roles", Modifier.fillMaxWidth(), act.onLoadRoles)
                }

                // 5 ─ Network & exit ------------------------------------------------------------------
                SectionCard("🛡", "Network & exit", "Stealth exit and the residential IP this device operates on") {
                    Text("This phone operates on its own real mobile IP — the strongest fingerprint for Cloudflare-gated sites.", fontSize = 13.sp)
                    Spacer(Modifier.height(10.dp))
                    Ghost("Open Tailscale (exit node)", Modifier.fillMaxWidth(), act.onOpenTailscale)
                    Note("The cluster's GB keeps its own in-image exit node; on-device runs use this device's network directly.")
                }

                // 6 ─ Appearance ----------------------------------------------------------------------
                SectionCard("🎨", "Appearance", "Theme for the app") {
                    Segmented(listOf("Dark", "Light"), ui.themeMode.value) { act.onSetTheme(it) }
                }

                Spacer(Modifier.height(28.dp))
                Text("Ghost Browser Mobile", color = cs.onSurfaceVariant, fontSize = 11.sp, modifier = Modifier.align(Alignment.CenterHorizontally))
                Spacer(Modifier.height(20.dp))
            }
        }
    }
}

/* ── building blocks ───────────────────────────────────────────────────────────────────────── */

@Composable
private fun SectionCard(emoji: String, title: String, sub: String, content: @Composable ColumnScope.() -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(
        color = cs.surface, contentColor = cs.onSurface, shape = RoundedCornerShape(18.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, cs.outline),
        modifier = Modifier.fillMaxWidth().padding(bottom = 14.dp),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(emoji, fontSize = 18.sp, modifier = Modifier.padding(end = 10.dp))
                Column(Modifier.weight(1f)) {
                    Text(title, style = MaterialTheme.typography.titleMedium)
                    Text(sub, color = cs.onSurfaceVariant, fontSize = 12.sp)
                }
            }
            Spacer(Modifier.height(14.dp))
            content()
        }
    }
}

@Composable
private fun Field(label: String, value: String, onChange: (String) -> Unit, mono: Boolean = false) {
    OutlinedTextField(
        value = value, onValueChange = onChange, label = { Text(label) },
        singleLine = true, modifier = Modifier.fillMaxWidth(),
        textStyle = if (mono) LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace, fontSize = 13.sp) else LocalTextStyle.current,
    )
}

@Composable
private fun Note(text: String) {
    Spacer(Modifier.height(10.dp))
    Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, lineHeight = 15.sp)
}

@Composable
private fun Primary(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Button(onClick = onClick, modifier = modifier, shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.buttonColors(containerColor = GbGreen, contentColor = BrandOn)) { Text(label) }
}

@Composable
private fun Ghost(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    OutlinedButton(onClick = onClick, modifier = modifier, shape = RoundedCornerShape(12.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, cs.outline)) { Text(label, color = cs.onSurface) }
}

@Composable
private fun StatusPill(on: Boolean, text: String) {
    val cs = MaterialTheme.colorScheme
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(9.dp).clip(RoundedCornerShape(5.dp)).background(if (on) GbGreen else cs.onSurfaceVariant))
        Spacer(Modifier.width(8.dp))
        Text(text, fontSize = 12.sp, color = cs.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun ToggleRow(title: String, sub: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 14.sp)
            Text(sub, color = cs.onSurfaceVariant, fontSize = 11.sp)
        }
        Switch(checked = checked, onCheckedChange = onChange,
            colors = SwitchDefaults.colors(checkedTrackColor = GbGreen, checkedThumbColor = Color.White))
    }
}

@Composable
private fun FlowChips(items: List<String>, selected: String, onPick: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    FlowRowSimple {
        items.forEach { name ->
            val on = name == selected
            Surface(
                color = if (on) GbGreenGhost else cs.surfaceVariant,
                border = androidx.compose.foundation.BorderStroke(1.dp, if (on) GbGreen else cs.outline),
                shape = RoundedCornerShape(20.dp),
                modifier = Modifier.padding(end = 8.dp, bottom = 8.dp).clickable { onPick(name) },
            ) {
                Text(name, color = if (on) GbGreen else cs.onSurface, fontSize = 13.sp,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp))
            }
        }
    }
}

/** Minimal wrap layout (avoids depending on the experimental FlowRow API). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlowRowSimple(content: @Composable () -> Unit) {
    androidx.compose.foundation.layout.FlowRow(modifier = Modifier.fillMaxWidth()) { content() }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Dropdown(options: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val label = options.getOrElse(selectedIndex) { options.firstOrNull() ?: "" }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = label, onValueChange = {}, readOnly = true,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEachIndexed { i, opt ->
                DropdownMenuItem(text = { Text(opt) }, onClick = { expanded = false; onSelect(i) })
            }
        }
    }
}

@Composable
private fun Segmented(options: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
            .border(1.dp, cs.outline, RoundedCornerShape(12.dp)),
    ) {
        options.forEachIndexed { i, opt ->
            val on = i == selected
            Box(
                Modifier.weight(1f).background(if (on) GbGreen else Color.Transparent)
                    .clickable { onSelect(i) }.padding(vertical = 12.dp),
                contentAlignment = Alignment.Center,
            ) { Text(opt, color = if (on) BrandOn else cs.onSurface, fontSize = 13.sp) }
        }
    }
}

@Composable
private fun DeviceRow(d: DeviceOpt) {
    val cs = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(cs.surfaceVariant).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(d.emoji, fontSize = 16.sp, modifier = Modifier.padding(end = 10.dp))
        Column(Modifier.weight(1f)) {
            Text(d.name, fontSize = 14.sp)
            Text(d.sub, color = cs.onSurfaceVariant, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.size(9.dp).clip(RoundedCornerShape(5.dp)).background(if (d.online) GbGreen else cs.onSurfaceVariant))
    }
}
