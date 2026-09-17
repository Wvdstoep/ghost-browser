package engineer.myapp.gb.shared

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * A RECORDING'S CARD — the same card in the chat (under the answer, live while it records) and in
 * Downloads. State reads at a glance: a pulsing dot and "recording · 12:33 · 340 MB" while it runs,
 * "done · 1:02:10 · 1.9 GB" after, "partial" when a restart cut it. Play streams it (live or whole),
 * Stop ends it, Save downloads the mp4 to the device, Delete lets it go. The platform supplies the
 * live info (RecordingHooks.recordings) and the hands (play / stop / save).
 */
object RecordingHooks {
    /** The recordings the platform knows, by id — refreshed while one runs and whenever the list loads. */
    val recordings = mutableStateOf<Map<String, RecordingInfo>>(emptyMap())
    /** Stream a recording: the playlist while it records, the mp4 after. */
    var play: ((rec: RecordingInfo) -> Unit)? = null
    var stop: ((id: String) -> Unit)? = null
    /** Save the mp4 to the device (streamed, any size). */
    var save: ((rec: RecordingInfo) -> Unit)? = null
    /** Ask the platform for fresh info on one recording (called by a card that has none yet). */
    var refresh: ((id: String) -> Unit)? = null
    /** A share link (a public player page that expires): the platform fetches it and puts it on the clipboard. */
    var share: ((rec: RecordingInfo) -> Unit)? = null
}

fun recordingClock(secs: Int): String { val h = secs / 3600; val m = (secs % 3600) / 60; val s = secs % 60; return if (h > 0) "$h:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}" else "$m:${s.toString().padStart(2, '0')}" }
private fun recordingSize(b: Long) = when { b >= 1_073_741_824 -> "${(b * 10 / 1_073_741_824) / 10.0} GB"; b >= 1_048_576 -> "${b / 1_048_576} MB"; b >= 1024 -> "${b / 1024} KB"; else -> "" }

@Composable
fun RecordingCard(id: String, modifier: Modifier = Modifier, onDelete: ((id: String) -> Unit)? = null) {
    val cs = MaterialTheme.colorScheme
    val rec = RecordingHooks.recordings.value[id]
    LaunchedEffect(id) { if (rec == null) RecordingHooks.refresh?.invoke(id) }
    val running = rec?.running == true
    Surface(color = cs.surface, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, if (running) Brand.copy(alpha = 0.6f) else cs.outline.copy(alpha = 0.6f)), modifier = modifier.fillMaxWidth()) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            val play = RecordingHooks.play
            if (rec != null && rec.playable && play != null) FilledIconButton(onClick = { play(rec) }, modifier = Modifier.size(40.dp), colors = IconButtonDefaults.filledIconButtonColors(containerColor = Brand, contentColor = BrandOn)) {
                Icon(Icons.Default.PlayArrow, "Play", modifier = Modifier.size(22.dp))
            } else Box(Modifier.size(40.dp).clip(CircleShape).background(cs.surfaceVariant), contentAlignment = Alignment.Center) {
                if (rec == null || rec.state == "starting") CircularProgressIndicator(Modifier.size(18.dp), color = Brand, strokeWidth = 2.dp)
                else Icon(if (rec.state == "failed") Icons.Default.ErrorOutline else Icons.Default.Videocam, null, tint = if (rec.state == "failed") cs.error else Brand, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(rec?.name ?: "Recording", fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (running) { PulseDot(Brand, 6); Spacer(Modifier.width(5.dp)) }
                    val line = when {
                        rec == null -> "loading…"
                        rec.queued -> "queued · #${rec.queuePos} · starts when the current recording ends"
                        rec.state == "starting" -> "starting the browser…"
                        rec.state == "recording" -> "recording · ${recordingClock(rec.seconds)} · ${recordingSize(rec.bytes)}"
                        rec.state == "finishing" -> "finishing · ${recordingClock(rec.seconds)}"
                        rec.state == "failed" -> "failed · ${rec.error.ifBlank { rec.reason }}"
                        else -> "${rec.state} · ${recordingClock(rec.seconds)} · ${recordingSize(rec.bytes)}" + (if (rec.chapters > 0) " · ${rec.chapters} chapters" else "") + (if (rec.reason.isNotBlank() && rec.state == "partial") " · ${rec.reason}" else "")
                    }
                    Text(line, color = if (running) Brand else if (rec?.state == "failed") cs.error else cs.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            if (rec != null && (running || rec.queued) && RecordingHooks.stop != null) IconButton(onClick = { RecordingHooks.stop?.invoke(rec.id) }) { Icon(if (rec.queued) Icons.Default.Close else Icons.Default.Stop, if (rec.queued) "Take out of the queue" else "Stop", tint = cs.error) }
            if (rec != null && !running && rec.playable && RecordingHooks.share != null) IconButton(onClick = { RecordingHooks.share?.invoke(rec) }) { Icon(Icons.Default.Share, "Share link", tint = cs.onSurfaceVariant) }
            if (rec != null && !running && rec.playable && RecordingHooks.save != null) {
                var saved by remember(rec.id) { mutableStateOf(false) }
                IconButton(onClick = { RecordingHooks.save?.invoke(rec); saved = true }) { Icon(if (saved) Icons.Default.Check else Icons.Default.Download, "Save to device", tint = if (saved) Brand else cs.onSurfaceVariant) }
            }
            if (rec != null && !running && onDelete != null) {
                var confirm by remember(rec.id) { mutableStateOf(false) }
                if (!confirm) IconButton(onClick = { confirm = true }) { Icon(Icons.Default.DeleteOutline, "Delete", tint = cs.onSurfaceVariant) }
                else TextButton(onClick = { onDelete(rec.id) }, contentPadding = PaddingValues(horizontal = 6.dp)) { Text("Delete?", color = cs.error, fontSize = 12.sp) }
            }
        }
    }
}
