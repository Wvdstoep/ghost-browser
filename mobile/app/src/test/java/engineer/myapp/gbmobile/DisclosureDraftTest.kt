package engineer.myapp.gbmobile

import org.junit.Assert.*
import org.junit.Test

class DisclosureDraftTest {
    private val evidence = RangeEvidence(1, 2, "192.168.1.0/24", "192.168.1.4", listOf(80), 1,
        listOf(WebServiceProbe.Finding(80, "http", 200, "Example", "nginx", "")), "new")

    @Test fun requiresHumanReviewAndValidRecipient() {
        assertNull(DisclosureDrafts.prepare(evidence, "security@example.org", ""))
        assertNull(DisclosureDrafts.prepare(evidence.copy(reviewState = "reviewed"), "not-an-email", ""))
        val draft = DisclosureDrafts.prepare(evidence.copy(reviewState = "reviewed"), "security@example.org", "Verified site owner")!!
        assertEquals("security@example.org", draft.recipient)
        assertTrue(draft.body.contains("returned HTTP 200"))
        assertTrue(draft.body.contains("does not establish a vulnerability"))
        assertTrue(draft.body.contains("Verified site owner"))
    }
}
