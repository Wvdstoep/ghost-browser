package engineer.myapp.gb.shared

import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DevicesOther
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** S9 — ONE Device Hub for phone and desktop: every node on the account, rendered locally. */
@Composable
fun DeviceHubScreen(
    devices: List<HubDevice>,
    summary: String,
    onRefresh: () -> Unit,
    nowMs: Long,
    modifier: Modifier = Modifier,
    topInset: Modifier = Modifier,
) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.background, contentColor = cs.onBackground, modifier = modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().then(topInset)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Device Hub", style = MaterialTheme.typography.headlineSmall)
                    Text(summary.ifBlank { "Every node on your account" }, color = cs.onSurfaceVariant, fontSize = 12.sp)
                }
                IconButton(onClick = onRefresh) { Icon(Icons.Default.Refresh, "Refresh", tint = cs.onSurface) }
            }
            HorizontalDivider(color = cs.outline)
            if (devices.isEmpty()) {
                Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    Icon(Icons.Default.DevicesOther, null, tint = cs.onSurfaceVariant, modifier = Modifier.size(40.dp))
                    Spacer(Modifier.height(10.dp))
                    Text("No devices yet — sign in and connect.", color = cs.onSurfaceVariant, fontSize = 13.sp)
                }
            } else Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                devices.forEach { d -> HubCard(d, nowMs) }
                Spacer(Modifier.height(16.dp))
            }
        }
    }
}

@Composable
private fun HubCard(d: HubDevice, nowMs: Long) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, cs.outline), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(10.dp).clip(CircleShape).background(if (d.online) Brand else cs.onSurfaceVariant))
                Spacer(Modifier.width(10.dp))
                Text(d.name, color = cs.onSurface, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(8.dp)) {
                    Text(d.type, Modifier.padding(horizontal = 10.dp, vertical = 4.dp), color = cs.onSurfaceVariant, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            if (d.owner.isNotBlank()) { Spacer(Modifier.height(2.dp)); Text(d.owner, color = cs.onSurfaceVariant, fontSize = 12.sp, modifier = Modifier.padding(start = 20.dp)) }
            Spacer(Modifier.height(12.dp)); HorizontalDivider(color = cs.outline); Spacer(Modifier.height(12.dp))
            Row {
                HubStat("STATUS", if (d.online) "online" else "offline", if (d.online) Brand else cs.onSurfaceVariant, Modifier.weight(1f))
                HubStat("LAST SEEN", relTime(d.lastSeenMs, nowMs), cs.onSurface, Modifier.weight(1f))
                HubStat("QUEUED", "${d.queued}", cs.onSurface, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun HubStat(label: String, value: String, valueColor: Color, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    Column(modifier) {
        Text(label, color = cs.onSurfaceVariant, fontSize = 9.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(3.dp))
        Text(value, color = valueColor, fontSize = 13.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace)
    }
}

private fun relTime(ms: Long, now: Long): String {
    if (ms <= 0) return "—"
    val s = ((now - ms) / 1000).coerceAtLeast(0)
    return when {
        s < 60 -> "${s}s ago"
        s < 3600 -> "${s / 60}m ago"
        s < 86400 -> "${s / 3600}h ago"
        else -> "${s / 86400}d ago"
    }
}
