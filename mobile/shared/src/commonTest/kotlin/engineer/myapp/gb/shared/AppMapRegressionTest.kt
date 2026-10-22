package engineer.myapp.gb.shared

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AppMapRegressionTest {
    @Test
    fun emptyHistoryDoesNotInventEvidenceForPreviouslyHardcodedDomains() {
        for (domain in listOf("nexorascientific.com", "my-app.engineer", "example.org")) {
            val map = parseAppMapFromChat("https://$domain", emptyList())
            assertEquals(domain, map.domain)
            assertTrue(map.ports.isEmpty(), domain)
            assertTrue(map.findings.isEmpty(), domain)
            assertTrue(map.probedEndpoints.isEmpty(), domain)
            assertTrue(map.vectors.all { it.status == AuditVectorStatus.PENDING }, domain)
            assertEquals(-1, map.postureScore)
            assertEquals(-1, map.exploitabilityScore)
        }
    }

    @Test
    fun mentioningAnAuditDoesNotInventResults() {
        val turn = AssistantTurn(role = "assistant", text = "Run TLS and SSTI audit for example.org", t = 0)
        val map = parseAppMapFromChat("https://example.org", listOf(turn))
        assertTrue(map.findings.isEmpty())
        assertTrue(map.vectors.all { it.status == AuditVectorStatus.PENDING })
    }

    @Test
    fun noExampleTargetsAreSeededAsAuditedApps() {
        assertTrue(DEFAULT_MANAGED_APPS.isEmpty())
    }

    @Test
    fun endpointWithoutObservedStatusDoesNotBecomeA200() {
        val step = AssistantStep("gb_pipeline_deep_spider", "", "example.org", "GET /api/admin")
        val turn = AssistantTurn(role = "assistant", text = "example.org", t = 0, steps = listOf(step))
        val map = parseAppMapFromChat("https://example.org", listOf(turn))
        assertTrue(map.probedEndpoints.isEmpty())
    }
}
