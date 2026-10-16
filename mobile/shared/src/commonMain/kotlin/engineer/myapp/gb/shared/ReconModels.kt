package engineer.myapp.gb.shared

import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf

data class ReconFinding(
    val id: String = "",
    val title: String = "",
    val severity: String = "INFO", // CRITICAL, HIGH, MEDIUM, LOW, INFO
    val cwe: String = "",
    val owasp: String = "",
    val impact: String = "",
    val rootCause: String = "",
    val threatScenario: String = "",
    val traefik: String = "",
    val nginx: String = "",
    val express: String = "",
    val dns: String = "",
    val secondaryDefense: String = "",
)

data class ReconWafInfo(
    val detected: Boolean = false,
    val name: String = "None",
)

data class ReconReport(
    val target: String = "",
    val url: String = "",
    val timestamp: String = "",
    val score: Int = 100,
    val grade: String = "A",
    val findingsCount: Int = 0,
    val findings: List<ReconFinding> = emptyList(),
    val waf: ReconWafInfo = ReconWafInfo(),
    val rawJson: String = "",
)

class ReconUi {
    val isOpen: MutableState<Boolean> = mutableStateOf(false)
    val isScanning: MutableState<Boolean> = mutableStateOf(false)
    val report: MutableState<ReconReport?> = mutableStateOf(null)
    val error: MutableState<String?> = mutableStateOf(null)
    val currentTarget: MutableState<String> = mutableStateOf("")
    val selectedTab: MutableState<String> = mutableStateOf("advisories") // advisories | session | perimeter
    val filterSeverity: MutableState<String> = mutableStateOf("ALL")
    val expandedFindingId: MutableState<String?> = mutableStateOf(null)
    val selectedRemediationStack: MutableState<String> = mutableStateOf("traefik") // traefik | nginx | express | dns
}

class ReconActions(
    val onScan: (target: String, comprehensive: Boolean) -> Unit,
    val onSessionProbe: (loginUrl: String, passwordChangeUrl: String, protectedUrl: String) -> Unit = { _, _, _ -> },
    val onClose: () -> Unit = {},
    val onCopySnippet: (String) -> Unit = {},
)
