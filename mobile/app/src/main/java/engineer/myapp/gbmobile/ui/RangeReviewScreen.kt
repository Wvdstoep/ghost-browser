package engineer.myapp.gbmobile.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import engineer.myapp.gbmobile.DisclosureDrafts
import engineer.myapp.gbmobile.LocalRangeScanner
import engineer.myapp.gbmobile.RangeEvidence
import java.text.DateFormat
import java.util.Date

@Composable
fun RangeReviewScreen(scanner: LocalRangeScanner, onHistory: () -> Unit, onResearch: (RangeEvidence) -> Unit,
                      onOpenApp: (RangeEvidence) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val context = LocalContext.current
    var query by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf("All") }
    var selectedId by remember { mutableLongStateOf(scanner.focusEvidenceId.value) }
    val listState = rememberLazyListState()
    val filtered = scanner.evidence.filter { item ->
        (filter == "All" || filter == "Web" && item.web.isNotEmpty() ||
            filter == "Review" && item.reviewState == "new" || filter == "Reviewed" && item.reviewState == "reviewed") &&
            (query.isBlank() || item.host.contains(query, true) || item.web.any {
                it.title.contains(query, true) || it.redirectUrl.contains(query, true) || it.url(item.host).contains(query, true)
            })
    }
    LaunchedEffect(selectedId, filtered.size) {
        val index = filtered.indexOfFirst { it.id == selectedId }
        if (index >= 0) listState.animateScrollToItem(index + 2)
    }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 18.dp), state = listState,
        contentPadding = PaddingValues(top = 18.dp, bottom = 24.dp)) {
        item {
            Text("Evidence inbox", style = MaterialTheme.typography.headlineSmall)
            Text("Review what the phone observed before contacting anyone.", color = cs.onSurfaceVariant)
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                EvidenceStat("${scanner.evidence.size}", "Hosts", Modifier.weight(1f))
                EvidenceStat("${scanner.evidence.count { it.web.isNotEmpty() }}", "Web apps", Modifier.weight(1f))
                EvidenceStat("${scanner.evidence.count { it.reviewState == "reviewed" }}", "Reviewed", Modifier.weight(1f))
            }
            Spacer(Modifier.height(18.dp))
        }
        item {
            OutlinedTextField(query, { query = it }, leadingIcon = { Icon(Icons.Default.Search, null) },
                label = { Text("Find a host or page title") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                listOf("All", "Web", "Review", "Reviewed").forEach { value ->
                    FilterChip(selected = filter == value, onClick = { filter = value }, label = { Text(value) })
                }
            }
            Spacer(Modifier.height(12.dp))
        }
        if (filtered.isEmpty()) item {
            Surface(shape = RoundedCornerShape(18.dp), color = cs.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(20.dp)) {
                    Icon(Icons.Default.Language, null, tint = cs.primary)
                    Spacer(Modifier.height(8.dp))
                    Text("No matching evidence", style = MaterialTheme.typography.titleMedium)
                    Text(if (scanner.evidence.isEmpty()) "Start a range discovery run to collect port and web observations."
                        else "Try another filter or search term.", color = cs.onSurfaceVariant)
                }
            }
        }
        items(filtered, key = { it.id }) { item ->
            EvidenceCard(item, selectedId == item.id, onOpen = { selectedId = if (selectedId == item.id) -1 else item.id },
                onResearch = { onResearch(item) }, onOpenApp = { onOpenApp(item) },
                onReview = { scanner.review(item.id, it) }, onDraft = { recipient, notes ->
                    val current = scanner.evidence.firstOrNull { it.id == item.id } ?: return@EvidenceCard
                    val draft = DisclosureDrafts.prepare(current, recipient, notes) ?: return@EvidenceCard
                    val intent = Intent(Intent.ACTION_SENDTO, Uri.fromParts("mailto", draft.recipient, null))
                        .putExtra(Intent.EXTRA_SUBJECT, draft.subject).putExtra(Intent.EXTRA_TEXT, draft.body)
                    try { context.startActivity(intent) }
                    catch (_: ActivityNotFoundException) {
                        Toast.makeText(context, "No email app is available on this device", Toast.LENGTH_LONG).show()
                    }
                })
            Spacer(Modifier.height(10.dp))
        }
        item {
            Spacer(Modifier.height(12.dp))
            OutlinedButton(onClick = onHistory, modifier = Modifier.fillMaxWidth()) { Text("Open full scan history") }
        }
    }
}

@Composable private fun EvidenceStat(value: String, label: String, modifier: Modifier) {
    val cs = MaterialTheme.colorScheme
    Surface(modifier = modifier, shape = RoundedCornerShape(15.dp), color = cs.primaryContainer) {
        Column(Modifier.padding(12.dp)) {
            Text(value, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = cs.onPrimaryContainer)
            Text(label, style = MaterialTheme.typography.labelMedium, color = cs.onPrimaryContainer)
        }
    }
}

@Composable private fun EvidenceCard(item: RangeEvidence, expanded: Boolean, onOpen: () -> Unit,
                                      onReview: (String) -> Unit, onDraft: (String, String) -> Unit,
                                      onResearch: () -> Unit, onOpenApp: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    var recipient by remember(item.id) { mutableStateOf(item.publishedContact) }
    var notes by remember(item.id) { mutableStateOf("") }
    val ready = item.reviewState == "reviewed" && DisclosureDrafts.prepare(item, recipient, notes) != null
    Surface(shape = RoundedCornerShape(18.dp), color = cs.surface,
        border = BorderStroke(1.dp, if (expanded) cs.primary else cs.outlineVariant), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(Modifier.fillMaxWidth().clickable(onClick = onOpen), verticalAlignment = Alignment.CenterVertically) {
                Icon(if (item.web.isEmpty()) Icons.Default.Search else Icons.Default.Language, null, tint = cs.primary)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(item.host, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text("${item.ports.size} open ports · ${item.web.size} web responses",
                        style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                }
                Text(when (item.reviewState) { "reviewed" -> "Reviewed"; "dismissed" -> "Dismissed"; else -> "New" },
                    color = if (item.reviewState == "reviewed") cs.primary else cs.onSurfaceVariant,
                    style = MaterialTheme.typography.labelMedium)
            }
            if (expanded) {
                Spacer(Modifier.height(14.dp)); HorizontalDivider()
                Spacer(Modifier.height(12.dp))
                Text("Observed ${DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(item.recordedAt))} · ${item.cidr}",
                    style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                Spacer(Modifier.height(10.dp))
                Text("TCP ports: ${item.ports.joinToString(", ")}", style = MaterialTheme.typography.bodyMedium)
                item.web.forEach { web ->
                    Spacer(Modifier.height(9.dp))
                    Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp)) {
                            Text("${web.scheme.uppercase()} :${web.port} · ${web.status}", fontWeight = FontWeight.Bold)
                            Text(web.url(item.host), style = MaterialTheme.typography.bodySmall, color = cs.primary)
                            if (web.redirectUrl.isNotBlank()) Text("Redirect offered: ${web.redirectUrl} · verify ownership before using",
                                style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                            if (web.title.isNotBlank()) Text(web.title, style = MaterialTheme.typography.bodyMedium)
                            if (web.server.isNotBlank()) Text("Server: ${web.server}", style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                            if (web.poweredBy.isNotBlank()) Text("X-Powered-By: ${web.poweredBy}", style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
                Text("These are observations, not confirmed vulnerabilities. Verify ownership and impact before reporting.",
                    style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                if (item.web.isNotEmpty()) {
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = if (item.researchAppId.isBlank()) onResearch else onOpenApp,
                        modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.Default.Search, null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(7.dp))
                        Text(if (item.researchAppId.isBlank()) "Research in Security Apps" else "Open Security App")
                    }
                    Text(if (item.researchAppId.isBlank()) "Save this host as an app target, run an on-device baseline recon, and open the Security agent. A redirect is used only when its hostname resolves to this IP; choose prompts there for deeper research."
                        else "Linked to a saved Security App. Open it to run another recon prompt.",
                        style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (item.reviewState != "reviewed") Button(onClick = { onReview("reviewed") }) {
                        Icon(Icons.Default.VerifiedUser, null, modifier = Modifier.size(17.dp)); Spacer(Modifier.width(5.dp)); Text("Mark reviewed")
                    }
                    if (item.reviewState != "dismissed") OutlinedButton(onClick = { onReview("dismissed") }) { Text("Dismiss") }
                    if (item.reviewState == "dismissed") OutlinedButton(onClick = { onReview("new") }) { Text("Reopen") }
                }
                if (item.reviewState == "reviewed") {
                    Spacer(Modifier.height(15.dp)); HorizontalDivider(); Spacer(Modifier.height(12.dp))
                    Text("Prepare responsible notice", style = MaterialTheme.typography.titleMedium)
                    Text(if (item.publishedContact.isBlank()) "Enter a verified contact for this host."
                        else "Suggested by this host's validated HTTPS security.txt. Confirm it belongs to the owner.",
                        style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                    Spacer(Modifier.height(9.dp))
                    OutlinedTextField(recipient, { recipient = it }, label = { Text("Recipient email") },
                        singleLine = true, modifier = Modifier.fillMaxWidth())
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(notes, { notes = it }, label = { Text("Verified context to add") },
                        minLines = 2, maxLines = 4, modifier = Modifier.fillMaxWidth())
                    Spacer(Modifier.height(8.dp))
                    Button(onClick = { onDraft(recipient, notes) }, enabled = ready, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.Default.Email, null, modifier = Modifier.size(18.dp)); Spacer(Modifier.width(7.dp)); Text("Open editable email draft")
                    }
                    Text("Your email app opens the draft. Ghost Browser does not send it.",
                        style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant)
                }
            }
        }
    }
}
