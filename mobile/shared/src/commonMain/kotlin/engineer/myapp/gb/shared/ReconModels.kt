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

data class CveVulnerability(
    val cveId: String = "",
    val component: String = "",
    val version: String = "",
    val severity: String = "HIGH", // CRITICAL, HIGH, MEDIUM
    val cvss: Double = 7.5,
    val title: String = "",
    val description: String = "",
    val source: String = "Cluster Image Trivy Scanner",
    val fixAvailable: String = "",
    val advisoryUrl: String = "",
)

data class JsLeakItem(
    val type: String = "", // API_KEY, TOKEN, SECRET, CREDENTIAL
    val location: String = "", // inline script, bundle.js, localStorage
    val snippet: String = "",
    val risk: String = "HIGH",
    val description: String = "",
)

data class DnsRecordItem(
    val type: String = "", // A, AAAA, MX, TXT, DMARC, DKIM, CAA, CNAME
    val host: String = "",
    val value: String = "",
    val status: String = "OK", // OK, WARNING, CRITICAL
    val note: String = "",
)

data class CrawlEndpoint(
    val url: String = "",
    val method: String = "GET",
    val status: Int = 200,
    val isAuthRequired: Boolean = false,
    val contentType: String = "text/html",
)

data class PortProbeResult(
    val port: Int = 80,
    val service: String = "HTTP",
    val state: String = "OPEN",
    val sensitive: Boolean = false,
)

data class SessionInvalidationProbeResult(
    val tested: Boolean = true,
    val vulnerable: Boolean = true,
    val details: String = "",
    val attackPath: String = "",
    val remediationPattern: String = "",
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
    val cves: List<CveVulnerability> = emptyList(),
    val jsLeaks: List<JsLeakItem> = emptyList(),
    val dnsRecords: List<DnsRecordItem> = emptyList(),
    val openPorts: List<PortProbeResult> = emptyList(),
    val crawlEndpoints: List<CrawlEndpoint> = emptyList(),
    val sessionProbe: SessionInvalidationProbeResult = SessionInvalidationProbeResult(),
    val rawJson: String = "",
)

class ReconUi {
    val isOpen: MutableState<Boolean> = mutableStateOf(false)
    val isScanning: MutableState<Boolean> = mutableStateOf(false)
    val report: MutableState<ReconReport?> = mutableStateOf(null)
    val error: MutableState<String?> = mutableStateOf(null)
    val currentTarget: MutableState<String> = mutableStateOf("")
    val selectedTab: MutableState<String> = mutableStateOf("scorecard")
    // scorecard | headers | jsleaks | dns | cves | probes | crawl
    val filterSeverity: MutableState<String> = mutableStateOf("ALL")
    val expandedFindingId: MutableState<String?> = mutableStateOf(null)
    val selectedRemediationStack: MutableState<String> = mutableStateOf("traefik") // traefik | nginx | express | dns
}

class ReconActions(
    val onScan: (target: String, comprehensive: Boolean) -> Unit,
    val onRunSessionProbe: (target: String) -> Unit = {},
    val onClose: () -> Unit = {},
    val onCopySnippet: (String) -> Unit = {},
)
