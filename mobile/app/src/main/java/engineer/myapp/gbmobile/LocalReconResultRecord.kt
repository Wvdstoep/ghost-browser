package engineer.myapp.gbmobile

import engineer.myapp.gb.shared.ReconReport
import org.json.JSONArray
import org.json.JSONObject

/** Evidence from one on-device target scan. No camera stream, credentials, or page content is stored. */
object LocalReconResultRecord {
    fun completed(target: String, report: ReconReport): JSONObject {
        val open = report.openPorts.filter { it.state.equals("OPEN", true) }
        val ports = JSONArray()
        open.forEach { ports.put(JSONObject().put("port", it.port).put("service", it.service)) }
        val findings = JSONArray()
        report.findings.take(100).forEach { finding ->
            findings.put(JSONObject().put("severity", finding.severity).put("title", finding.title)
                .put("impact", finding.impact))
        }
        val fields = JSONObject().put("time", report.timestamp).put("recordedAt", System.currentTimeMillis())
            .put("status", "completed on this phone").put("grade", report.grade).put("score", report.score)
            .put("findings", report.findingsCount).put("openPorts", open.joinToString(", ") { it.port.toString() })
            .put("videoCandidate", open.any { it.port == 554 || it.port == 8554 })
            .put("scope", "Selected target").put("source", "On-device scan")
        return JSONObject().put("title", "Recon: $target").put("url", target).put("kind", "security")
            .put("fields", fields).put("ports", ports).put("findings", findings)
    }

    fun failed(target: String, error: String): JSONObject = JSONObject()
        .put("title", "Recon failed: $target").put("url", target).put("kind", "security")
        .put("fields", JSONObject().put("recordedAt", System.currentTimeMillis())
            .put("status", "failed").put("error", error.take(300)).put("scope", "Selected target")
            .put("source", "On-device scan"))
}
