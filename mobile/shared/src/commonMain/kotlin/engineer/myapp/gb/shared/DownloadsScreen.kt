package engineer.myapp.gb.shared

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
 * DOWNLOADS — every file the cluster browser captured (a real download, a file a tab showed, a picture
 * taken out of a page, a song fetched from a CDN), like any browser's downloads list: name, kind, size,
 * when, from where. A song plays here, a clip opens, anything saves to the device, and a file can go.
 * Same screen on phone and desktop; the platform supplies the list and the hooks.
 */
class DownloadsUi {
    val files = mutableStateOf<List<FileInfo>>(emptyList())
    val recordings = mutableStateOf<List<RecordingInfo>>(emptyList())   // screen recordings, newest first (live ones on top)
    val recordingsFreeBytes = mutableStateOf(0L)
    val loading = mutableStateOf(false)
}
class DownloadsActions(val onRefresh: () -> Unit, val onDelete: (id: String) -> Unit, val onClose: () -> Unit, val onDeleteRecording: ((id: String) -> Unit)? = null)

private fun sizeOf(b: Long) = when { b >= 1_048_576 -> "${(b * 10 / 1_048_576) / 10.0} MB"; b >= 1024 -> "${b / 1024} KB"; else -> "$b B" }
private fun agoOf(t: Long): String { if (t <= 0) return ""; val d = (currentTimeMillisCompat() - t) / 1000; return when { d < 60 -> "just now"; d < 3600 -> "${d / 60} min ago"; d < 86400 -> "${d / 3600} h ago"; else -> "${d / 86400} d ago" } }
private fun kindIcon(k: String) = when (k) { "image", "screenshot" -> Icons.Default.Image; "video" -> Icons.Default.Movie; "audio" -> Icons.Default.MusicNote; "document" -> Icons.Default.Description; "archive" -> Icons.Default.FolderZip; else -> Icons.Default.InsertDriveFile }

@Composable
fun DownloadsScreen(ui: DownloadsUi, act: DownloadsActions, modifier: Modifier = Modifier, topInset: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    LaunchedEffect(Unit) { act.onRefresh() }
    Column(modifier.fillMaxSize().background(cs.background).then(topInset)) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 6.dp, top = 12.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Downloads", style = MaterialTheme.typography.headlineSmall, color = cs.onSurface)
                Text("Every file your Ghost Browser captured — play it, save it to this device, or let it go", color = cs.onSurfaceVariant, fontSize = 12.sp)
            }
            IconButton(onClick = act.onRefresh) { if (ui.loading.value) CircularProgressIndicator(Modifier.size(18.dp), color = Brand, strokeWidth = 2.dp) else Icon(Icons.Default.Refresh, "Refresh", tint = cs.onSurfaceVariant) }
            IconButton(onClick = act.onClose) { Icon(Icons.Default.Close, "Close", tint = cs.onSurfaceVariant) }
        }
        if (ui.files.value.isEmpty() && ui.recordings.value.isEmpty() && !ui.loading.value) {
            Text("Nothing captured yet. When the agent downloads a file, generates a picture or a song, records a video, or a page hands one over, it lands here.", color = cs.onSurfaceVariant, fontSize = 13.sp, modifier = Modifier.padding(16.dp))
        }
        // a live recording refreshes its numbers while this screen is open
        val anyLive = ui.recordings.value.any { it.running }
        LaunchedEffect(anyLive) { while (anyLive) { kotlinx.coroutines.delay(5000); act.onRefresh() } }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (ui.recordings.value.isNotEmpty()) {
                item(key = "rec-head") {
                    Row(Modifier.padding(top = 4.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Videocam, null, tint = Brand, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(6.dp))
                        Text("Recordings", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface, modifier = Modifier.weight(1f))
                        val freeGb = ui.recordingsFreeBytes.value / 1_073_741_824
                        // the disk is a budget: under 5 GB the number turns to a warning, under 2 GB a recording refuses to start
                        if (ui.recordingsFreeBytes.value > 0) Text(if (freeGb < 2) "$freeGb GB free — recordings will refuse to start" else if (freeGb < 5) "$freeGb GB free — getting full" else "$freeGb GB free", color = if (freeGb < 5) cs.error else cs.onSurfaceVariant, fontSize = 11.sp, fontWeight = if (freeGb < 5) FontWeight.SemiBold else FontWeight.Normal)
                    }
                }
                items(ui.recordings.value, key = { "rec-" + it.id }) { r -> RecordingCard(r.id, onDelete = act.onDeleteRecording) }
                if (ui.files.value.isNotEmpty()) item(key = "files-head") {
                    Row(Modifier.padding(top = 10.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Download, null, tint = Brand, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(6.dp))
                        Text("Files", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = cs.onSurface)
                    }
                }
            }
            items(ui.files.value, key = { it.id }) { f -> FileRow(f, act) }
        }
    }
}

@Composable
private fun FileRow(f: FileInfo, act: DownloadsActions) {
    val cs = MaterialTheme.colorScheme
    val isAudio = f.kind == "audio" || f.mime.startsWith("audio/")
    val isVideo = f.kind == "video" || f.mime.startsWith("video/")
    val media = isAudio || isVideo
    val downloadUrl = "/v1/files/${f.id}/raw?download=1"
    val play = AssistantHooks.playMedia; val save = AssistantHooks.saveFile
    val nowPlaying = AssistantHooks.playing.value == downloadUrl
    var saved by remember(f.id) { mutableStateOf(false) }
    var confirm by remember(f.id) { mutableStateOf(false) }
    Surface(color = cs.surface, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, if (nowPlaying) Brand.copy(alpha = 0.6f) else cs.outline.copy(alpha = 0.6f))) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (media && play != null) FilledIconButton(onClick = { play(downloadUrl, f.name, f.mime) }, modifier = Modifier.size(40.dp), colors = IconButtonDefaults.filledIconButtonColors(containerColor = Brand, contentColor = BrandOn)) {
                Icon(if (nowPlaying) Icons.Default.Stop else if (isAudio) Icons.Default.PlayArrow else Icons.Default.PlayCircle, null, modifier = Modifier.size(22.dp))
            } else Box(Modifier.size(40.dp).clip(CircleShape).background(cs.surfaceVariant), contentAlignment = Alignment.Center) { Icon(kindIcon(f.kind), null, tint = Brand, modifier = Modifier.size(20.dp)) }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(f.name, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(listOf(f.kind, sizeOf(f.size), agoOf(f.at), f.source.removePrefix("tab:").removePrefix("page:").removePrefix("link:")).filter { it.isNotBlank() }.joinToString(" · "), color = if (nowPlaying) Brand else cs.onSurfaceVariant, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (nowPlaying) Text("playing…", color = Brand, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            }
            if (save != null) IconButton(onClick = { save(downloadUrl, f.name); saved = true }) { Icon(if (saved) Icons.Default.Check else Icons.Default.Download, "Save to device", tint = if (saved) Brand else cs.onSurfaceVariant) }
            if (!confirm) IconButton(onClick = { confirm = true }) { Icon(Icons.Default.DeleteOutline, "Delete", tint = cs.onSurfaceVariant) }
            else TextButton(onClick = { act.onDelete(f.id) }, contentPadding = PaddingValues(horizontal = 6.dp)) { Text("Delete?", color = cs.error, fontSize = 12.sp) }
        }
    }
}
