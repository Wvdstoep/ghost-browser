package engineer.myapp.gbmobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import engineer.myapp.gbmobile.LocalRangeScanner
import engineer.myapp.gbmobile.PrivateRangePlan
import engineer.myapp.gbmobile.ScanPorts

@Composable
fun RangeScanDialog(scanner: LocalRangeScanner, onResults: () -> Unit) {
    if (!scanner.open.value) return
    var input by remember(scanner.open.value) { mutableStateOf(scanner.selected.value) }
    val valid = PrivateRangePlan.parse(input)
    val chosenPorts = if (scanner.portPreset.value == "Custom") ScanPorts.parseCustom(scanner.customPorts.value)
        else ScanPorts.presets[scanner.portPreset.value]
    Dialog(onDismissRequest = { scanner.open.value = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), tonalElevation = 8.dp) {
            Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp)) {
                Text("Local range discovery", style = MaterialTheme.typography.headlineSmall)
                Spacer(Modifier.height(6.dp))
                Text("Discover open TCP services on one private subnet from this phone. A connection identifies an open port, not the application behind it.", style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(18.dp))
                Text("Choose a subnet", style = MaterialTheme.typography.titleMedium)
                scanner.presets().forEach { (label, cidr) ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        TextButton(onClick = { input = cidr }, enabled = !scanner.isRunning()) { Text(label) }
                        Text(cidr, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 15.dp))
                    }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(input, { input = it }, label = { Text("Private CIDR, /24 to /32") },
                    supportingText = { Text(if (valid == null) "Enter a 10/8, 172.16/12, or 192.168/16 subnet (maximum 254 hosts)." else "${valid.hosts.size} hosts") },
                    isError = valid == null, singleLine = true, enabled = !scanner.isRunning(), modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(12.dp))
                Text("Services to check", style = MaterialTheme.typography.titleMedium)
                (ScanPorts.presets.keys + "Custom").chunked(2).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { name -> FilterChip(selected = scanner.portPreset.value == name,
                            onClick = { scanner.portPreset.value = name }, enabled = !scanner.isRunning(), label = { Text(name) }) }
                    }
                }
                if (scanner.portPreset.value == "Custom") {
                    OutlinedTextField(scanner.customPorts.value, { scanner.customPorts.value = it },
                        label = { Text("TCP ports, comma-separated") },
                        supportingText = { Text("Up to 24 ports, for example 22,80,443") },
                        isError = chosenPorts == null, singleLine = true, enabled = !scanner.isRunning(), modifier = Modifier.fillMaxWidth())
                } else Text("${chosenPorts?.size ?: 0} TCP ports: ${chosenPorts?.joinToString(", ") ?: ""}", style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.height(12.dp))
                Text("Maximum pace: ${scanner.rate.value} hosts/s", style = MaterialTheme.typography.bodyMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(2, 10, 25).forEach { value ->
                        FilterChip(selected = scanner.rate.value == value, onClick = { scanner.rate.value = value },
                            enabled = !scanner.isRunning(), label = { Text("$value/s") })
                    }
                }
                Spacer(Modifier.height(14.dp))
                Text(scanner.status.value, style = MaterialTheme.typography.titleMedium)
                Text("${scanner.progress.value} / ${scanner.total.value} checked  ·  ${scanner.matches.value} candidates")
                if (scanner.total.value > 0) {
                    Spacer(Modifier.height(8.dp))
                    LinearProgressIndicator(progress = { scanner.progress.value.toFloat() / scanner.total.value }, modifier = Modifier.fillMaxWidth())
                }
                Spacer(Modifier.height(18.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (!scanner.isRunning()) Button(onClick = { scanner.selected.value = input; scanner.start() }, enabled = valid != null && chosenPorts != null) { Text("Start scan") }
                    else {
                        OutlinedButton(onClick = scanner::pauseOrResume) { Text(if (scanner.isPaused()) "Resume" else "Pause") }
                        OutlinedButton(onClick = scanner::stop) { Text("Stop") }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { scanner.open.value = false; onResults() }) { Text("View results") }
                    TextButton(onClick = { scanner.open.value = false }) { Text("Close") }
                }
            }
        }
    }
}
