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
        assertTrue(html.contains("Video candidate"))
        assertTrue(html.contains(":554</span><span>RTSP service"))
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

    @Test fun rangeHistoryUsesServiceLabelsAndShowsScope() {
        val html = LocalReconResultPage.render("Range discoveries", listOf(
            LocalReconResultPage.Run("http://8.8.8.9", "2026-10-23", "completed on this phone", "", -1, 0,
                false, listOf(LocalReconResultPage.Port(443, "TCP connection accepted")), emptyList(), scope = "8.8.8.8/30")
        ))
        assertTrue(html.contains("Open TCP services"))
        assertTrue(html.contains("Open ports"))
        assertTrue(html.contains("Scanned scopes"))
        assertTrue(html.contains("8.8.8.8/30"))
        assertFalse(html.contains("Video candidates"))
    }

    @Test fun longRangeHistoryStartsWithOnePageAndOffersScopeAndWebFilters() {
        val runs = (1..43).map { index ->
            LocalReconResultPage.Run("https://198.18.0.$index", "2026-10-23", "completed on this phone", "", -1, 0,
                false, listOf(LocalReconResultPage.Port(443, "HTTPS 200")), emptyList(),
                scope = if (index <= 20) "198.18.0.0/27" else "198.18.0.32/27", webIdentified = true)
        }
        val html = LocalReconResultPage.render("Range discoveries", runs)
        assertTrue(html.contains("data-filter=\"web\""))
        assertTrue(html.contains("<option value=\"198.18.0.32/27\">"))
        assertTrue(html.contains("data-detail=\"detail-20\" hidden"))
        assertTrue(html.contains("const size=20"))
        assertTrue(html.contains("id=\"sheetContent\""))
        assertTrue(html.contains("43</strong><span>Host results"))
    }

    @Test fun scopeAndServiceCannotBreakNavigatorMarkup() {
        val html = LocalReconResultPage.render("Range discoveries", listOf(
            LocalReconResultPage.Run("http://192.168.1.2", "Now", "completed", "", -1, 0, false,
                listOf(LocalReconResultPage.Port(80, "HTTP 200 \" onclick=\"bad()")), emptyList(),
                scope = "scope\"><script>bad()</script>", webIdentified = true)
        ))
        assertTrue(html.contains("scope&quot;&gt;&lt;script&gt;bad()&lt;/script&gt;"))
        assertTrue(html.contains("HTTP 200 &quot; onclick=&quot;bad()"))
        assertFalse(html.contains("<script>bad()</script>"))
    }
}
