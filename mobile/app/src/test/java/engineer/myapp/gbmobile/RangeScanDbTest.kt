package engineer.myapp.gbmobile

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RangeScanDbTest {
    @Test fun checkpointAndResultsSurviveReopen() {
        val context = RuntimeEnvironment.getApplication()
        context.deleteDatabase("gb_range_scan.db")
        val plan = RangePlan.parse("192.168.4.0/30")!!
        val first = RangeScanDb(context)
        val job = first.begin(plan, listOf(22, 80), 10)
        first.checkpoint(job, "192.168.4.1", listOf(80), 1)
        first.close()

        val reopened = RangeScanDb(context)
        val saved = reopened.read()!!
        assertEquals(job.runId, saved.runId)
        assertEquals(1, saved.nextIndex)
        assertEquals(1, saved.hits)
        assertEquals(listOf(22, 80), saved.ports)
        assertEquals("192.168.4.1", plan.hosts[saved.nextIndex - 1])
        assertEquals("http://192.168.4.1", reopened.results().getJSONObject(0).getString("url"))

        reopened.status(saved.runId, "paused")
        assertEquals("paused", reopened.read()?.status)
        reopened.checkpoint(reopened.read()!!, "192.168.4.2", emptyList(), 2)
        assertEquals(2, reopened.read()?.nextIndex)
        assertEquals(1, reopened.read()?.hits)
        reopened.close()
    }
}
