package engineer.myapp.gb.shared

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The Flows tab — same as phone/desktop: an Automations | Watchers sub-toggle. Automations are saved
 * browser workflows you run; Watchers are those workflows on a schedule (background roles). Opening a
 * watcher's results shows the deduped feed with any drafts, approvable in place (the shared ResultsScreen).
 */
@Composable
fun FlowsTab(st: WebState, repo: WebRepo, openExternal: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var sub by remember { mutableStateOf(0) }   // 0 = Automations, 1 = Watchers

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().background(cs.background)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)
                .clip(RoundedCornerShape(10.dp)).border(1.dp, cs.outline, RoundedCornerShape(10.dp))) {
                listOf("Automations", "Watchers").forEachIndexed { i, lbl ->
                    val on = sub == i
                    Box(Modifier.weight(1f).clip(RoundedCornerShape(9.dp)).background(if (on) Brand else Color.Transparent)
                        .clickable { sub = i; if (i == 1) { repo.loadWatchers(); if (st.flows.value.isEmpty()) repo.loadFlows() } else repo.loadFlows() }
                        .padding(vertical = 9.dp), contentAlignment = Alignment.Center) {
                        Text(lbl, color = if (on) BrandOn else cs.onSurface, fontSize = 13.sp)
                    }
                }
            }
            if (sub == 0) FlowsScreen(
                flows = st.flows.value, onLoad = { repo.loadFlows() },
                onRun = { id, _ -> repo.runFlow(id, "") }, onCreate = { n, s -> repo.createFlow(n, s) },
                onCreateSecurity = { n, t, s, p -> repo.createSecurityFlow(n, t, s, p) },
                modifier = Modifier.weight(1f).fillMaxWidth(),
            ) else WatchersScreen(
                watchers = st.watchers.value, roles = st.watcherRoles.value, profiles = st.watcherProfiles.value,
                automations = st.flows.value, loading = st.watchersLoading.value,
                onSave = { id, n, m, r, g, p, aid, iv, fuF, fuR -> repo.saveWatcher(id, n, m, r, g, p, aid, iv, fuF, fuR) },
                onToggle = { id, a -> repo.toggleWatcher(id, a) },
                onOpenResults = { repo.openWatcherResults(it) },
                onRefresh = { repo.loadWatchers() },
                modifier = Modifier.weight(1f).fillMaxWidth(),
            )
        }
        if (st.artifactVisible.value) ResultsScreen(
            watcherName = st.artifactName.value, items = st.artifactItems.value, flows = st.flows.value, loading = st.artifactLoading.value,
            onRunFlow = { fid, item -> repo.runFlowOnItem(fid, item) },
            onApproveDraft = { item, edited -> repo.approveDraft(item, edited) },
            onDenyDraft = { item -> repo.denyDraft(item) },
            onOpenUrl = { openExternal(it) },
            onClose = { st.artifactVisible.value = false },
            modifier = Modifier.fillMaxSize().background(cs.background),
            onWatchPost = { url -> repo.watchPost(url) },
            onMutePost = { pid -> repo.mutePost(pid) },
        )
    }
}
