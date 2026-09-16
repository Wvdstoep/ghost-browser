package engineer.myapp.gb.shared

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.OpenInFull
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * S9 — ONE Agent chat for phone and desktop: bubbles, tool chips (tap → dialog), input, and an
 * optional live picture-in-picture ([pip]) of the tab the agent is driving (phone only; desktop
 * passes null). Both platforms feed the message list + callbacks.
 */
@Composable
fun AgentChatScreen(
    title: String,
    messages: List<ChatMsg>,
    busy: Boolean,
    onSend: (String) -> Unit,
    onNew: () -> Unit,
    onSettings: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    pip: ImageBitmap? = null,
    onExpandPip: () -> Unit = {},
    topInset: Modifier = Modifier,
) {
    val cs = MaterialTheme.colorScheme
    var toolView by remember { mutableStateOf<ChatMsg?>(null) }
    Box(modifier.fillMaxSize()) {
        Surface(color = cs.background, contentColor = cs.onBackground, modifier = Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().then(topInset)) {
                Row(Modifier.fillMaxWidth().background(cs.surface).padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    IconButton(onClick = onNew) { Icon(Icons.Default.Add, "New chat", tint = cs.onSurfaceVariant) }
                    IconButton(onClick = onSettings) { Icon(Icons.Default.Tune, "AI settings", tint = cs.onSurfaceVariant) }
                    IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Close", tint = cs.onSurfaceVariant) }
                }
                val scroll = rememberScrollState()
                LaunchedEffect(messages.size, busy) { scroll.animateScrollTo(scroll.maxValue) }
                Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll).padding(horizontal = 14.dp, vertical = 16.dp)) {
                    if (messages.isEmpty()) Text("What can I do for you?\n\nI can browse for you, run your automations, inspect your platforms, or drive your other devices — just ask.",
                        color = cs.onSurfaceVariant, fontSize = 15.sp, modifier = Modifier.padding(top = 24.dp))
                    messages.forEach { m ->
                        when (m.role) {
                            "user" -> Bubble(m.content, true)
                            "assistant" -> Bubble(m.content, false)
                            "tool" -> ToolChip(m.tool ?: "tool") { toolView = m }
                        }
                    }
                    if (busy) Text("…thinking", color = cs.onSurfaceVariant, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
                }
                AgentInput(busy, onSend)
            }
        }
        if (pip != null) {
            Surface(color = cs.surface, shape = RoundedCornerShape(12.dp), border = BorderStroke(2.dp, Brand), tonalElevation = 8.dp,
                modifier = Modifier.align(Alignment.BottomEnd).padding(end = 12.dp, bottom = 88.dp).width(132.dp).clickable { onExpandPip() }) {
                Column {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(7.dp).clip(CircleShape).background(Brand)); Spacer(Modifier.width(6.dp))
                        Text("live", color = cs.onSurface, fontSize = 11.sp, modifier = Modifier.weight(1f))
                        Icon(Icons.Default.OpenInFull, "Expand", tint = cs.onSurfaceVariant, modifier = Modifier.size(13.dp))
                    }
                    Image(bitmap = pip, contentDescription = "what the agent is doing", modifier = Modifier.width(132.dp).height(188.dp), contentScale = ContentScale.Crop, alignment = Alignment.TopCenter)
                }
            }
        }
    }
    toolView?.let { tv ->
        AlertDialog(onDismissRequest = { toolView = null }, confirmButton = { TextButton(onClick = { toolView = null }) { Text("Close") } },
            title = { Text("⚙ ${tv.tool}") }, text = { Column(Modifier.verticalScroll(rememberScrollState())) { Text(tv.content.ifBlank { "(empty)" }, fontFamily = FontFamily.Monospace, fontSize = 12.sp) } })
    }
}

@Composable
private fun Bubble(text: String, user: Boolean) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = if (user) Arrangement.End else Arrangement.Start) {
        Surface(color = if (user) Brand else cs.surface, contentColor = if (user) BrandOn else cs.onSurface,
            shape = RoundedCornerShape(16.dp), border = if (user) null else BorderStroke(1.dp, cs.outline), modifier = Modifier.fillMaxWidth(0.85f)) {
            Text(text, Modifier.padding(horizontal = 13.dp, vertical = 10.dp), fontSize = 15.sp)
        }
    }
}

@Composable
private fun ToolChip(name: String, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(9.dp), modifier = Modifier.padding(bottom = 8.dp).clickable { onClick() }) {
        Text("⚙ $name", Modifier.padding(horizontal = 11.dp, vertical = 7.dp), color = cs.onSurfaceVariant, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
    }
}

@Composable
private fun AgentInput(busy: Boolean, onSend: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var text by remember { mutableStateOf("") }
    Row(Modifier.fillMaxWidth().background(cs.surface).padding(10.dp), verticalAlignment = Alignment.Bottom) {
        Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(20.dp), modifier = Modifier.weight(1f)) {
            BasicTextField(text, { text = it }, textStyle = TextStyle(color = cs.onSurface, fontSize = 15.sp), cursorBrush = SolidColor(Brand),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 11.dp),
                decorationBox = { inner -> if (text.isEmpty()) Text("Message the agent…", color = cs.onSurfaceVariant, fontSize = 15.sp); inner() })
        }
        Spacer(Modifier.width(8.dp))
        FilledIconButton(onClick = { if (!busy && text.isNotBlank()) { onSend(text.trim()); text = "" } }, enabled = !busy,
            colors = IconButtonDefaults.filledIconButtonColors(containerColor = Brand, contentColor = BrandOn)) { Icon(Icons.Default.Send, "Send") }
    }
}
