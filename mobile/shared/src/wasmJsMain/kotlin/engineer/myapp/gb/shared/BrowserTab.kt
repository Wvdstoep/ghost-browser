package engineer.myapp.gb.shared

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The live overlay (a native <canvas> the JS module owns) is placed by Compose in CSS pixels.
private fun liveStart(session: String, x: Int, y: Int, w: Int, h: Int): Unit = js("window.gbLive.start(session, x, y, w, h)")
private fun liveResize(x: Int, y: Int, w: Int, h: Int): Unit = js("window.gbLive.resize(x, y, w, h)")
private fun liveStop(): Unit = js("window.gbLive.stop()")

/**
 * The Browser tab. With no session it shows the shared Home (pick a platform to open its real browser);
 * once a session is open it live-views the CLUSTER's Chromium — the robust web equivalent of the
 * desktop's embedded browser. The viewport itself is a native canvas overlay (live-overlay.js) placed
 * exactly over the reserved Compose Box; the chrome around it is all Compose.
 */
@Composable
fun BrowserTab(st: WebState, repo: WebRepo, openExternal: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val hasSession = st.sessionId.value.isNotBlank()

    Column(Modifier.fillMaxSize().background(cs.background)) {
        if (hasSession) {
            // Address bar for the live session.
            var url by remember(st.sessionId.value) { mutableStateOf(st.sessionUrl.value) }
            Surface(color = cs.surface, contentColor = cs.onSurface) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.height(30.dp).clip(RoundedCornerShape(8.dp)).background(Brand).padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
                        Text(st.sessionProfile.value.ifBlank { "live" }, color = BrandOn, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    }
                    Spacer(Modifier.width(6.dp))
                    Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(20.dp), modifier = Modifier.weight(1f).height(40.dp)) {
                        Row(Modifier.padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                            BasicTextField(
                                value = url, onValueChange = { url = it }, singleLine = true, modifier = Modifier.weight(1f),
                                textStyle = TextStyle(color = cs.onSurface, fontSize = 14.sp), cursorBrush = SolidColor(Brand),
                                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                                keyboardActions = KeyboardActions(onGo = { repo.navigate(url) }, onDone = { repo.navigate(url) }),
                                decorationBox = { inner -> if (url.isEmpty()) Text("Search or type a URL", color = cs.onSurfaceVariant, fontSize = 14.sp); inner() },
                            )
                        }
                    }
                    IconButton(onClick = { repo.navigate(url) }) { Icon(Icons.Default.Refresh, "Go", tint = cs.onSurfaceVariant) }
                    IconButton(onClick = { liveStop(); repo.closeSession() }) { Icon(Icons.Default.Close, "Close", tint = cs.onSurfaceVariant) }
                }
            }
            /*
             * THIS USED TO SAY READ-ONLY AND SEND PEOPLE TO THE APPS.
             *
             * Driving a streamed browser is genuinely laggy, which is why it was read-only. But the
             * phone and desktop apps drive their OWN browsers in their own profiles — neither can
             * touch a session on the cluster — so that advice pointed at something which could not
             * do the job, and there was therefore no way at all to sign a CLUSTER profile in by
             * hand. A login is the one act deliberately never automated here, so "no way by hand"
             * meant a signed-out cluster profile stayed signed out: Search Console was unreadable
             * for weeks exactly that way, and the console kept advising an app that could not fix it.
             *
             * Laggy beats impossible. The input relay lives in live-overlay.js; /v1/live has
             * accepted mouse, key and paste since it was written.
             */
            Surface(color = cs.surfaceVariant) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("🖱", fontSize = 13.sp)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "Live view of the cluster browser — click and type to drive it. Expect lag: every " +
                            "click is a round trip. Sign in once here and the agents keep using this login.",
                        color = cs.onSurfaceVariant, fontSize = 11.sp,
                    )
                }
            }
            // The reserved viewport: the JS overlay canvas is positioned exactly here (CSS px).
            LiveViewport(st.sessionId.value)
        } else {
            if (st.sessionError.value.isNotBlank()) {
                Surface(color = cs.surfaceVariant) { Text(st.sessionError.value, Modifier.fillMaxWidth().padding(12.dp), color = cs.onSurfaceVariant, fontSize = 12.sp) }
            }
            // Load on open, then keep the connected/live counts fresh while this tab is shown.
            LaunchedEffect(Unit) { while (true) { repo.loadPlatformState(); kotlinx.coroutines.delay(12000) } }
            PlatformsPanel(
                summary = st.platformsSummary.value,
                onWatch = { repo.watchPlatform(it) },
                onOpen = { repo.openSession(it.key, "https://" + it.site) },
                onSignedOut = { repo.openSession(it.key, "https://" + it.site) },
                signedOutAction = "Open",
                onRefresh = { repo.loadPlatformState() },
                onStopSession = { repo.stopSession(it) },
            )
        }
    }
}

@Composable
private fun LiveViewport(sessionId: String) {
    val cs = MaterialTheme.colorScheme
    val density = LocalDensity.current.density
    var started by remember(sessionId) { mutableStateOf(false) }
    DisposableEffect(sessionId) { onDispose { liveStop() } }
    Box(
        Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color(0xFF0E0F12))
            .onGloballyPositioned { c ->
                val pos = c.positionInWindow(); val s = c.size
                val x = (pos.x / density).toInt(); val y = (pos.y / density).toInt()
                val w = (s.width / density).toInt(); val h = (s.height / density).toInt()
                if (w <= 0 || h <= 0) return@onGloballyPositioned
                if (!started) { liveStart(sessionId, x, y, w, h); started = true } else liveResize(x, y, w, h)
            },
        contentAlignment = Alignment.Center,
    ) {
        // Painted behind the overlay until the first frame lands.
        Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(16.dp), color = Brand, strokeWidth = 2.dp)
            Spacer(Modifier.width(10.dp))
            Text("Connecting to the live view…", color = cs.onSurfaceVariant, fontSize = 13.sp)
        }
    }
}
