package engineer.myapp.gb.shared

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/*
 * ONE SETTINGS PAGE, EVERY DEVICE.
 *
 * The phone and the desktop each grew their own settings screen, and the two drifted: the desktop's
 * AI-model form took one key and no backup, while the shared model sheet took both; the phone had an
 * on-device model the desktop never mentioned. A person reading "Settings" on two devices found two
 * products. This is the one page. It reads its facts from a SettingsState the app fills, calls
 * back through SettingsHandlers, and leaves out any section the app has nothing for (a null slot
 * is a section that does not exist on this device, never an empty card).
 *
 * The model section is built on the same AiModelUi/AiModelActions the model sheet uses, so the
 * primary key, the backup ring and the model list are one thing everywhere.
 */

/** Facts the page shows. Observable, so the app updates them from wherever it learns them. */
class SettingsState {
    val clusterUrl = mutableStateOf("")
    val clusterStatus = mutableStateOf("")
    val connected = mutableStateOf(false)
    val deviceLine = mutableStateOf("")            // "desktop · real Chromium (JCEF) · CDP"
    val deviceKind = mutableStateOf("desktop")     // desktop | phone | web
    val platforms = mutableStateOf<List<PlatformOpt>>(emptyList())
    val profiles = mutableStateOf<List<String>>(emptyList())
    val currentProfile = mutableStateOf("")
    val roleNames = mutableStateOf<List<String>>(emptyList())
    val roleForCurrent = mutableStateOf("")
    val devices = mutableStateOf<List<DeviceOpt>>(emptyList())
    val hubSummary = mutableStateOf("")
    val trainingLine = mutableStateOf("")
    val trainingNow = mutableStateOf("")
    val networkLine = mutableStateOf("")
    val themeDark = mutableStateOf(true)
    val activity = mutableStateOf("")
    val appLabel = mutableStateOf("Ghost Browser")
    /* The password fallback: whether the owner set one on this instance (null = not asked yet),
       what the last sign-in or set attempt said, and the email the instance belongs to. */
    val hasPassword = mutableStateOf<Boolean?>(null)
    val accountEmail = mutableStateOf("")
    val authMessage = mutableStateOf("")
    /* The on-device model (a phone thing). Null on a device that has none. */
    val local = mutableStateOf<LocalModelUi?>(null)
}

/** The phone's on-device model: a switch, a choice, a download. */
class LocalModelUi {
    val useLocal = mutableStateOf(false)
    val labels = mutableStateOf<List<String>>(emptyList())
    val index = mutableStateOf(0)
    val status = mutableStateOf("not downloaded")
    val progress = mutableStateOf(-1)
}

/** What the page can ask the app to do. A null handler hides its control. */
class SettingsHandlers(
    val onSaveClusterUrl: ((String) -> Unit)? = null,
    val onSignIn: (() -> Unit)? = null,
    val onConnectToggle: (() -> Unit)? = null,
    /* The fallback that never depends on the platform: sign in with the owner's email and the
       password set on this instance, and set that password while signed in. */
    val onPasswordSignIn: ((email: String, password: String) -> Unit)? = null,
    val onSetPassword: ((password: String) -> Unit)? = null,
    val onResync: () -> Unit = {},
    val onOpenHub: () -> Unit = {},
    val onOpenTraining: () -> Unit = {},
    val onOpenDownloads: () -> Unit = {},
    val onLoadPlatforms: () -> Unit = {},
    val onOpenPlatform: (profile: String, site: String) -> Unit = { _, _ -> },
    val onSwitchProfile: ((String) -> Unit)? = null,
    val onAddProfile: ((String) -> Unit)? = null,
    val onSetRole: ((String) -> Unit)? = null,
    val onLoadRoles: (() -> Unit)? = null,
    val onRefreshDevices: () -> Unit = {},
    val onOpenTailscale: (() -> Unit)? = null,
    val onSetTheme: (dark: Boolean) -> Unit = {},
    val onClearLog: (() -> Unit)? = null,
    val aiModel: AiModelActions,
    val onSetUseLocal: ((Boolean) -> Unit)? = null,
    val onSelectLocalModel: ((Int) -> Unit)? = null,
    val onDownloadLocalModel: (() -> Unit)? = null,
    /* Bearer keys for scripts and other machines - the web console's sheet; null elsewhere. */
    val onOpenApiTokens: (() -> Unit)? = null,
)

/**
 * THE SIGN-IN GATE, shared by every surface that can be opened signed out. The web console had
 * none: with no session it rendered every screen empty, which read as "the console is broken" on a
 * laptop whose platform hand-off had failed. This is what a signed-out surface shows instead: the
 * owner's email and the password set on the instance, and the one other way in.
 */
@Composable
fun SignInGate(state: SettingsState, onSignIn: (email: String, password: String) -> Unit, appLabel: String = "Ghost Browser") {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.background, contentColor = cs.onBackground, modifier = Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().padding(20.dp), contentAlignment = Alignment.Center) {
            Surface(color = cs.surface, shape = RoundedCornerShape(18.dp), modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth()) {
                Column(Modifier.padding(24.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(34.dp).clip(RoundedCornerShape(9.dp)).background(Brand), contentAlignment = Alignment.Center) {
                            Text("G", color = BrandOn, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                        }
                        Spacer(Modifier.width(10.dp))
                        Text(appLabel, style = MaterialTheme.typography.titleLarge, color = cs.onSurface)
                    }
                    Spacer(Modifier.height(18.dp))
                    Text("Sign in", style = MaterialTheme.typography.headlineSmall, color = cs.onSurface)
                    Text("Your email and the password set on this Ghost Browser.", color = cs.onSurfaceVariant, fontSize = 12.sp)
                    Spacer(Modifier.height(14.dp))
                    var email by remember { mutableStateOf(state.accountEmail.value) }
                    var pw by remember { mutableStateOf("") }
                    OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp))
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(pw, { pw = it }, label = { Text("Password") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), visualTransformation = PasswordVisualTransformation())
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = { state.authMessage.value = "signing in…"; onSignIn(email.trim(), pw) }, enabled = email.isNotBlank() && pw.isNotBlank(),
                        shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Sign in") }
                    if (state.authMessage.value.isNotBlank()) {
                        Spacer(Modifier.height(8.dp))
                        Text(state.authMessage.value, color = if (state.authMessage.value.contains("fail", true) || state.authMessage.value.contains("not", true)) cs.error else cs.onSurfaceVariant, fontSize = 12.sp)
                    }
                    Spacer(Modifier.height(14.dp))
                    HorizontalDivider(color = cs.outline)
                    Spacer(Modifier.height(10.dp))
                    Text(
                        if (state.hasPassword.value == false)
                            "No password is set on this Ghost Browser yet. Open it from your platform (the Tools tab) once — that signs you in — then set a password in Settings so this works from anywhere."
                        else "Or open Ghost Browser from your platform's Tools tab — that signs you in without a password.",
                        color = cs.onSurfaceVariant, fontSize = 11.sp, lineHeight = 15.sp,
                    )
                }
            }
        }
    }
}

@Composable
fun SettingsScreenShared(
    state: SettingsState,
    model: AiModelUi,
    h: SettingsHandlers,
    onClose: (() -> Unit)? = null,
    topInset: Modifier = Modifier,
) {
    val cs = MaterialTheme.colorScheme
    LaunchedEffect(Unit) { h.aiModel.onLoad() }
    val sections = buildList {
        add("Account")
        add("AI & training")
        add("Browser")
        if (state.deviceKind.value == "web") add("Profiles & devices")
        add("Activity")
    }
    var selected by remember { mutableStateOf("Account") }
    if (selected !in sections) selected = "Account"
    Surface(color = cs.background, contentColor = cs.onBackground, modifier = Modifier.fillMaxSize()) {
        BoxWithConstraints(Modifier.fillMaxSize().then(topInset)) {
            val wide = maxWidth >= 760.dp
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 14.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Settings", style = MaterialTheme.typography.headlineSmall)
                        Text("Account, browser and automation setup", color = cs.onSurfaceVariant, fontSize = 12.sp)
                    }
                    if (onClose != null) IconButton(onClick = onClose) { Icon(Icons.Default.Close, contentDescription = "Close") }
                }
                Surface(color = if (state.connected.value) BrandSoft else cs.surfaceVariant,
                    shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                    Row(Modifier.padding(horizontal = 14.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(if (state.connected.value) Icons.Default.CheckCircle else Icons.Default.CloudOff,
                            null, tint = if (state.connected.value) cs.secondary else cs.onSurfaceVariant, modifier = Modifier.size(19.dp))
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(if (state.connected.value) "Connected to your cluster" else "Cluster connection needed",
                                color = cs.onSurface, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                            Text(state.clusterStatus.value.ifBlank { state.deviceLine.value.ifBlank { "Manage connection in Account" } },
                                color = cs.onSurfaceVariant, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                if (wide) {
                    Row(Modifier.fillMaxSize()) {
                        Column(Modifier.width(208.dp).fillMaxHeight().padding(start = 16.dp, end = 8.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            sections.forEach { section -> SettingsDestination(section, selected == section, rail = true) { selected = section } }
                        }
                        SettingsCategory(selected, state, model, h, wide = true, modifier = Modifier.weight(1f))
                    }
                } else {
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp),
                        horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                        sections.forEach { section -> SettingsDestination(section, selected == section) { selected = section } }
                    }
                    Spacer(Modifier.height(10.dp))
                    SettingsCategory(selected, state, model, h, wide = false, modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun SettingsDestination(label: String, active: Boolean, rail: Boolean = false, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(color = if (active) Brand else cs.surfaceVariant, shape = RoundedCornerShape(11.dp),
        modifier = (if (rail) Modifier.fillMaxWidth() else Modifier).clip(RoundedCornerShape(11.dp)).clickable(onClick = onClick)) {
        Text(label, color = if (active) BrandOn else cs.onSurface, fontSize = 13.sp,
            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 11.dp))
    }
}

@Composable
private fun SettingsCategory(section: String, state: SettingsState, model: AiModelUi, h: SettingsHandlers,
    wide: Boolean, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    Column(modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(section, color = cs.onSurface, style = MaterialTheme.typography.titleLarge)
        if (wide) when (section) {
            "Account" -> Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(2f)) { AccountSection(state, h) }
                if (h.onOpenApiTokens != null) Column(Modifier.weight(1f)) {
                    SettingsCard("API tokens", "Keys for scripts and other devices") {
                        SGhost("Manage API tokens", Modifier.fillMaxWidth(), h.onOpenApiTokens)
                    }
                }
            }
            "AI & training" -> Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(2f)) { ModelSection(model, h.aiModel, state.local.value, h) }
                Column(Modifier.weight(1f)) { TrainingSection(state, h) }
            }
            "Browser" -> Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    AppearanceSection(state, h); DownloadsSection(h)
                }
                Column(Modifier.weight(1f)) { NetworkSection(state, h) }
            }
            "Profiles & devices" -> Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) { ProfilesSection(state, h) }
                Column(Modifier.weight(1f)) { DevicesSection(state, h) }
            }
            "Activity" -> ActivitySection(state, h)
        } else when (section) {
            "Account" -> {
                AccountSection(state, h)
                if (h.onOpenApiTokens != null) SettingsCard("API tokens", "Keys for scripts and other devices") {
                    SGhost("Manage API tokens", Modifier.fillMaxWidth(), h.onOpenApiTokens)
                }
            }
            "AI & training" -> { ModelSection(model, h.aiModel, state.local.value, h); TrainingSection(state, h) }
            "Browser" -> { AppearanceSection(state, h); NetworkSection(state, h); DownloadsSection(h) }
            "Profiles & devices" -> { ProfilesSection(state, h); DevicesSection(state, h) }
            "Activity" -> ActivitySection(state, h)
        }
        Spacer(Modifier.height(18.dp))
    }
}

/* ── sections ─────────────────────────────────────────────────────────────────────────────────── */

@Composable
private fun AccountSection(s: SettingsState, h: SettingsHandlers) {
    val cs = MaterialTheme.colorScheme
    SettingsCard("Account & sync", "Sign in to my-app.engineer, connect this device, keep data in sync") {
        if (h.onSaveClusterUrl != null) {
            var url by remember(s.clusterUrl.value) { mutableStateOf(s.clusterUrl.value) }
            SField("Cluster URL", url, { url = it; h.onSaveClusterUrl.invoke(it) }, mono = true)
            Spacer(Modifier.height(10.dp))
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(9.dp).clip(CircleShape).background(if (s.connected.value) Brand else cs.onSurfaceVariant))
            Spacer(Modifier.width(8.dp))
            Text(s.clusterStatus.value.ifBlank { if (s.connected.value) "Cluster: connected" else "Cluster: connecting…" }, color = cs.onSurface, fontSize = 13.sp, modifier = Modifier.weight(1f))
        }
        if (h.onSaveClusterUrl == null && s.clusterUrl.value.isNotBlank()) {
            Spacer(Modifier.height(4.dp))
            Text(s.clusterUrl.value, color = cs.onSurfaceVariant, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (h.onSignIn != null) SGhost("Sign in", Modifier.weight(1f), h.onSignIn)
            if (h.onConnectToggle != null) SPrimary(if (s.connected.value) "Disconnect" else "Connect", Modifier.weight(1f), h.onConnectToggle)
            SGhost("Re-sync now", Modifier.weight(1f), h.onResync)
        }
        if (h.onSignIn == null) SNote("Sign in on the Browser tab (my-app.engineer → open Ghost Browser from Tools). The node then registers itself — one account, the same data on every device.")
        /*
         * THE WAY IN THAT DOES NOT DEPEND ON THE PLATFORM. When the hand-off from the platform fails
         * - a different account, a hand-off that never lands - this signs the app in with the owner's
         * email and the password set on this instance; and while signed in, this is where that
         * password is set. Never a page with nothing to press.
         */
        if (!s.connected.value && h.onPasswordSignIn != null) {
            Spacer(Modifier.height(14.dp))
            Text("Or sign in with email and password", color = cs.onSurface, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            var email by remember { mutableStateOf(s.accountEmail.value) }
            var pw by remember { mutableStateOf("") }
            SField("Email", email, { email = it })
            Spacer(Modifier.height(6.dp))
            OutlinedTextField(pw, { pw = it }, label = { Text("Password set on this Ghost Browser") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), visualTransformation = PasswordVisualTransformation())
            Spacer(Modifier.height(8.dp))
            SPrimary("Sign in with password", Modifier.fillMaxWidth()) { s.authMessage.value = "signing in…"; h.onPasswordSignIn.invoke(email.trim(), pw) }
            if (s.hasPassword.value == false) SNote("No password is set on this instance yet. Open Ghost Browser from the platform once, then set one below.")
        }
        if (s.connected.value && h.onSetPassword != null) {
            Spacer(Modifier.height(14.dp))
            Text("Sign-in password for this Ghost Browser", color = cs.onSurface, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(2.dp))
            Text(when (s.hasPassword.value) { true -> "set — your email and this password open the instance on any device, even when the platform hand-off fails"; false -> "not set — set one so you can always sign in without the platform"; null -> "so you can always sign in without the platform" }, color = cs.onSurfaceVariant, fontSize = 11.sp)
            Spacer(Modifier.height(6.dp))
            var newPw by remember { mutableStateOf("") }
            OutlinedTextField(newPw, { newPw = it }, label = { Text("New password (10+ characters)") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), visualTransformation = PasswordVisualTransformation())
            Spacer(Modifier.height(8.dp))
            SGhost(if (s.hasPassword.value == true) "Change password" else "Set password", Modifier.fillMaxWidth()) { if (newPw.length >= 10) { s.authMessage.value = "setting…"; h.onSetPassword.invoke(newPw); newPw = "" } else s.authMessage.value = "a password needs at least 10 characters" }
        }
        if (s.authMessage.value.isNotBlank()) { Spacer(Modifier.height(6.dp)); Text(s.authMessage.value, color = if (s.authMessage.value.contains("fail", true) || s.authMessage.value.contains("not", true) || s.authMessage.value.contains("wrong", true)) cs.error else cs.onSurfaceVariant, fontSize = 12.sp) }
    }
}

/**
 * THE MODEL THE AGENT RUNS ON — host, primary key, backup key, model. The same AiModelUi and
 * actions the model sheet uses, so this and the sheet can never disagree, and so the desktop
 * finally saves the backup key (its old form never sent it).
 */
@Composable
private fun ModelSection(ui: AiModelUi, act: AiModelActions, local: LocalModelUi?, h: SettingsHandlers) {
    val cs = MaterialTheme.colorScheme
    val info = ui.info.value
    var host by remember(info?.host) { mutableStateOf(info?.host ?: "https://ollama.com") }
    var key by remember { mutableStateOf("") }
    var backup by remember { mutableStateOf("") }
    var model by remember(info?.model) { mutableStateOf(info?.model ?: "") }
    SettingsCard("AI model", "The cloud model the agent and the collector call; the ring falls to the backup after a usage limit") {
        Text(
            (info?.model?.ifBlank { "no model set" } ?: if (ui.loading.value) "loading…" else "no model set") +
                (if (info?.keySet == true) " · primary ${info.keyHint}" else " · no key") +
                (if (info?.keys2Set == true) " · backup ${info.keys2Hint.ifBlank { "set" }}" else " · no backup") +
                (info?.keyState?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""),
            color = cs.onSurfaceVariant, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.height(10.dp))
        SField("Endpoint", host, { host = it }, mono = true)
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(key, { key = it }, label = { Text(if (info?.keySet == true) "Primary key (set ${info.keyHint} — enter to replace)" else "Primary key") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), visualTransformation = PasswordVisualTransformation())
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(backup, { backup = it }, label = { Text(if (info?.keys2Set == true) "Backup key(s) (set ${info.keys2Hint} — enter to replace)" else "Backup key(s) — a DIFFERENT account, comma-separated") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), visualTransformation = PasswordVisualTransformation())
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Model", color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.weight(1f))
            if (ui.busy.value) CircularProgressIndicator(Modifier.size(15.dp), color = Brand, strokeWidth = 2.dp)
            else TextButton(onClick = { act.onList(host, key) }) { Text("Fetch models", color = Brand, fontSize = 12.sp) }
        }
        if (ui.models.value.isNotEmpty()) SPick(ui.models.value, model) { model = it }
        else SField("Model name", model, { model = it }, mono = true)
        if (ui.note.value.isNotBlank()) { Spacer(Modifier.height(4.dp)); Text(ui.note.value, color = cs.onSurfaceVariant, fontSize = 11.sp) }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SGhost("Test", Modifier.weight(1f)) { act.onTest(host, key, model) }
            SPrimary("Save", Modifier.weight(1f)) {
                act.onSave(host, key, model)
                if (backup.isNotBlank()) act.onSaveBackups(backup)
                key = ""; backup = ""
            }
        }
        if (local != null && h.onSetUseLocal != null) {
            Spacer(Modifier.height(14.dp)); HorizontalDivider(color = cs.outline); Spacer(Modifier.height(10.dp))
            SToggle("Use the on-device model", "Run the agent on this phone without the cluster", local.useLocal.value) { h.onSetUseLocal.invoke(it) }
            Spacer(Modifier.height(8.dp))
            if (local.labels.value.isNotEmpty() && h.onSelectLocalModel != null) {
                SPick(local.labels.value, local.labels.value.getOrElse(local.index.value) { "" }) { picked -> h.onSelectLocalModel.invoke(local.labels.value.indexOf(picked).coerceAtLeast(0)) }
            }
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(local.status.value, color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.weight(1f))
                if (h.onDownloadLocalModel != null) SPrimary(if (local.status.value.contains("✓")) "Re-download" else "Download", onClick = h.onDownloadLocalModel)
            }
            if (local.progress.value in 0..100) {
                Spacer(Modifier.height(8.dp))
                LinearProgressIndicator(progress = { local.progress.value / 100f }, modifier = Modifier.fillMaxWidth(), color = Brand)
            }
        }
    }
}

@Composable
private fun TrainingSection(s: SettingsState, h: SettingsHandlers) {
    val cs = MaterialTheme.colorScheme
    SettingsCard("Training", "The browser learns its own model from its runs") {
        Text(s.trainingLine.value.ifBlank { "not connected to the studio yet" }, color = cs.onSurfaceVariant, fontSize = 12.sp)
        if (s.trainingNow.value.isNotBlank()) { Spacer(Modifier.height(6.dp)); Text(s.trainingNow.value, fontSize = 12.sp, color = cs.onSurface) }
        Spacer(Modifier.height(6.dp))
        TextButton(onClick = h.onOpenTraining) { Text("Open the Training Studio", color = Brand) }
    }
}

@Composable
private fun ProfilesSection(s: SettingsState, h: SettingsHandlers) {
    val cs = MaterialTheme.colorScheme
    SettingsCard("Profiles", "Isolated browser identities — each its own cookies and role") {
        Text("Open a platform", color = cs.onSurfaceVariant, fontSize = 12.sp)
        Spacer(Modifier.height(6.dp))
        if (s.platforms.value.isEmpty()) Text("Load your platforms from the cluster to open and sign in here.", color = cs.onSurfaceVariant, fontSize = 12.sp)
        else Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            s.platforms.value.forEach { p ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(cs.surfaceVariant).clickable { h.onOpenPlatform(p.profile, p.site) }.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(p.label, fontSize = 14.sp)
                        Text(if (p.signedIn) "signed in on this device" else "tap to open & sign in", color = if (p.signedIn) Brand else cs.onSurfaceVariant, fontSize = 11.sp)
                    }
                    Box(Modifier.size(9.dp).clip(CircleShape).background(if (p.signedIn) Brand else cs.onSurfaceVariant))
                }
            }
        }
        TextButton(onClick = h.onLoadPlatforms) { Text("Load platforms from cluster", color = Brand) }
        if (h.onSwitchProfile != null && s.profiles.value.isNotEmpty()) {
            Spacer(Modifier.height(8.dp)); HorizontalDivider(color = cs.outline); Spacer(Modifier.height(12.dp))
            Text("Active", color = cs.onSurfaceVariant, fontSize = 12.sp)
            Spacer(Modifier.height(6.dp))
            SChips(s.profiles.value, s.currentProfile.value) { h.onSwitchProfile.invoke(it) }
            if (h.onAddProfile != null) {
                Spacer(Modifier.height(12.dp))
                var np by remember { mutableStateOf("") }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Box(Modifier.weight(1f)) { SField("New profile name", np, { np = it }) }
                    SPrimary("Add") { if (np.isNotBlank()) { h.onAddProfile.invoke(np); np = "" } }
                }
            }
            if (h.onSetRole != null && s.roleNames.value.isNotEmpty()) {
                Spacer(Modifier.height(14.dp))
                Text("Role for “${s.currentProfile.value}”", color = cs.onSurfaceVariant, fontSize = 12.sp)
                Spacer(Modifier.height(6.dp))
                SPick(s.roleNames.value, s.roleForCurrent.value) { h.onSetRole.invoke(it) }
                if (h.onLoadRoles != null) TextButton(onClick = h.onLoadRoles) { Text("Reload roles from cluster", color = Brand) }
            }
        }
    }
}

@Composable
private fun DevicesSection(s: SettingsState, h: SettingsHandlers) {
    val cs = MaterialTheme.colorScheme
    SettingsCard("Devices & ring", "This device, and the others that share your account") {
        Text(if (s.deviceKind.value == "phone") "This phone" else "This machine", color = cs.onSurfaceVariant, fontSize = 12.sp)
        Text(s.deviceLine.value.ifBlank { "—" }, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
        Spacer(Modifier.height(12.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(s.hubSummary.value.ifBlank { "Connected devices" }, color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.weight(1f))
            TextButton(onClick = h.onRefreshDevices) { Text("Refresh", color = Brand) }
        }
        val ds = s.devices.value.filter { it.id != "local" && it.id != "cluster" && it.id != "auto" }
        if (ds.isEmpty()) Text("No other devices online.", color = cs.onSurfaceVariant, fontSize = 12.sp)
        else Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            ds.forEach { d ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(cs.surfaceVariant).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(if (d.online) Brand else cs.onSurfaceVariant))
                    Spacer(Modifier.width(8.dp))
                    Text(d.name, fontSize = 13.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(d.sub, color = cs.onSurfaceVariant, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        TextButton(onClick = h.onOpenHub) { Text("Open full Device Hub", color = Brand) }
    }
}

@Composable
private fun DownloadsSection(h: SettingsHandlers) {
    val cs = MaterialTheme.colorScheme
    SettingsCard("Downloads", "Files your Ghost Browser captured — songs, pictures, exports") {
        SPrimary("Open downloads", Modifier.fillMaxWidth(), h.onOpenDownloads)
    }
}

@Composable
private fun NetworkSection(s: SettingsState, h: SettingsHandlers) {
    SettingsCard("Network & exit", "Where this device's traffic leaves from") {
        Text(s.networkLine.value.ifBlank { "This device operates on its own network. The cluster's Ghost Browser keeps its own in-image exit node." }, fontSize = 13.sp)
        if (h.onOpenTailscale != null) { Spacer(Modifier.height(10.dp)); SGhost("Open Tailscale (exit node)", Modifier.fillMaxWidth(), h.onOpenTailscale) }
    }
}

@Composable
private fun AppearanceSection(s: SettingsState, h: SettingsHandlers) {
    SettingsCard("Appearance", "Theme for the app") {
        SSegmented(listOf("Dark", "Light"), if (s.themeDark.value) 0 else 1) { h.onSetTheme(it == 0) }
    }
}

@Composable
private fun ActivitySection(s: SettingsState, h: SettingsHandlers) {
    val cs = MaterialTheme.colorScheme
    SettingsCard("Activity", "What this device and the agent are doing right now") {
        Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
            val log = s.activity.value
            Text(if (log.isBlank()) "No activity yet." else log.takeLast(4000), modifier = Modifier.heightIn(min = 80.dp, max = 220.dp).verticalScroll(rememberScrollState()).padding(12.dp), color = cs.onSurfaceVariant, fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 15.sp)
        }
        if (h.onClearLog != null) TextButton(onClick = h.onClearLog) { Text("Clear", color = Brand) }
    }
}

/* ── building blocks ──────────────────────────────────────────────────────────────────────────── */

@Composable
private fun SettingsCard(title: String, sub: String, content: @Composable ColumnScope.() -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(15.dp), border = androidx.compose.foundation.BorderStroke(1.dp, cs.outline),
        modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(17.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = cs.onSurface, fontWeight = FontWeight.SemiBold)
            if (sub.isNotBlank()) {
                Spacer(Modifier.height(3.dp))
                Text(sub, color = cs.onSurfaceVariant, fontSize = 12.sp, lineHeight = 16.sp)
            }
            Spacer(Modifier.height(14.dp))
            content()
        }
    }
}

@Composable
private fun SField(label: String, value: String, onChange: (String) -> Unit, mono: Boolean = false) {
    OutlinedTextField(value, onChange, label = { Text(label) }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp),
        textStyle = if (mono) androidx.compose.ui.text.TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp) else androidx.compose.ui.text.TextStyle(fontSize = 14.sp))
}

@Composable
private fun SPrimary(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Button(onClick = onClick, modifier = modifier, shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text(label) }
}

@Composable
private fun SGhost(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = modifier, shape = RoundedCornerShape(12.dp)) { Text(label) }
}

@Composable
private fun SNote(text: String) { Spacer(Modifier.height(10.dp)); Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp, lineHeight = 15.sp) }

@Composable
private fun SSegmented(options: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(cs.surfaceVariant)) {
        options.forEachIndexed { i, o ->
            val on = i == selected
            Box(Modifier.weight(1f).clip(RoundedCornerShape(12.dp)).background(if (on) Brand else androidx.compose.ui.graphics.Color.Transparent).clickable { onSelect(i) }.padding(vertical = 12.dp), contentAlignment = Alignment.Center) {
                Text(o, color = if (on) BrandOn else cs.onSurface, fontSize = 13.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal)
            }
        }
    }
}

@Composable
private fun SChips(options: List<String>, current: String, onPick: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        options.take(6).forEach { o ->
            val on = o == current
            Surface(color = if (on) BrandSoft else cs.surfaceVariant, shape = RoundedCornerShape(8.dp), modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable(enabled = !on) { onPick(o) }) {
                Text(o, Modifier.padding(horizontal = 10.dp, vertical = 6.dp), color = if (on) Brand else cs.onSurface, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** A pick from a list, as a menu. */
@Composable
private fun SPick(options: List<String>, current: String, onPick: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var open by remember { mutableStateOf(false) }
    Box {
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(cs.surfaceVariant).clickable { open = true }.padding(horizontal = 12.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(current.ifBlank { "choose…" }, fontSize = 13.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("▾", color = cs.onSurfaceVariant)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { o -> DropdownMenuItem(text = { Text(o, fontFamily = FontFamily.Monospace, fontSize = 13.sp) }, onClick = { open = false; onPick(o) }) }
        }
    }
}

@Composable
private fun SToggle(title: String, sub: String, on: Boolean, onSet: (Boolean) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) { Text(title, fontSize = 13.sp, color = cs.onSurface); Text(sub, color = cs.onSurfaceVariant, fontSize = 11.sp) }
        Switch(checked = on, onCheckedChange = onSet)
    }
}
