package engineer.myapp.gbmobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalReconResultPageTest {
    @Test fun rendersObservedEvidenceAndEscapesTargetContent() {
        val html = LocalReconResultPage.render("My watcher", listOf(
            LocalReconResultPage.Run(
                target = "https://example.org/<script>alert(1)</script>\" onmouseover=\"bad()", time = "2026-10-23 10:00",
                status = "completed on this phone", grade = "B", score = 81, findingCount = 1,
                videoCandidate = true, ports = listOf(LocalReconResultPage.Port(554, "RTSP service")),
                findings = listOf(LocalReconResultPage.Finding("MEDIUM", "Missing header", "Needs review")),
            )
        ))
        assertTrue(html.contains("Video-service candidates"))
        assertTrue(html.contains("554 <small>RTSP service"))
        assertTrue(html.contains("Missing header"))
        assertTrue(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"))
        assertTrue(html.contains("&quot; onmouseover=&quot;bad()"))
        assertFalse(html.contains("https://example.org/<script>"))
    }

    @Test fun emptyHistoryShowsNoInventedFindings() {
        val html = LocalReconResultPage.render("Empty", emptyList())
        assertTrue(html.contains("No local scan results yet"))
        assertTrue(html.contains("<strong>0</strong><span>Runs"))
    }
}
