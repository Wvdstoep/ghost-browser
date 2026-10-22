package engineer.myapp.gb.shared

import kotlin.test.Test
import kotlin.test.assertEquals

class FlowCatalogTest {
    private val google = FlowInfo("g", "Collect leads", 2, "Find prospects", profile = "google", role = "research", runs = 3, verified = true)
    private val reddit = FlowInfo("r", "Reply to post", 1, "Draft reply", profile = "reddit", lastStatus = "failed")

    @Test fun searchAndPlatformFilterUseUsefulMetadata() {
        assertEquals(listOf(google), FlowCatalog.filter(listOf(google, reddit), "research", "All"))
        assertEquals(listOf(reddit), FlowCatalog.filter(listOf(google, reddit), "", "Reddit"))
    }

    @Test fun statusPrioritizesFailuresOverVerification() {
        assertEquals("Verified", FlowCatalog.status(google))
        assertEquals("Needs attention", FlowCatalog.status(reddit))
        assertEquals("Never run", FlowCatalog.status(reddit.copy(lastStatus = "")))
    }
}
