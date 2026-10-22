package engineer.myapp.gb.shared

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * One platform's state as data — shared by phone, desktop and web (the shared UI, fed by each
 * platform's own repo). `watchRole` is the agent role a Watch would start (empty = this platform
 * can't be watched from here).
 */
data class PlatformState(
    val key: String,
    val label: String,
    val site: String,
    val signedIn: Boolean,
    val watchRole: String = "",
)

/**
 * One open browser session, as the console sees it. `job` names what is holding it (empty = idle),
 * and `yours` is false for a session another key opened — the console sees every session on the
 * install, which is what makes "this profile is busy" explainable instead of mysterious.
 */
data class SessionState(
    val id: String,
    val profile: String,
    val url: String = "",
    val owner: String = "",
    val yours: Boolean = true,
    val job: String = "",
)

/** The Accounts summary: the connected / sign-in / live counts + the platforms behind them. */
data class PlatformsSummary(
    val connected: Int,
    val needSignin: Int,
    val live: Int,
    val platforms: List<PlatformState>,
    /** The sessions behind the Live count. Defaults to empty so phone and desktop are unchanged. */
    val sessions: List<SessionState> = emptyList(),
)

/**
 * The Accounts panel — the "19 connected · 3 sign-in · 2 live" strip and the per-platform rows with a
 * Watch button. Lives in commonMain so it renders identically on phone, desktop and web; each platform
 * feeds it a [PlatformsSummary] and wires the callbacks. [signedOutAction] labels the button for a
 * platform that is not signed in (on web = "use the app"; on phone/desktop = "Sign in").
 */
@Composable
fun PlatformsPanel(
    summary: PlatformsSummary?,
    onWatch: (PlatformState) -> Unit,
    onOpen: (PlatformState) -> Unit,
    onSignedOut: (PlatformState) -> Unit,
    signedOutAction: String,
    onRefresh: () -> Unit = {},
    /** Stop one open session. Default no-op keeps phone and desktop compiling untouched. */
    onStopSession: (SessionState) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val cs = MaterialTheme.colorScheme
    /* The Live count was a dead number: it said a profile was busy but gave no way to see or free it.
       Tapping it opens the sessions behind it, each with a Stop. */
    val showSessions = androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    Column(modifier.fillMaxWidth().background(cs.background).verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Accounts", style = MaterialTheme.typography.headlineSmall)
                Text("Every platform your Ghost Browser can work in", color = cs.onSurfaceVariant, fontSize = 12.sp)
            }
            androidx.compose.material3.TextButton(onClick = onRefresh) { Text("Refresh") }
        }
        Spacer(Modifier.height(14.dp))

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatTile("Connected", summary?.connected ?: 0, Brand, Modifier.weight(1f))
            StatTile("Sign in", summary?.needSignin ?: 0, cs.onSurfaceVariant, Modifier.weight(1f))
            StatTile("Live", summary?.live ?: 0, Brand, Modifier.weight(1f),
                onClick = { showSessions.value = !showSessions.value })
        }

        val sessions = summary?.sessions.orEmpty()
        if (showSessions.value) {
            Spacer(Modifier.height(12.dp))
            if (sessions.isEmpty()) {
                Text("No open sessions.", color = cs.onSurfaceVariant, fontSize = 13.sp)
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    sessions.forEach { s -> SessionRow(s, onStopSession) }
                }
            }
        }
        Spacer(Modifier.height(16.dp))

        val platforms = summary?.platforms.orEmpty().sortedByDescending { it.signedIn }
        if (platforms.isEmpty()) {
            Text("Loading your platforms…", color = cs.onSurfaceVariant, fontSize = 13.sp)
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                platforms.forEach { p -> PlatformRow(p, onWatch, onOpen, onSignedOut, signedOutAction) }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun StatTile(
    label: String,
    n: Int,
    accent: androidx.compose.ui.graphics.Color,
    modifier: Modifier,
    onClick: (() -> Unit)? = null,
) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(14.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, cs.outline),
        modifier = if (onClick != null) modifier.clickable { onClick() } else modifier) {
        Column(Modifier.padding(vertical = 14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("$n", color = accent, fontSize = 26.sp, fontWeight = FontWeight.Bold)
            Text(label.uppercase(), color = cs.onSurfaceVariant, fontSize = 10.sp, fontWeight = FontWeight.Medium)
        }
    }
}

/**
 * One open session: which profile it holds, where it is, and what is holding it — plus the Stop that
 * frees the profile. This is the way out of "that profile is busy": you can see what has it.
 */
@Composable
private fun SessionRow(s: SessionState, onStop: (SessionState) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(12.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, cs.outline), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(s.profile.ifBlank { "(default)" }, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                    if (s.job.isNotBlank()) {
                        Spacer(Modifier.width(8.dp))
                        Text("held by ${s.job}", color = cs.onSurfaceVariant, fontSize = 11.sp)
                    }
                    if (!s.yours && s.owner.isNotBlank()) {
                        Spacer(Modifier.width(8.dp))
                        Text(s.owner, color = cs.onSurfaceVariant, fontSize = 11.sp)
                    }
                }
                if (s.url.isNotBlank()) {
                    Text(s.url, color = cs.onSurfaceVariant, fontSize = 11.sp, maxLines = 1)
                }
            }
            Spacer(Modifier.width(10.dp))
            Button(onClick = { onStop(s) }, shape = RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(containerColor = cs.surfaceVariant, contentColor = cs.onSurface)) {
                Text("Stop", fontSize = 13.sp)
            }
        }
    }
}

@Composable
private fun PlatformRow(
    p: PlatformState,
    onWatch: (PlatformState) -> Unit,
    onOpen: (PlatformState) -> Unit,
    onSignedOut: (PlatformState) -> Unit,
    signedOutAction: String,
) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(12.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, cs.outline), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().clickable { onOpen(p) }.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(9.dp).clip(CircleShape).background(if (p.signedIn) Brand else cs.onSurfaceVariant))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(p.label, color = cs.onSurface, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                Text(if (p.signedIn) "signed in · ${p.site}" else "not signed in · ${p.site}", color = cs.onSurfaceVariant, fontSize = 11.sp)
            }
            if (p.signedIn && p.watchRole.isNotBlank()) {
                Button(onClick = { onWatch(p) }, shape = RoundedCornerShape(10.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 6.dp)) {
                    Text("Watch", fontSize = 13.sp)
                }
            } else if (!p.signedIn) {
                Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.clickable { onSignedOut(p) }) {
                    Text(signedOutAction, color = cs.onSurface, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp))
                }
            }
        }
    }
}
