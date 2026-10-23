package engineer.myapp.gbmobile

data class DisclosureDraft(val recipient: String, val subject: String, val body: String)

/** A reviewed observation can become an editable email draft; the app never sends mail. */
object DisclosureDrafts {
    private val email = Regex("[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}")

    fun prepare(evidence: RangeEvidence, recipient: String, notes: String): DisclosureDraft? {
        val address = recipient.trim()
        if (evidence.reviewState != "reviewed" || address.length > 254 || !email.matches(address)) return null
        val observations = evidence.web.joinToString("\n") { item ->
            "- ${item.scheme}://${evidence.host}:${item.port}/ returned HTTP ${item.status}" +
                (if (item.title.isNotBlank()) " (title: ${item.title})" else "") +
                (if (item.server.isNotBlank()) " (Server: ${item.server})" else "")
        }.ifBlank { "- TCP connections accepted on ports ${evidence.ports.joinToString(", ")}. The service was not identified." }
        return DisclosureDraft(address, "Security observation for ${evidence.host}",
            "Hello,\n\nI observed the following on ${evidence.host} within ${evidence.cidr}:\n$observations\n\n" +
                "This observation alone does not establish a vulnerability. Please let me know if this is the right channel for a responsible report.\n" +
                notes.trim().takeIf { it.isNotBlank() }?.let { "\nAdditional context:\n$it\n" }.orEmpty() +
                "\nThank you.")
    }
}
