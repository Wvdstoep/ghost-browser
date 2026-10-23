package engineer.myapp.gbmobile

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import android.content.Context

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RangeScanDbTest {
    @Test fun upgradesAnExistingScanDatabaseWithoutLosingResults() {
        val context = RuntimeEnvironment.getApplication()
        context.deleteDatabase("gb_range_scan.db")
        val old = context.openOrCreateDatabase("gb_range_scan.db", Context.MODE_PRIVATE, null)
        old.execSQL("CREATE TABLE job (slot INTEGER PRIMARY KEY, run_id INTEGER, cidr TEXT, ports TEXT, rate INTEGER, next_index INTEGER, total INTEGER, hits INTEGER, status TEXT, updated_at INTEGER)")
        old.execSQL("CREATE TABLE result (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, cidr TEXT, host TEXT, ports TEXT, recorded_at INTEGER)")
        old.execSQL("INSERT INTO result(run_id,cidr,host,ports,recorded_at) VALUES(1,'192.168.1.0/24','192.168.1.1','80',1)")
        old.version = 1
        old.close()
        val upgraded = RangeScanDb(context)
        assertEquals("192.168.1.1", upgraded.results().getJSONObject(0).getString("url").removePrefix("http://"))
        assertEquals(0, upgraded.results().getJSONObject(0).getJSONObject("fields").getJSONArray("webServices").length())
        assertEquals("new", upgraded.reviewItems(1).single().reviewState)
        upgraded.close()
    }

    @Test fun checkpointAndResultsSurviveReopen() {
        val context = RuntimeEnvironment.getApplication()
        context.deleteDatabase("gb_range_scan.db")
        val plan = RangePlan.parse("192.168.4.0/30")!!
        val first = RangeScanDb(context)
        val job = first.begin(plan, listOf(22, 80), 10, true)
        first.checkpoint(job, "192.168.4.1", listOf(80), 1,
            listOf(WebServiceProbe.Finding(80, "https", 200, "Test app", "nginx", "", "security@example.org")))
        first.close()

        val reopened = RangeScanDb(context)
        val saved = reopened.read()!!
        assertEquals(job.runId, saved.runId)
        assertEquals(1, saved.nextIndex)
        assertEquals(1, saved.hits)
        assertTrue(saved.webFollowUp)
        assertEquals(listOf(22, 80), saved.ports)
        assertEquals("192.168.4.1", plan.hosts[saved.nextIndex - 1])
        assertEquals("https://192.168.4.1:80", reopened.results().getJSONObject(0).getString("url"))
        assertTrue(reopened.results().getJSONObject(0).getJSONArray("ports").getJSONObject(0).getString("service").contains("Test app"))
        val evidence = reopened.reviewItems(job.runId).single()
        assertEquals("new", evidence.reviewState)
        assertEquals("security@example.org", evidence.publishedContact)
        assertTrue(reopened.setReviewState(evidence.id, "reviewed"))
        assertEquals("reviewed", reopened.reviewItems(job.runId).single().reviewState)
        assertFalse(reopened.setReviewState(evidence.id, "sent"))

        reopened.status(saved.runId, "paused")
        assertEquals("paused", reopened.read()?.status)
        reopened.checkpoint(reopened.read()!!, "192.168.4.2", emptyList(), 2)
        assertEquals(2, reopened.read()?.nextIndex)
        assertEquals(1, reopened.read()?.hits)
        val next = reopened.begin(plan, listOf(80), 10)
        reopened.checkpoint(next, "192.168.4.2", listOf(80), 1)
        assertEquals(2, reopened.reviewItems().size)
        reopened.close()
    }
}
