package engineer.myapp.gbmobile

import engineer.myapp.gbmobile.ui.VisitedHistory
import engineer.myapp.gbmobile.ui.VisitedPage
import org.junit.Assert.assertEquals
import org.junit.Test

class VisitedHistoryTest {
    @Test fun recentVisitedLinksMatchTitleOrUrlAndDeduplicate() {
        val first = VisitedPage("https://example.com/a", "Old title")
        val second = VisitedPage("https://another.test/", "Example shop")
        val recent = VisitedHistory.add(VisitedHistory.add(listOf(first), second), first.copy(title = "New title"))
        assertEquals(2, recent.size)
        assertEquals("New title", recent.first().title)
        assertEquals(2, VisitedHistory.match(recent, "example").size)
        assertEquals(listOf(first.copy(title = "New title")), VisitedHistory.match(recent, "new"))
    }

    @Test fun rejectsLocalAndScriptUrlsAndBoundsHistory() {
        val page = VisitedPage("https://example.com", "Example")
        assertEquals(emptyList<VisitedPage>(), VisitedHistory.add(emptyList(), VisitedPage("file:///private", "Private")))
        assertEquals(listOf(page), VisitedHistory.add(listOf(page), VisitedPage("javascript:alert(1)", "Script")))
        assertEquals(listOf(VisitedPage("https://other.test", "Other")), VisitedHistory.add(listOf(page), VisitedPage("https://other.test", "Other"), limit = 1))
    }
}
