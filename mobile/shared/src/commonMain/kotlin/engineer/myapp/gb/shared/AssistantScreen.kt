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
)

val ASSISTANT_SUGGESTIONS = listOf(
    "Anything on Facebook I should react to?",
    "What's waiting for my approval?",
    "Keep an eye on replies to my LinkedIn posts",
    "Why did the watcher draft nothing today?",
)

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
                Header(chat, live, ui, onHistory = { act.onRefreshChats(); history = true }, onNew = act.onNew, onSettings = act.onSettings, onClose = act.onClose)
                LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState, contentPadding = PaddingValues(horizontal = 14.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    item {
                        if (!ui.connected.value) ConnectCard(act.onConnect)
                        else if (chat == null || chat.turns.isEmpty()) EmptyState(act.onSend)
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
        if (history) HistorySheet(ui.chats.value, chat?.id, onOpen = { act.onOpen(it); history = false }, onDelete = act.onDelete, onNew = { act.onNew(); history = false }, onClose = { history = false })
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
            Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                if (t.spoken) Text("while it worked", fontSize = 10.sp, color = cs.onSurfaceVariant)
                Text(t.text, fontSize = 15.sp, lineHeight = 21.sp)
            }
        }
    }
}

@Composable
private fun AssistantTurnCard(t: AssistantTurn, expanded: Boolean, onToggle: () -> Unit, onCard: (AssistantCard) -> Unit, onOpenUrl: (String) -> Unit, decode: ((String) -> androidx.compose.ui.graphics.ImageBitmap?)? = null) {
    val cs = MaterialTheme.colorScheme
    val stripe = when (t.status) { "blocked" -> Color(0xFFE0A100); "error", "stopped" -> Color(0xFFE5484D); else -> Color.Transparent }
    var details by remember { mutableStateOf(false) }
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
                        if (t.cards.isNotEmpty()) {
                            Spacer(Modifier.height(10.dp))
                            FlowRowCompat(t.cards.map { c -> { CardChip(c) { onCard(c) } } })
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
                if (expanded) StepTimeline(t.steps, done = true, decode = decode)
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
    // a "choice" card is the agent asking you something: tapping it sends that option as your answer
    val icon = when (c.kind) { "results" -> Icons.Default.Inbox; "approvals" -> Icons.Default.Verified; "choice" -> Icons.Default.TouchApp; else -> Icons.Default.OpenInNew }
    if (c.kind == "choice") Button(onClick = onClick, shape = RoundedCornerShape(12.dp), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Brand.copy(alpha = 0.14f), contentColor = MaterialTheme.colorScheme.onSurface), border = BorderStroke(1.dp, Brand.copy(alpha = 0.55f))) {
        Icon(icon, null, tint = Brand, modifier = Modifier.size(15.dp)); Spacer(Modifier.width(6.dp)); Text(c.title.ifBlank { "Yes" }, fontSize = 13.sp)
    } else AssistChip(onClick = onClick, label = { Text(c.title.ifBlank { when (c.kind) { "results" -> "Open results"; "approvals" -> "Open approvals"; else -> "Open" } }, fontSize = 12.sp) },
        leadingIcon = { Icon(icon, null, tint = Brand, modifier = Modifier.size(15.dp)) }, border = AssistChipDefaults.assistChipBorder(enabled = true, borderColor = Brand.copy(alpha = 0.5f)))
}

/** Chips that wrap onto the next line instead of squeezing each other (a chunked Row shrank the third chip to one character per line). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlowRowCompat(items: List<@Composable () -> Unit>) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) { items.forEach { it() } }
}

@Composable
private fun StepTimeline(steps: List<AssistantStep>, done: Boolean, current: Boolean = false, decode: ((String) -> androidx.compose.ui.graphics.ImageBitmap?)? = null) {
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
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(live.steps.lastOrNull()?.label ?: "Thinking it through…", Modifier.weight(1f), fontSize = 14.sp, fontWeight = FontWeight.Medium)
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
                    Text("You can keep typing — it reads while it works.", color = cs.onSurfaceVariant, fontSize = 11.sp, modifier = Modifier.weight(1f))
                    TextButton(onClick = onStop, contentPadding = PaddingValues(horizontal = 8.dp)) { Icon(Icons.Default.Stop, null, modifier = Modifier.size(14.dp)); Spacer(Modifier.width(4.dp)); Text("Stop", fontSize = 12.sp) }
                }
            }
        }
    }
}

/** kotlin.time is fine in commonMain but a plain clock keeps this file dependency-free. */
expect fun currentTimeMillisCompat(): Long

/* ── empty, connect, error ─────────────────────────────────────────────────────────────────────── */
@Composable
private fun EmptyState(onSend: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().padding(top = 28.dp, bottom = 8.dp)) {
        Box(Modifier.size(44.dp).clip(CircleShape).background(Brand.copy(alpha = 0.18f)), contentAlignment = Alignment.Center) { Icon(Icons.Default.AutoAwesome, null, tint = Brand, modifier = Modifier.size(22.dp)) }
        Spacer(Modifier.height(14.dp))
        Text("What can I do for you?", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        Text("I run inside your Ghost Browser with your logins. Ask a question, hand me a task, or tell me what to keep an eye on — I'll read what your watchers already gathered, run them, browse, or build what's missing.",
            color = cs.onSurfaceVariant, fontSize = 14.sp, lineHeight = 20.sp)
        Spacer(Modifier.height(18.dp))
        Text("TRY", color = cs.onSurfaceVariant, fontSize = 10.sp, letterSpacing = 1.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        ASSISTANT_SUGGESTIONS.forEach { s ->
            Surface(color = cs.surface, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, cs.outline.copy(alpha = 0.6f)), modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp).clickable { onSend(s) }) {
                Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(s, Modifier.weight(1f), fontSize = 14.sp)
                    Icon(Icons.Default.ArrowForward, null, tint = Brand, modifier = Modifier.size(16.dp))
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
private fun HistorySheet(chats: List<ChatSummary>, currentId: String?, onOpen: (String) -> Unit, onDelete: (String) -> Unit, onNew: () -> Unit, onClose: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Box(Modifier.fillMaxSize().background(Color(0x99000000)).clickable { onClose() }, contentAlignment = Alignment.BottomCenter) {
        Surface(color = cs.surface, contentColor = cs.onSurface, shape = RoundedCornerShape(20.dp, 20.dp, 0.dp, 0.dp), tonalElevation = 6.dp, modifier = Modifier.fillMaxWidth().clickable(enabled = false) {}) {
            Column(Modifier.padding(top = 10.dp, bottom = 18.dp).heightIn(max = 480.dp)) {
                Box(Modifier.align(Alignment.CenterHorizontally).width(36.dp).height(4.dp).clip(CircleShape).background(cs.outline))
                Row(Modifier.padding(horizontal = 18.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Chats", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                    TextButton(onClick = onNew) { Icon(Icons.Default.Add, null, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)); Text("New") }
                }
                if (chats.isEmpty()) Text("No chats yet.", color = cs.onSurfaceVariant, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 18.dp, vertical = 12.dp))
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    chats.forEach { c ->
                        Row(Modifier.fillMaxWidth().clickable { onOpen(c.id) }.background(if (c.id == currentId) Brand.copy(alpha = 0.10f) else Color.Transparent).padding(horizontal = 18.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    if (c.running) { PulseDot(Brand, 7); Spacer(Modifier.width(6.dp)) }
                                    Text(c.title.ifBlank { "New chat" }, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                                Text("${c.turns} message${if (c.turns == 1) "" else "s"} · ${ago(c.updatedAt)}", color = cs.onSurfaceVariant, fontSize = 11.sp)
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
