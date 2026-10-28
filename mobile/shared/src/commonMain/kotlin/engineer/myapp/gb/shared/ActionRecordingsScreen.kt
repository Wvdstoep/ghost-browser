package engineer.myapp.gb.shared

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Executable recordings, deliberately separate from screen videos. */
@Composable
fun ActionRecordingsScreen(recordings: List<ActionRecordingInfo>, jobs: List<JobInfo>, error: String,
                           onRefresh: () -> Unit, modifier: Modifier = Modifier) {
    Surface(modifier, color = MaterialTheme.colorScheme.background) {
    LazyColumn(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("Action recordings", style = MaterialTheme.typography.headlineSmall)
            Text("Saved execution paths and evidence from recent runs. Compatible verified recordings are reused automatically; approval and fresh inputs are still required.")
            TextButton(onClick = onRefresh) { Text("Refresh") }
            if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
        }
        item { Text("Saved library · " + recordings.size, style = MaterialTheme.typography.titleMedium) }
        if (recordings.isEmpty()) item { Text("No action recordings saved yet. A successful supported browser action can capture a request; it must be verified before replay. Maps saves a reusable built-in routine after a verified search.") }
        items(recordings, key = { it.id }) { r ->
            OutlinedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(r.intent, style = MaterialTheme.typography.titleMedium)
                    Text(r.origin)
                    Text(r.kind + " · " + r.status, color = MaterialTheme.colorScheme.primary)
                    Text(r.reason)
                    Text("Verified reuses: " + r.uses + " · Last verified: " + r.lastVerified)
                }
            }
        }
        item { Text("Recent run evidence · refreshes every 3 seconds", style = MaterialTheme.typography.titleMedium) }
        items(jobs.take(20), key = { it.id }) { j ->
            OutlinedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(j.role + " · " + j.status)
                    Text(j.id, style = MaterialTheme.typography.labelSmall)
                    Text(j.execution.ifBlank { "No execution evidence · Older run or unsupported executor" }, color = MaterialTheme.colorScheme.primary)
                }
            }
        }
    }
    }
}
