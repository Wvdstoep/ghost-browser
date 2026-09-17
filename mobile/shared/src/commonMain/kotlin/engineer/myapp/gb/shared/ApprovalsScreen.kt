package engineer.myapp.gb.shared

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The approval gate as its OWN screen — one place, one clear list. Every draft a watcher wants to send
 * (a reply, a comment, a message) sits here showing WHERE it came from (the thread), WHAT it is for
 * (why), and the DRAFT itself — editable — with Approve & post / Deny. Nothing the outside world sees
 * goes out without a yes. Below the queue, each running watcher shows its live activity, so a run is
 * never a silent "Running…". Phone and desktop share this exact screen.
 */
@Composable
fun ApprovalsScreen(
    jobs: List<JobInfo>,
    loading: Boolean,
    onApprove: (jobId: String, pid: String, editedText: String) -> Unit,
    onDeny: (jobId: String, pid: String) -> Unit,
    onStop: (jobId: String) -> Unit,
    onSay: (jobId: String, text: String) -> Unit,
    onOpenUrl: (String) -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    topInset: Modifier = Modifier,
    leads: List<PersonInfo> = emptyList(),   // people memory: the ones worth your words (empty = section hidden)
) {
    val cs = MaterialTheme.colorScheme
    val pending = jobs.flatMap { it.proposals }
    val watchers = jobs.filter { it.status == "running" || it.status == "idle" }

    Column(modifier.fillMaxSize().background(cs.background).then(topInset).verticalScroll(rememberScrollState())
        .padding(start = 16.dp, end = 16.dp, bottom = 24.dp, top = 14.dp)) {

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Approvals", style = MaterialTheme.typography.headlineSmall, color = cs.onSurface)
                Text("Every action a watcher or flow wants to take waits here for your yes", style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
            if (pending.isNotEmpty())
                Box(Modifier.clip(RoundedCornerShape(50)).background(Brand).padding(horizontal = 11.dp, vertical = 5.dp)) {
                    Text("${pending.size} waiting", color = BrandOn, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                }
            Spacer(Modifier.width(8.dp))
            TextButton(onClick = onRefresh) { Text(if (loading) "…" else "Refresh", color = Brand) }
        }
        Spacer(Modifier.height(16.dp))

        // ── The queue ────────────────────────────────────────────────────────────────────────────
        if (pending.isEmpty()) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(cs.surface)
                .border(1.dp, cs.outline, RoundedCornerShape(14.dp)).padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Nothing waiting", style = MaterialTheme.typography.titleMedium, color = cs.onSurface)
                Spacer(Modifier.height(4.dp))
                Text(if (watchers.isEmpty()) "When a watcher or flow wants to act, its draft lands here for you to approve. Create a watcher in the Watchers tab."
                     else "Your watchers are running. The moment one wants to act, its draft appears here.",
                    style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
            }
        } else {
            pending.forEach { p -> ApprovalCard(p, onApprove, onDeny, onOpenUrl); Spacer(Modifier.height(10.dp)) }
        }

        // ── People worth your words (people memory, roadmap Phase 3) ─────────────────────────────
        if (leads.isNotEmpty()) {
            Spacer(Modifier.height(18.dp))
            Text("PEOPLE WORTH YOUR WORDS", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = cs.onSurfaceVariant, letterSpacing = 1.sp)
            Text("Who showed buying interest or keeps coming back — from every post the watchers read.", fontSize = 11.sp, color = cs.onSurfaceVariant)
            Spacer(Modifier.height(8.dp))
            leads.sortedByDescending { it.worth }.take(8).forEach { p ->
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp).clip(RoundedCornerShape(12.dp)).background(cs.surface).border(1.dp, if (p.lead) Brand.copy(alpha = 0.5f) else cs.outline, RoundedCornerShape(12.dp)).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(p.name, style = MaterialTheme.typography.titleSmall, color = cs.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            if (p.lead) { Spacer(Modifier.width(6.dp)); Box(Modifier.clip(RoundedCornerShape(50)).background(Brand.copy(alpha = 0.14f)).padding(horizontal = 7.dp, vertical = 1.dp)) { Text("LEAD", color = Brand, fontSize = 9.sp, fontFamily = FontFamily.Monospace) } }
                        }
                        val bits = buildList { add("${p.exchanges} exchange${if (p.exchanges == 1) "" else "s"}"); if (p.posts > 1) add("${p.posts} posts"); if (p.repliedBack > 0) add("came back ×${p.repliedBack}") }
                        Text(bits.joinToString(" · "), fontSize = 11.sp, color = cs.onSurfaceVariant)
                        p.signals.lastOrNull()?.let { Text("“${it.take(110)}”", fontSize = 12.sp, color = cs.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp)) }
                        p.promises.lastOrNull()?.let { Text("you promised: ${it.take(90)}", fontSize = 11.sp, color = Brand, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp)) }
                    }
                    Spacer(Modifier.width(10.dp))
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("${p.worth}", style = MaterialTheme.typography.titleLarge, color = if (p.worth >= 60) Brand else cs.onSurface)
                        Text("worth", fontSize = 9.sp, color = cs.onSurfaceVariant, fontFamily = FontFamily.Monospace)
                        // the hand-off, GB-only: the agent drafts the next move from the whole history (a DM or a reply you approve)
                        val ask = AssistantHooks.ask
                        if (p.lead && ask != null) TextButton(onClick = { ask("Draft the next message to ${p.name} on ${p.platform.ifBlank { "facebook" }} — they showed buying interest. Use everything we know about them (gb_people) and our history; make it a helpful, specific offer to talk, in my voice, as a reply in our thread or a DM, whichever fits. Do not send — draft it for my approval.") }, contentPadding = PaddingValues(horizontal = 6.dp)) { Text("Draft offer", fontSize = 11.sp) }
                    }
                }
            }
        }

        Spacer(Modifier.height(20.dp))

        // ── What's producing these, live (read-only context; manage in the Watchers tab) ───────────
        Text("ACTIVE NOW", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = cs.onSurfaceVariant, letterSpacing = 1.5.sp)
        Spacer(Modifier.height(8.dp))
        if (watchers.isEmpty()) {
            Text("Nothing running right now.", style = MaterialTheme.typography.bodyMedium, color = cs.onSurfaceVariant)
        } else {
            watchers.forEach { j -> WatcherCard(j, onStop, onSay); Spacer(Modifier.height(8.dp)) }
        }
    }
}

@Composable
private fun ApprovalCard(
    p: Proposal,
    onApprove: (String, String, String) -> Unit,
    onDeny: (String, String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    var draft by remember(p.pid) { mutableStateOf(p.text) }
    var acted by remember(p.pid) { mutableStateOf(false) }

    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(cs.surface)
        .border(1.dp, cs.outline, RoundedCornerShape(14.dp)).padding(14.dp)) {

        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.clip(RoundedCornerShape(6.dp)).background(BrandSoft).padding(horizontal = 8.dp, vertical = 3.dp)) {
                Text(p.kind.uppercase().ifBlank { "REPLY" }, color = Brand, fontSize = 10.sp, fontFamily = FontFamily.Monospace, letterSpacing = 1.sp)
            }
            Spacer(Modifier.width(8.dp))
            Text(p.jobRole.ifBlank { "watcher" }, fontSize = 11.sp, color = cs.onSurfaceVariant, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(8.dp))

        // WHAT this is for
        if (p.why.isNotBlank()) { Text(p.why, style = MaterialTheme.typography.bodyMedium, color = cs.onSurface); Spacer(Modifier.height(4.dp)) }
        // WHERE it came from
        if (p.url.isNotBlank()) {
            Text("View thread ↗", color = Brand, fontSize = 13.sp, modifier = Modifier.clickable { onOpenUrl(p.url) })
            Spacer(Modifier.height(10.dp))
        }

        // The DRAFT — editable before it posts
        OutlinedTextField(
            value = draft, onValueChange = { draft = it }, enabled = !acted,
            modifier = Modifier.fillMaxWidth().heightIn(min = 80.dp),
            label = { Text("Draft") }, minLines = 3, shape = RoundedCornerShape(10.dp),
        )
        Spacer(Modifier.height(12.dp))
        Row {
            Button(onClick = { acted = true; onApprove(p.jobId, p.pid, draft) }, enabled = !acted,
                modifier = Modifier.weight(1f).height(46.dp), shape = RoundedCornerShape(10.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Brand, contentColor = BrandOn)) {
                Text("Approve & post", style = MaterialTheme.typography.labelLarge)
            }
            Spacer(Modifier.width(10.dp))
            OutlinedButton(onClick = { acted = true; onDeny(p.jobId, p.pid) }, enabled = !acted,
                modifier = Modifier.height(46.dp), shape = RoundedCornerShape(10.dp)) {
                Text("Deny", color = cs.error, style = MaterialTheme.typography.labelLarge)
            }
        }
        if (acted) { Spacer(Modifier.height(6.dp)); Text("Sent to the watcher…", fontSize = 11.sp, color = cs.onSurfaceVariant, fontFamily = FontFamily.Monospace) }
    }
}

@Composable
private fun WatcherCard(j: JobInfo, onStop: (String) -> Unit, onSay: (String, String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    var say by remember(j.id) { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(cs.surface)
        .border(1.dp, cs.outline, RoundedCornerShape(12.dp)).padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(j.role.ifBlank { "job" }, style = MaterialTheme.typography.titleMedium, color = cs.onSurface, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(j.status, fontSize = 11.sp, color = if (j.status == "running") Brand else cs.onSurfaceVariant, fontFamily = FontFamily.Monospace)
            Spacer(Modifier.width(8.dp))
            OutlinedButton(onClick = { onStop(j.id) }, modifier = Modifier.height(30.dp), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 0.dp), shape = RoundedCornerShape(8.dp)) {
                Text("Stop", fontSize = 12.sp, color = cs.onSurfaceVariant)
            }
        }
        if (j.steps.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(cs.background).padding(8.dp)) {
                j.steps.takeLast(6).forEach { s ->
                    Text(s, fontSize = 11.sp, color = cs.onSurfaceVariant, fontFamily = FontFamily.Monospace, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(value = say, onValueChange = { say = it }, modifier = Modifier.weight(1f),
                placeholder = { Text("Tell it something…", fontSize = 13.sp) }, singleLine = true, shape = RoundedCornerShape(9.dp))
            Spacer(Modifier.width(8.dp))
            TextButton(onClick = { if (say.isNotBlank()) { onSay(j.id, say); say = "" } }) { Text("Send", color = Brand) }
        }
    }
}
