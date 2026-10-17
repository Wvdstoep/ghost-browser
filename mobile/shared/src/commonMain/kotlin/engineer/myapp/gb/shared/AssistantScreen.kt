package engineer.myapp.gb.shared

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.*
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

/**
 * THE CHAT — one agent for everything. No modes, no slash commands: the owner writes, the agent inside
 * Ghost Browser decides what the request needs (read a watcher's results, run one, browse, build, fix)
 * and answers. What the screen shows, in order of importance: the answer (markdown, rendered), the
 * doors it opens (cards), and — folded — how it got there (the steps). While a turn runs the owner
 * sees what it is doing right now, can add a word, or stop it.
 */
class AssistantUi {
    val selectedAgent = mutableStateOf("browser") // "browser" | "recon"
    val chat = mutableStateOf<AssistantChatView?>(null)
    val chats = mutableStateOf<List<ChatSummary>>(emptyList())
    val error = mutableStateOf("")            // last transport error, shown once under the timeline
    val connected = mutableStateOf(false)     // a cluster is configured and answering
    val model = mutableStateOf("")            // the model the agent runs on (for the header)
    /** Platform decoder for a step's inlined picture (data: url → bitmap); null = cannot show pictures. */
    var decodeImage: ((String) -> androidx.compose.ui.graphics.ImageBitmap?)? = null
    /** THE BACKDROP: the browser the agent works in, live behind the chat while a turn runs; the last
     *  frame stays (darker) when it is done. Decoded by the platform on every poll. */
    val backdrop = mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null)
    val backdropProfile = mutableStateOf("")
}

/** Platform hooks the timeline calls without threading them through every composable. */
object AssistantHooks {
    /** Save a picture (data: url) to the device under this name; null = no saving on this platform. */
    var saveImage: ((dataUrl: String, name: String) -> Unit)? = null
    /** Save a captured FILE (any kind) to the device: the platform fetches the file's saveUrl (base64) from Ghost Browser. */
    var saveFile: ((downloadUrl: String, name: String) -> Unit)? = null
    /** Files already saved this session (download urls), so a file you asked for is saved once, by itself. */
    val autoSaved: MutableSet<String> = mutableSetOf()
    /** Play a captured audio/video file (audio inline on the phone, video/desktop through the system player). Calling it again for the file that is playing stops it. */
    var playMedia: ((downloadUrl: String, name: String, mime: String) -> Unit)? = null
    /** The download url of the file playing right now (audio), or null. */
    val playing = mutableStateOf<String?>(null)
    /** Ask the agent something from elsewhere in the app (a lead row's "draft the offer"): opens the chat and sends it. */
    var ask: ((text: String) -> Unit)? = null
}

class AssistantActions(
    val onSend: (String) -> Unit,
    val onNew: () -> Unit,
    val onOpen: (String) -> Unit,
    val onDelete: (String) -> Unit,
    val onStop: () -> Unit,
    val onCard: (AssistantCard) -> Unit,
    val onRefreshChats: () -> Unit,
    val onSettings: () -> Unit,
    val onClose: () -> Unit,
    val onOpenUrl: (String) -> Unit,
    val onConnect: () -> Unit,
    val onNewWithAgent: ((String) -> Unit)? = null,
)

data class StarterPrompt(val title: String, val subtitle: String, val prompt: String)

val RECON_PROMPT_CHIPS = listOf(
    StarterPrompt(
        title = "🛡️ Full Comprehensive Red-Team Audit",
        subtitle = "Perimeter, Headers, Canaries, Auth Matrix, OAST, AST, SQLi & Cloud SSRF",
        prompt = "Perform a full-spectrum comprehensive red-team and AppSec audit on https://my-app.engineer. Execute all validation engines systematically: 1. Perimeter mapping (gb_recon) and HTTP headers/verbs (gb_audit_http_headers). 2. Semantic SPA route discovery (gb_audit_semantic_surface) and unauthenticated API auth matrix (gb_audit_auth_matrix). 3. Zero-false-positive canary reflection & DOM sinks (gb_audit_canary_reflection). 4. Token cryptographic hygiene (gb_audit_token_hygiene) and rate-limiting (gb_audit_throttling). 5. Out-of-band canary blind callback testing (gb_audit_oast_callbacks). 6. 3-Pillar deterministic CVE verification (gb_audit_cve_verification). 7. Deep inter-file AST reachability analysis (gb_audit_ast_reachability). 8. Statistical timing differential for blind SQLi (gb_audit_sqli_timing). 9. Cloud metadata SSRF boundary probing (gb_audit_cloud_metadata). 10. Mass assignment schema pollution (gb_audit_mass_assignment). 11. Multi-phase second-order stored injection (gb_audit_second_order). 12. OpenAPI contract fuzzing (gb_audit_openapi_fuzz). 13. Subdomain takeover analyzer (gb_audit_subdomain_takeover). 14. JWT key confusion verification (gb_audit_jwt_key_confusion). Map all findings to SOC 2 / ISO 27001 (gb_audit_compliance) and generate verified PR-ready code remediations."
    ),
    StarterPrompt(
        title = "⏱️ Blind SQLi Timing Canary (CWE-89)",
        subtitle = "Statistical standard deviation over 3 requests (50ms vs 2000ms delay)",
        prompt = "Audit https://my-app.engineer for blind boolean and time-based SQL injection using gb_audit_sqli_timing. Inject non-destructive timing differentials (50ms baseline vs 2000ms calibrated delay) and compute statistical standard deviation over 3 requests to prove blind SQLi without dumping data."
    ),
    StarterPrompt(
        title = "🔄 Second-Order Stored Injection Tracker",
        subtitle = "Multi-phase tracking: register in Step 1, detect in downstream sinks Step 2",
        prompt = "Audit https://my-app.engineer for second-order stored injection using gb_audit_second_order. Track canaries across multi-step flows: register safe canary tokens into profile/mutation endpoints in Step 1, then crawl downstream admin views, exports, and profile displays in Step 2 to detect unescaped reflection."
    ),
    StarterPrompt(
        title = "☁️ Cloud Metadata SSRF & Boundary Probe (IMDSv2 & K8s)",
        subtitle = "Probe loopback, link-local (169.254.169.254) & K8s service tokens",
        prompt = "Audit https://my-app.engineer using gb_audit_cloud_metadata. Probe URL fetchers, image proxies, and webhook endpoints with loopback and link-local IP addresses (169.254.169.254 AWS IMDSv1/v2, GCP, Azure, [::1], and /var/run/secrets/kubernetes.io) to verify whether cloud metadata boundaries are strictly enforced."
    ),
    StarterPrompt(
        title = "🧬 Mass Assignment & Privileged Attribute Pollution",
        subtitle = "Inject privileged keys ('role': 'admin', 'credits': 99999) into API bodies",
        prompt = "Audit https://my-app.engineer for mass assignment and schema attribute pollution using gb_audit_mass_assignment. Clone legitimate API mutation bodies with privileged parameters injected (role: 'admin', isAdmin: true, permissions: ['*'], credits: 99999) to verify whether ORM models reject unauthorized field mutation."
    ),
    StarterPrompt(
        title = "📜 OpenAPI / Swagger Contract Fuzzer",
        subtitle = "Discover /api-docs and fire boundary type mutations for all endpoints",
        prompt = "Audit https://my-app.engineer with the autonomous schema fuzzer using gb_audit_openapi_fuzz. Discover /api-docs, /swagger.json, or OpenAPI contracts and automatically fire deterministic edge-case type mutations (negative numbers, integer overflows, null values) across every declared route."
    ),
    StarterPrompt(
        title = "🌐 Subdomain Takeover & Dangling DNS Analyzer",
        subtitle = "Resolve CNAMEs for NXDOMAIN responses on unclaimed S3, Vercel & GitHub",
        prompt = "Audit https://my-app.engineer for subdomain takeover and dangling DNS using gb_audit_subdomain_takeover. Resolve all subdomains, check for NXDOMAIN responses on third-party cloud CNAME targets (AWS S3, GitHub Pages, Vercel, Heroku), and flag dangling pointers before attackers can claim them."
    ),
    StarterPrompt(
        title = "🔑 JWT Key Confusion (CVE-2015-9235)",
        subtitle = "Sign HMAC-SHA256 tokens using server public RSA key (JWKS)",
        prompt = "Audit https://my-app.engineer for JWT key confusion and algorithm downgrade using gb_audit_jwt_key_confusion. Fetch server public keys (JWKS), forge token signatures using HMAC-SHA256 with the public key as HMAC secret, and verify if authenticated API routes strictly reject mismatched cryptographic algorithms."
    ),
    StarterPrompt(
        title = "🔬 Non-Destructive 3-Pillar CVE Verification",
        subtitle = "Behavioral differential, dependency reachability & mathematical canary",
        prompt = "Run a non-destructive 3-pillar CVE verification audit on https://my-app.engineer using gb_audit_cve_verification and gb_audit_ast_reachability. Prove whether identified issues are live reachable risks or dormant dead code, verify header desync normalizations, and provide exact curl PoCs and regression tests."
    ),
    StarterPrompt(
        title = "📡 Out-of-Band (OAST) Blind Canary Audit",
        subtitle = "Cryptographic tokens for blind SSRF & Host header callbacks",
        prompt = "Audit https://my-app.engineer using Out-of-Band Canary Protocols (gb_audit_oast_callbacks). Probe candidate webhook, redirect, and proxy parameters with ephemeral cryptographic tokens to test for blind SSRF and Host header callbacks without causing harm."
    ),
    StarterPrompt(
        title = "🔐 Business Logic & Access Control Matrix (BOLA)",
        subtitle = "Strip tokens to test unauthenticated API mutations and role escalation",
        prompt = "Perform an authorization matrix and broken access control (BOLA/IDOR) audit on https://my-app.engineer using gb_audit_auth_matrix and gb_audit_semantic_surface. Extract administrative routes and test whether backend endpoints strictly enforce server-side authorization."
    ),
    StarterPrompt(
        title = "⚡ Canary Reflection & Dynamic DOM Sink Taint",
        subtitle = "Harmless boundary probes ('"><gbtest>) & innerHTML sinks",
        prompt = "Audit input validation on https://my-app.engineer using gb_audit_canary_reflection and gb_audit_dom_sinks. Probe URL parameters and forms with harmless boundary delimiters (__gbcanary_xxxx'"><gbtest>) to mathematically prove whether inputs are reflected unencoded, and trace DOM sink taint."
    ),
    StarterPrompt(
        title = "📊 Enterprise Compliance & Hardening Directives",
        subtitle = "Map findings to SOC 2 Type II, ISO 27001 & PCI-DSS v4.0",
        prompt = "Perform a compliance and security hardening assessment on https://my-app.engineer. Run gb_recon, gb_audit_http_headers, and gb_audit_compliance to evaluate SOC 2 Trust Services Criteria, ISO 27001 controls, and PCI-DSS v4.0 requirements, and generate drop-in Nginx and application configuration patches."
    )
)

val ASSISTANT_PROMPT_CHIPS = listOf(
    StarterPrompt(
        title = "💬 Facebook Engagement & Alerts",
        subtitle = "Check reactions, messages and pending leads",
        prompt = "Anything on Facebook I should react to?"
    ),
    StarterPrompt(
        title = "⏳ Pending Approvals",
        subtitle = "Review drafts and queued actions",
        prompt = "What's waiting for my approval?"
    ),
    StarterPrompt(
        title = "👀 LinkedIn Watcher Status",
        subtitle = "Monitor replies and audience comments",
        prompt = "Keep an eye on replies to my LinkedIn posts"
    ),
    StarterPrompt(
        title = "⚙️ Watcher Health & Diagnostics",
        subtitle = "Inspect why automations drafted nothing today",
        prompt = "Why did the watcher draft nothing today?"
    )
)

val RECON_SUGGESTIONS = RECON_PROMPT_CHIPS.map { it.title }
val ASSISTANT_SUGGESTIONS = ASSISTANT_PROMPT_CHIPS.map { it.title }

@Composable
fun AssistantScreen(ui: AssistantUi, act: AssistantActions, modifier: Modifier = Modifier, topInset: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    val chat = ui.chat.value
    val live = chat?.live
    var history by remember { mutableStateOf(false) }
    var stepsOpen by remember { mutableStateOf<Long?>(null) }   // which assistant turn shows its steps (by t)
    val listState = rememberLazyListState()
    val turnCount = chat?.turns?.size ?: 0
    LaunchedEffect(turnCount, live?.steps?.size, live == null) { if (turnCount > 0) listState.animateScrollToItem(turnCount + 2) }

    val backdrop = ui.backdrop.value
    Box(modifier.fillMaxSize().background(cs.background)) {
        // THE LIVE BROWSER BEHIND THE CHAT: the frame the agent is looking at, softened and darkened so
        // the timeline stays readable; brighter while a turn runs, resting when it is done.
        if (backdrop != null) {
            val scrim by animateColorAsState(if (live != null) Color.Black.copy(alpha = 0.60f) else Color.Black.copy(alpha = 0.80f), label = "scrim")
            androidx.compose.foundation.Image(backdrop, contentDescription = null, modifier = Modifier.fillMaxSize().blur(3.dp), contentScale = androidx.compose.ui.layout.ContentScale.Crop, alignment = Alignment.TopCenter)
            Box(Modifier.fillMaxSize().background(scrim))
            Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Brush.verticalGradient(0f to cs.background.copy(alpha = 0.85f), 0.18f to Color.Transparent, 0.82f to Color.Transparent, 1f to cs.background.copy(alpha = 0.9f))))
        }
        Surface(color = if (backdrop != null) Color.Transparent else cs.background, contentColor = cs.onBackground, modifier = Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().then(topInset)) {
                Header(chat, live, ui, onHistory = { act.onRefreshChats(); history = true }, onNew = { act.onNewWithAgent?.invoke(ui.selectedAgent.value) ?: act.onNew() }, onSettings = act.onSettings, onClose = act.onClose)
                AgentToggleBar(ui = ui, act = act)
                // selectedAgent is user-controlled via AgentToggleBar and HistorySheet
                LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState, contentPadding = PaddingValues(horizontal = 14.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    item {
                        if (!ui.connected.value) ConnectCard(act.onConnect)
                        else if (chat == null || chat.turns.isEmpty()) EmptyState(ui.selectedAgent.value, act.onSend)
                    }
                    if (chat != null) items(chat.turns, key = { it.t.toString() + it.role }) { t ->
                        if (t.role == "user") UserTurn(t) else AssistantTurnCard(t, expanded = stepsOpen == t.t, onToggle = { stepsOpen = if (stepsOpen == t.t) null else t.t }, onCard = act.onCard, onOpenUrl = act.onOpenUrl, decode = ui.decodeImage)
                    }
                    if (live != null) item(key = "live") { LiveCard(live, act.onStop, decode = ui.decodeImage) }
                    if (ui.error.value.isNotBlank()) item(key = "err") { ErrorRow(ui.error.value) }
                    item { Spacer(Modifier.height(6.dp)) }
                }
                Composer(live != null, ui.connected.value, act.onSend)
            }
        }
        if (history) HistorySheet(ui.chats.value, chat?.id, initialAgent = ui.selectedAgent.value, onOpen = { id -> val c = ui.chats.value.firstOrNull { it.id == id }; if (c != null && c.agentType.isNotBlank()) ui.selectedAgent.value = c.agentType; act.onOpen(id); history = false }, onDelete = act.onDelete, onNewWithAgent = { agent -> ui.selectedAgent.value = agent; act.onNewWithAgent?.invoke(agent) ?: act.onNew(); history = false }, onClose = { history = false })
    }
}

/* ── header ─────────────────────────────────────────────────────────────────────────────────────── */
@Composable
private fun Header(chat: AssistantChatView?, live: AssistantLive?, ui: AssistantUi, onHistory: () -> Unit, onNew: () -> Unit, onSettings: () -> Unit, onClose: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().background(cs.surface.copy(alpha = 0.88f)).padding(start = 14.dp, end = 4.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(chat?.title?.ifBlank { "Agent" } ?: "Agent", style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (live != null) { PulseDot(Brand); Spacer(Modifier.width(6.dp)) }
                val sub = when {
                    live != null -> (live.steps.lastOrNull()?.label ?: "Thinking…") + (ui.backdropProfile.value.takeIf { it.isNotBlank() }?.let { " · in $it" } ?: "")
                    ui.model.value.isNotBlank() -> "on Ghost Browser · ${ui.model.value}"
                    ui.connected.value -> "on Ghost Browser"
                    else -> "not connected"
                }
                Text(sub, color = if (live != null) Brand else cs.onSurfaceVariant, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        IconButton(onClick = onHistory) { Icon(Icons.Default.History, "Chats", tint = cs.onSurfaceVariant) }
        IconButton(onClick = onNew) { Icon(Icons.Default.Add, "New chat", tint = cs.onSurfaceVariant) }
        IconButton(onClick = onSettings) { Icon(Icons.Default.Tune, "AI model", tint = cs.onSurfaceVariant) }
        IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Close", tint = cs.onSurfaceVariant) }
    }
}

@Composable
fun PulseDot(color: Color, size: Int = 8) {
    val t = rememberInfiniteTransition(label = "pulse")
    val a by t.animateFloat(0.35f, 1f, infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "a")
    Box(Modifier.size(size.dp).alpha(a).clip(CircleShape).background(color))
}

/* ── turns ──────────────────────────────────────────────────────────────────────────────────────── */
@Composable
private fun UserTurn(t: AssistantTurn) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Surface(color = if (t.spoken) cs.surfaceVariant else Brand, contentColor = if (t.spoken) cs.onSurface else BrandOn,
            shape = RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp), modifier = Modifier.widthIn(max = 320.dp)) {
            SelectionContainer {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                    if (t.spoken) Text("while it worked", fontSize = 10.sp, color = cs.onSurfaceVariant)
                    Text(t.text, fontSize = 15.sp, lineHeight = 21.sp)
                }
            }
        }
    }
}

@Composable
private fun AssistantTurnCard(t: AssistantTurn, expanded: Boolean, onToggle: () -> Unit, onCard: (AssistantCard) -> Unit, onOpenUrl: (String) -> Unit, decode: ((String) -> androidx.compose.ui.graphics.ImageBitmap?)? = null) {
    val cs = MaterialTheme.colorScheme
    val stripe = when (t.status) { "blocked" -> Color(0xFFE0A100); "error", "stopped" -> Color(0xFFE5484D); else -> Color.Transparent }
    var details by remember { mutableStateOf(false) }
    // a file the owner asked for saves itself to the device once the turn has landed (once per file)
    LaunchedEffect(t.t) {
        val saveF = AssistantHooks.saveFile ?: return@LaunchedEffect
        t.steps.filter { it.download.isNotBlank() && it.download !in AssistantHooks.autoSaved }.forEach { s -> AssistantHooks.autoSaved += s.download; saveF(s.download, s.fileName) }
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Box(Modifier.padding(top = 6.dp, end = 10.dp).size(22.dp).clip(CircleShape).background(Brand.copy(alpha = 0.18f)), contentAlignment = Alignment.Center) {
            Icon(Icons.Default.AutoAwesome, null, tint = Brand, modifier = Modifier.size(13.dp))
        }
        Column(Modifier.weight(1f)) {
            Surface(color = cs.surface, contentColor = cs.onSurface, shape = RoundedCornerShape(4.dp, 18.dp, 18.dp, 18.dp), border = BorderStroke(1.dp, cs.outline.copy(alpha = 0.6f))) {
                // the status stripe is DRAWN, not laid out: an IntrinsicSize.Min row measured the text at its
                // narrowest width (one word per line) and grew the card into a tall blank box
                Box(Modifier.drawBehind { if (stripe != Color.Transparent) drawRect(stripe, size = androidx.compose.ui.geometry.Size(3.dp.toPx(), size.height)) }) {
                    Column(Modifier.padding(start = if (stripe != Color.Transparent) 17.dp else 14.dp, end = 14.dp, top = 12.dp, bottom = 12.dp)) {
                        if (t.status == "blocked") Label("Could not finish", Color(0xFFE0A100))
                        if (t.status == "stopped") Label("Stopped", Color(0xFFE5484D))
                        MarkdownText(t.text, onOpenUrl = onOpenUrl)
                        // THE RESULT ITSELF — the picture, the song, the file — belongs in the answer, not under a fold
                        val results = t.steps.filter { it.imageData.isNotBlank() || it.download.isNotBlank() }
                        if (results.isNotEmpty()) { Spacer(Modifier.height(8.dp)); results.forEach { s -> StepMedia(s, decode, inAnswer = true) } }
                        // a recording the turn started: its own card (live, then playable, then downloadable), once per recording
                        val recIds = (t.cards.filter { it.kind == "recording" }.map { it.id } + t.steps.map { it.recording }).filter { it.isNotBlank() }.distinct()
                        recIds.forEach { id -> Spacer(Modifier.height(8.dp)); RecordingCard(id) }
                        val rawChips = t.cards.filter { it.kind != "recording" }
                        val isReportTurn = t.text.contains("Audit", ignoreCase = true) ||
                                           t.text.contains("Critical", ignoreCase = true) ||
                                           t.text.contains("Remediation", ignoreCase = true) ||
                                           t.text.contains("Vulnerabilit", ignoreCase = true) ||
                                           t.text.contains("Exposed", ignoreCase = true) ||
                                           rawChips.any { it.title.contains("Site", ignoreCase = true) || it.title.contains("Exposed", ignoreCase = true) }

                        val hasPdf = rawChips.any { it.kind == "pdf" || it.title.contains("pdf", ignoreCase = true) }
                        val chips = if (!hasPdf && isReportTurn) {
                            rawChips + AssistantCard(kind = "pdf", title = "Save Report as PDF")
                        } else {
                            rawChips
                        }

                        if (chips.isNotEmpty()) {
                            Spacer(Modifier.height(10.dp))
                            FlowRowCompat(chips.map { c ->
                                {
                                    CardChip(c) {
                                        if (c.kind == "pdf") onCard(c.copy(url = t.text, id = t.details))
                                        else onCard(c)
                                    }
                                }
                            })
                        }
                        if (t.details.isNotBlank()) {
                            Spacer(Modifier.height(8.dp))
                            Text(if (details) "Hide details" else "Details", color = Brand, fontSize = 12.sp, modifier = Modifier.clickable { details = !details })
                            if (details) MarkdownText(t.details, Modifier.padding(top = 6.dp), fontSize = 13.sp, onOpenUrl = onOpenUrl)
                        }
                    }
                }
            }
            if (t.steps.isNotEmpty()) {
                Row(Modifier.padding(start = 6.dp, top = 6.dp).clickable { onToggle() }, verticalAlignment = Alignment.CenterVertically) {
                    Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("${t.steps.size} step${if (t.steps.size == 1) "" else "s"} · ${t.steps.take(3).joinToString(", ") { it.label.lowercase() }}${if (t.steps.size > 3) "…" else ""}", color = cs.onSurfaceVariant, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (expanded) StepTimeline(t.steps, done = true, decode = decode, showMedia = false)
            }
        }
    }
}

@Composable
private fun Label(text: String, color: Color) {
    Text(text.uppercase(), color = color, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.8.sp, modifier = Modifier.padding(bottom = 6.dp))
}

@Composable
private fun CardChip(c: AssistantCard, onClick: () -> Unit) {
    val pdfEmerald = Color(0xFF10B981)
    val isPdf = c.kind == "pdf" || c.title.contains("pdf", ignoreCase = true)
    val icon = when {
        c.kind == "results" -> Icons.Default.Inbox
        c.kind == "approvals" -> Icons.Default.Verified
        c.kind == "choice" -> Icons.Default.TouchApp
        c.kind == "recon" -> Icons.Default.Shield
        isPdf -> Icons.Default.Download
        else -> Icons.Default.OpenInNew
    }

    if (c.kind == "choice") {
        Button(
            onClick = onClick,
            shape = RoundedCornerShape(12.dp),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Brand.copy(alpha = 0.14f), contentColor = MaterialTheme.colorScheme.onSurface),
            border = BorderStroke(1.dp, Brand.copy(alpha = 0.55f))
        ) {
            Icon(icon, null, tint = Brand, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(6.dp))
            Text(c.title.ifBlank { "Yes" }, fontSize = 13.sp)
        }
    } else if (isPdf) {
        AssistChip(
            onClick = onClick,
            label = { Text(c.title.ifBlank { "Save Report as PDF" }, fontSize = 12.sp, fontWeight = FontWeight.SemiBold) },
            leadingIcon = { Icon(icon, null, tint = pdfEmerald, modifier = Modifier.size(15.dp)) },
            colors = AssistChipDefaults.assistChipColors(
                containerColor = pdfEmerald.copy(alpha = 0.12f),
                labelColor = pdfEmerald
            ),
            border = AssistChipDefaults.assistChipBorder(enabled = true, borderColor = pdfEmerald.copy(alpha = 0.6f))
        )
    } else {
        AssistChip(
            onClick = onClick,
            label = {
                Text(
                    c.title.ifBlank {
                        when (c.kind) {
                            "results" -> "Open results"
                            "approvals" -> "Open approvals"
                            "recon" -> "Open ReconForge"
                            else -> "Open"
                        }
                    },
                    fontSize = 12.sp
                )
            },
            leadingIcon = { Icon(icon, null, tint = Brand, modifier = Modifier.size(15.dp)) },
            border = AssistChipDefaults.assistChipBorder(enabled = true, borderColor = Brand.copy(alpha = 0.5f))
        )
    }
}

/** Chips that wrap onto the next line instead of squeezing each other (a chunked Row shrank the third chip to one character per line). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlowRowCompat(items: List<@Composable () -> Unit>) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) { items.forEach { it() } }
}

@Composable
private fun StepTimeline(steps: List<AssistantStep>, done: Boolean, current: Boolean = false, decode: ((String) -> androidx.compose.ui.graphics.ImageBitmap?)? = null, showMedia: Boolean = true) {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.padding(start = 8.dp, top = 6.dp, end = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        steps.forEachIndexed { i, s ->
            val last = i == steps.lastIndex
            Row(verticalAlignment = Alignment.Top) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(14.dp)) {
                    if (current && last) PulseDot(Brand, 8) else Box(Modifier.padding(top = 5.dp).size(6.dp).clip(CircleShape).background(if (done || !last) cs.onSurfaceVariant else Brand))
                }
                Spacer(Modifier.width(6.dp))
                Column(Modifier.weight(1f)) {
                    Text(s.label, color = cs.onSurface, fontSize = 13.sp)
                    val sub = s.args.takeIf { it.isNotBlank() && it != "{}" }?.let { humanArgs(it) } ?: ""
                    if (sub.isNotBlank()) Text(sub, color = cs.onSurfaceVariant, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    // the server sends a human line per result; raw JSON (older turns) stays hidden
                    if (s.text.isNotBlank() && !s.text.trimStart().startsWith("{") && !s.text.trimStart().startsWith("[") && (done || !last)) Text(s.text.take(160), color = cs.onSurfaceVariant, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (showMedia) StepMedia(s, decode, showRecording = !done)
                }
            }
        }
    }
}

/** The media a step produced — a picture (with Save), or a file card (play/open + Save). Shown in the answer for done turns, in the timeline while live. */
@Composable
private fun StepMedia(s: AssistantStep, decode: ((String) -> androidx.compose.ui.graphics.ImageBitmap?)?, inAnswer: Boolean = false, showRecording: Boolean = true) {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth()) {
                    // a recording this step started: its live card, right where it began (a finished turn shows it in the answer instead)
                    if (s.recording.isNotBlank() && !inAnswer && showRecording) RecordingCard(s.recording, Modifier.padding(top = 6.dp))
                    // a captured FILE that is not a picture (a video, a PDF, an export): a card with Save
                    if (s.download.isNotBlank() && s.imageData.isBlank()) {
                        val saveF = AssistantHooks.saveFile
                        var saved by remember(s.download) { mutableStateOf(s.download in AssistantHooks.autoSaved) }
                        Surface(color = cs.surfaceVariant.copy(alpha = 0.6f), shape = RoundedCornerShape(10.dp), modifier = Modifier.padding(top = 6.dp).fillMaxWidth()) {
                            // kind from the server when it sends one; the file name tells the rest (an older server, a bare download)
                            val ext = s.fileName.substringAfterLast('.', "").lowercase()
                            val isAudio = s.fileKind == "audio" || s.fileMime.startsWith("audio/") || ext in setOf("mp3", "wav", "m4a", "ogg", "aac", "flac", "opus")
                            val isVideo = s.fileKind == "video" || s.fileMime.startsWith("video/") || ext in setOf("mp4", "webm", "mov", "mkv")
                            val media = isAudio || isVideo
                            val play = AssistantHooks.playMedia
                            val nowPlaying = AssistantHooks.playing.value == s.download
                            Row(Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                // a song or a clip plays from the card, like a picture shows
                                if (media && play != null) {
                                    FilledIconButton(onClick = { play(s.download, s.fileName, s.fileMime) }, modifier = Modifier.size(36.dp), colors = IconButtonDefaults.filledIconButtonColors(containerColor = Brand, contentColor = BrandOn)) {
                                        Icon(if (nowPlaying) Icons.Default.Stop else if (isAudio) Icons.Default.PlayArrow else Icons.Default.PlayCircle, if (isAudio) "Play" else "Open", modifier = Modifier.size(20.dp))
                                    }
                                } else Icon(Icons.Default.InsertDriveFile, null, tint = Brand, modifier = Modifier.size(18.dp))
                                Spacer(Modifier.width(8.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(s.fileName.ifBlank { "file" }, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    if (media) Text(if (nowPlaying) "playing…" else if (isAudio) "tap to play" else "tap to open in the player", fontSize = 11.sp, color = cs.onSurfaceVariant)
                                }
                                if (saveF != null) TextButton(onClick = { saveF(s.download, s.fileName); saved = true }, contentPadding = PaddingValues(horizontal = 8.dp)) { Icon(if (saved) Icons.Default.Check else Icons.Default.Download, null, modifier = Modifier.size(14.dp)); Spacer(Modifier.width(4.dp)); Text(if (saved) "Saved" else "Save", fontSize = 12.sp) }
                            }
                        }
                    }
                    // the picture the tool took — what the agent was looking at
                    if (s.imageData.isNotBlank() && decode != null) {
                        val bmp = remember(s.imageData) { try { decode(s.imageData) } catch (e: Throwable) { null } }
                        if (bmp != null) {
                            androidx.compose.foundation.Image(bmp, contentDescription = "what the agent saw", modifier = Modifier.padding(top = 6.dp).fillMaxWidth().heightIn(max = 260.dp).clip(RoundedCornerShape(10.dp)), contentScale = androidx.compose.ui.layout.ContentScale.FillWidth, alignment = Alignment.TopCenter)
                            // the file itself (a generated image) or the frame: one tap saves it to the device
                            val save = AssistantHooks.saveImage
                            if (save != null) {
                                var saved by remember(s.imageData) { mutableStateOf(false) }
                                val name = s.fileName.ifBlank { s.image.substringAfterLast('/').ifBlank { "ghost-picture.jpg" } }
                                AssistChip(onClick = { save(s.imageData, name); saved = true }, modifier = Modifier.padding(top = 4.dp),
                                    label = { Text(if (saved) "Saved to device" else if (s.download.isNotBlank()) "Save ${s.fileName.ifBlank { "file" }}" else "Save picture", fontSize = 11.sp) },
                                    leadingIcon = { Icon(if (saved) Icons.Default.Check else Icons.Default.Download, null, tint = Brand, modifier = Modifier.size(14.dp)) })
                            }
                        }
                    }
    }
}

/** {"watcherId":"facebook-post-watcher","seconds":300} → watcherId facebook-post-watcher · seconds 300 */
private fun humanArgs(json: String): String = Regex("\"([^\"]+)\"\\s*:\\s*(\"([^\"]*)\"|[^,}]+)").findAll(json)
    .joinToString(" · ") { m -> m.groupValues[1] + " " + (m.groups[3]?.value ?: m.groupValues[2]).take(60) }.take(140)

/* ── live turn ─────────────────────────────────────────────────────────────────────────────────── */
@Composable
private fun LiveCard(live: AssistantLive, onStop: () -> Unit, decode: ((String) -> androidx.compose.ui.graphics.ImageBitmap?)? = null) {
    val cs = MaterialTheme.colorScheme
    var now by remember { mutableStateOf(0L) }
    LaunchedEffect(live.jobId) { while (true) { now = currentTimeMillisCompat(); delay(1000) } }
    val secs = if (live.startedAt > 0 && now > 0) ((now - live.startedAt) / 1000).coerceAtLeast(0) else 0
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Box(Modifier.padding(top = 6.dp, end = 10.dp).size(22.dp).clip(CircleShape).background(Brand.copy(alpha = 0.18f)), contentAlignment = Alignment.Center) { PulseDot(Brand, 8) }
        Surface(color = cs.surface, contentColor = cs.onSurface, shape = RoundedCornerShape(4.dp, 18.dp, 18.dp, 18.dp), border = BorderStroke(1.dp, Brand.copy(alpha = 0.45f)), modifier = Modifier.weight(1f)) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
                val stopping = live.status == "stopping"
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(if (stopping) "Stopping…" else live.steps.lastOrNull()?.label ?: "Thinking it through…", Modifier.weight(1f), fontSize = 14.sp, fontWeight = FontWeight.Medium)
                    Text(if (secs >= 60) "${secs / 60}m ${secs % 60}s" else "${secs}s", color = cs.onSurfaceVariant, fontSize = 11.sp)
                }
                if (live.tasks.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    live.tasks.forEach { tk ->
                        Row(verticalAlignment = Alignment.Top, modifier = Modifier.padding(vertical = 2.dp)) {
                            Icon(if (tk.done) Icons.Default.CheckCircle else Icons.Default.RadioButtonUnchecked, null, tint = if (tk.done) Brand else cs.onSurfaceVariant, modifier = Modifier.size(15.dp).padding(top = 1.dp))
                            Spacer(Modifier.width(7.dp))
                            Text(tk.title, color = if (tk.done) cs.onSurfaceVariant else cs.onSurface, fontSize = 13.sp, lineHeight = 17.sp)
                        }
                    }
                }
                if (live.steps.isNotEmpty()) StepTimeline(live.steps.takeLast(4), done = false, current = true, decode = decode)
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(if (stopping) "Wrapping up — the browser stops within a few seconds." else "You can keep typing — it reads while it works.", color = cs.onSurfaceVariant, fontSize = 11.sp, modifier = Modifier.weight(1f))
                    TextButton(onClick = onStop, enabled = !stopping, contentPadding = PaddingValues(horizontal = 8.dp)) { Icon(Icons.Default.Stop, null, modifier = Modifier.size(14.dp)); Spacer(Modifier.width(4.dp)); Text(if (stopping) "Stopping" else "Stop", fontSize = 12.sp) }
                }
            }
        }
    }
}

/** kotlin.time is fine in commonMain but a plain clock keeps this file dependency-free. */
expect fun currentTimeMillisCompat(): Long

/* ── empty, connect, error ─────────────────────────────────────────────────────────────────────── */
@Composable
private fun EmptyState(agentType: String, onSend: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val isRecon = agentType == "recon"
    val accentColor = if (isRecon) Color(0xFFE5484D) else Brand
    val suggestions = if (isRecon) RECON_SUGGESTIONS else ASSISTANT_SUGGESTIONS
    Column(Modifier.fillMaxWidth().padding(top = 24.dp, bottom = 8.dp)) {
        Box(Modifier.size(44.dp).clip(CircleShape).background(accentColor.copy(alpha = 0.18f)), contentAlignment = Alignment.Center) {
            Icon(if (isRecon) Icons.Default.Security else Icons.Default.AutoAwesome, null, tint = accentColor, modifier = Modifier.size(22.dp))
        }
        Spacer(Modifier.height(14.dp))
        Text(if (isRecon) "Security Recon & Red Team" else "What can I do for you?", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        Text(
            if (isRecon) "I am your dedicated AppSec & Red-Team auditing agent. I inspect perimeter security, instrument DOM sinks, test postMessage boundaries, audit client storage hygiene, introspect GraphQL schemas, and verify BOLA tenant isolation."
            else "I run inside your Ghost Browser with your logins. Ask a question, hand me a task, or tell me what to keep an eye on — I'll read what your watchers already gathered, run them, browse, or build what's missing.",
            color = cs.onSurfaceVariant, fontSize = 14.sp, lineHeight = 20.sp
        )
        Spacer(Modifier.height(18.dp))
        Text(if (isRecon) "SUGGESTED RECON SCANS" else "TRY", color = cs.onSurfaceVariant, fontSize = 10.sp, letterSpacing = 1.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        val promptChips = if (isRecon) RECON_PROMPT_CHIPS else ASSISTANT_PROMPT_CHIPS
        promptChips.forEach { chip ->
            Surface(
                color = cs.surface,
                shape = RoundedCornerShape(14.dp),
                border = BorderStroke(1.dp, cs.outline.copy(alpha = 0.6f)),
                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp).clickable { onSend(chip.prompt) }
            ) {
                Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(chip.title, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
                        Spacer(Modifier.height(2.dp))
                        Text(chip.subtitle, fontSize = 12.sp, color = cs.onSurfaceVariant)
                    }
                    Icon(Icons.Default.ArrowForward, null, tint = accentColor, modifier = Modifier.size(16.dp))
                }
            }
        }
    }
}

@Composable
private fun ConnectCard(onConnect: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, cs.outline), modifier = Modifier.fillMaxWidth().padding(top = 20.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text("Your agent lives on your Ghost Browser", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            Spacer(Modifier.height(4.dp))
            Text("Connect this device to it once — then it browses with your logins, runs your watchers and answers here.", color = cs.onSurfaceVariant, fontSize = 13.sp, lineHeight = 18.sp)
            Spacer(Modifier.height(12.dp))
            Button(onClick = onConnect, shape = RoundedCornerShape(12.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) { Text("Connect") }
        }
    }
}

@Composable
private fun ErrorRow(msg: String) {
    Surface(color = Color(0xFFE5484D).copy(alpha = 0.12f), shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.ErrorOutline, null, tint = Color(0xFFE5484D), modifier = Modifier.size(16.dp)); Spacer(Modifier.width(8.dp))
            Text(msg, color = MaterialTheme.colorScheme.onSurface, fontSize = 13.sp)
        }
    }
}

/* ── composer ──────────────────────────────────────────────────────────────────────────────────── */
@Composable
private fun Composer(working: Boolean, connected: Boolean, onSend: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var text by remember { mutableStateOf("") }
    val border by animateColorAsState(if (working) Brand.copy(alpha = 0.6f) else cs.outline.copy(alpha = 0.5f), label = "b")
    Row(Modifier.fillMaxWidth().background(cs.surface.copy(alpha = 0.88f)).padding(10.dp), verticalAlignment = Alignment.Bottom) {
        Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(22.dp), border = BorderStroke(1.dp, border), modifier = Modifier.weight(1f)) {
            BasicTextField(text, { text = it }, textStyle = TextStyle(color = cs.onSurface, fontSize = 15.sp), cursorBrush = SolidColor(Brand), maxLines = 5,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                decorationBox = { inner -> if (text.isEmpty()) Text(if (working) "Add something while I work…" else "Ask anything, or tell me what to do…", color = cs.onSurfaceVariant, fontSize = 15.sp); inner() })
        }
        Spacer(Modifier.width(8.dp))
        val can = text.isNotBlank() && connected
        FilledIconButton(onClick = { if (can) { onSend(text.trim()); text = "" } }, enabled = can, modifier = Modifier.size(46.dp),
            colors = IconButtonDefaults.filledIconButtonColors(containerColor = Brand, contentColor = BrandOn, disabledContainerColor = cs.surfaceVariant)) { Icon(Icons.Default.ArrowUpward, "Send") }
    }
}

/* ── history ───────────────────────────────────────────────────────────────────────────────────── */
@Composable
private fun HistorySheet(
    chats: List<ChatSummary>,
    currentId: String?,
    initialAgent: String = "all",
    onOpen: (String) -> Unit,
    onDelete: (String) -> Unit,
    onNewWithAgent: (String) -> Unit,
    onClose: () -> Unit
) {
    val cs = MaterialTheme.colorScheme
    // Agent picker: "all" | "browser" | "recon"
    var filter by remember { mutableStateOf(if (initialAgent == "recon") "recon" else "all") }

    val filteredChats = remember(chats, filter) {
        when (filter) {
            "browser" -> chats.filter { it.agentType != "recon" }
            "recon" -> chats.filter { it.agentType == "recon" }
            else -> chats
        }
    }

    val browserCount = remember(chats) { chats.count { it.agentType != "recon" } }
    val reconCount = remember(chats) { chats.count { it.agentType == "recon" } }

    Box(Modifier.fillMaxSize().background(Color(0x99000000)).clickable { onClose() }, contentAlignment = Alignment.BottomCenter) {
        Surface(color = cs.surface, contentColor = cs.onSurface, shape = RoundedCornerShape(20.dp, 20.dp, 0.dp, 0.dp), tonalElevation = 6.dp, modifier = Modifier.fillMaxWidth().clickable(enabled = false) {}) {
            Column(Modifier.padding(top = 10.dp, bottom = 18.dp).heightIn(max = 520.dp)) {
                Box(Modifier.align(Alignment.CenterHorizontally).width(36.dp).height(4.dp).clip(CircleShape).background(cs.outline))

                // Header with dynamic New button matching active filter
                Row(Modifier.padding(horizontal = 18.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Chat History", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    TextButton(onClick = { onNewWithAgent(if (filter == "recon") "recon" else "browser") }) {
                        Icon(Icons.Default.Add, null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(4.dp))
                        Text(if (filter == "recon") "New Recon" else "New Chat")
                    }
                }

                // Agent Picker Segmented Filter Tabs
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    // All chats filter
                    FilterChip(
                        selected = filter == "all",
                        onClick = { filter = "all" },
                        label = { Text("All (" + chats.size + ")", fontSize = 11.5.sp) },
                        modifier = Modifier.weight(1f),
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = cs.primary.copy(alpha = 0.2f),
                            selectedLabelColor = cs.primary
                        )
                    )

                    // Browser Agent filter
                    FilterChip(
                        selected = filter == "browser",
                        onClick = { filter = "browser" },
                        leadingIcon = { Icon(Icons.Default.Public, null, modifier = Modifier.size(13.dp)) },
                        label = { Text("Browser (" + browserCount + ")", fontSize = 11.5.sp) },
                        modifier = Modifier.weight(1.2f),
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = Brand.copy(alpha = 0.2f),
                            selectedLabelColor = Brand
                        )
                    )

                    // Security Recon filter
                    FilterChip(
                        selected = filter == "recon",
                        onClick = { filter = "recon" },
                        leadingIcon = { Icon(Icons.Default.Security, null, modifier = Modifier.size(13.dp)) },
                        label = { Text("Recon (" + reconCount + ")", fontSize = 11.5.sp) },
                        modifier = Modifier.weight(1.2f),
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = Color(0xFFE5484D).copy(alpha = 0.2f),
                            selectedLabelColor = Color(0xFFE5484D)
                        )
                    )
                }

                Spacer(Modifier.height(8.dp))

                if (filteredChats.isEmpty()) {
                    Box(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 24.dp), contentAlignment = Alignment.Center) {
                        Text(
                            when (filter) {
                                "recon" -> "No Security Recon chats yet.\nTap 'New Recon' to start an audit."
                                "browser" -> "No Browser Agent chats yet.\nTap 'New Chat' to start browsing."
                                else -> "No chats found."
                            },
                            color = cs.onSurfaceVariant,
                            fontSize = 13.sp,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center
                        )
                    }
                }

                Column(Modifier.verticalScroll(rememberScrollState())) {
                    filteredChats.forEach { c ->
                        val isReconChat = c.agentType == "recon"
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable { onOpen(c.id) }
                                .background(if (c.id == currentId) (if (isReconChat) Color(0xFFE5484D).copy(alpha = 0.12f) else Brand.copy(alpha = 0.10f)) else Color.Transparent)
                                .padding(horizontal = 18.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    if (c.running) { PulseDot(if (isReconChat) Color(0xFFE5484D) else Brand, 7); Spacer(Modifier.width(6.dp)) }
                                    Surface(
                                        color = if (isReconChat) Color(0xFFE5484D).copy(alpha = 0.18f) else Brand.copy(alpha = 0.18f),
                                        shape = RoundedCornerShape(4.dp),
                                        modifier = Modifier.padding(end = 6.dp)
                                    ) {
                                        Text(if (isReconChat) "RECON" else "BROWSER", color = if (isReconChat) Color(0xFFE5484D) else Brand, fontSize = 9.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp))
                                    }
                                    Text(c.title.ifBlank { if (isReconChat) "Security Recon Audit" else "New chat" }, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                                Text(c.turns.toString() + " message" + (if (c.turns == 1) "" else "s") + " · " + ago(c.updatedAt), color = cs.onSurfaceVariant, fontSize = 11.sp)
                            }
                            if (!c.running) IconButton(onClick = { onDelete(c.id) }) { Icon(Icons.Default.DeleteOutline, "Delete", tint = cs.onSurfaceVariant, modifier = Modifier.size(18.dp)) }
                        }
                    }
                }
            }
        }
    }
}

private fun ago(t: Long): String {
    if (t <= 0) return ""
    val d = (currentTimeMillisCompat() - t) / 1000
    return when { d < 60 -> "just now"; d < 3600 -> "${d / 60} min ago"; d < 86400 -> "${d / 3600} h ago"; else -> "${d / 86400} d ago" }
}

@Composable
fun AgentToggleBar(ui: AssistantUi, act: AssistantActions) {
    val cs = MaterialTheme.colorScheme
    val isBrowser = ui.selectedAgent.value != "recon"
    val isRecon = ui.selectedAgent.value == "recon"

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(cs.surface.copy(alpha = 0.95f))
            .padding(horizontal = 14.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Surface(
            modifier = Modifier.weight(1f).height(38.dp).clickable {
                ui.selectedAgent.value = "browser"
                val curr = ui.chat.value
                if (curr == null || curr.agentType == "recon") {
                    val browserChat = ui.chats.value.firstOrNull { it.agentType != "recon" }
                    if (browserChat != null) act.onOpen(browserChat.id) else (act.onNewWithAgent?.invoke("browser") ?: act.onNew())
                }
            },
            shape = RoundedCornerShape(10.dp),
            color = if (isBrowser) Brand else cs.surfaceVariant.copy(alpha = 0.6f),
            contentColor = if (isBrowser) BrandOn else cs.onSurfaceVariant
        ) {
            Row(modifier = Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
                Icon(Icons.Default.Public, null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Browser Agent", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
        }

        Surface(
            modifier = Modifier.weight(1f).height(38.dp).clickable {
                ui.selectedAgent.value = "recon"
                val curr = ui.chat.value
                if (curr == null || curr.agentType != "recon") {
                    val reconChat = ui.chats.value.firstOrNull { it.agentType == "recon" }
                    if (reconChat != null) act.onOpen(reconChat.id) else (act.onNewWithAgent?.invoke("recon") ?: act.onNew())
                }
            },
            shape = RoundedCornerShape(10.dp),
            color = if (isRecon) Color(0xFFE5484D) else cs.surfaceVariant.copy(alpha = 0.6f),
            contentColor = if (isRecon) Color.White else cs.onSurfaceVariant
        ) {
            Row(modifier = Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
                Icon(Icons.Default.Security, null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Security Recon", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}
