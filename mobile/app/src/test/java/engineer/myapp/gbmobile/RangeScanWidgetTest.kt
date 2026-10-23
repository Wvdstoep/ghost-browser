package engineer.myapp.gbmobile

import org.junit.Assert.*
import org.junit.Test

class RangeScanWidgetTest {
    private fun job(status: String, cidr: String = "192.168.1.0/24", ports: List<Int> = listOf(80)) =
        RangeScanJob(1, cidr, ports, 10, 51, 254, 3, status, 1, true)

    @Test fun liveWidgetShowsDurableProgressAndLatestMatch() {
        val running = job("running")
        val result = RangeEvidence(1, 1, running.cidr, "192.168.1.19", listOf(80, 443), 1, emptyList(), "new")
        val state = RangeScanWidgetState.from(running, result, RangeScanWidgetCommand.StartDecision.NONE)
        assertEquals("SCANNING", state.status)
        assertEquals(51, state.progress)
        assertEquals(254, state.total)
        assertEquals(3, state.matches)
        assertTrue(state.results.single().label.contains("192.168.1.19"))
        assertEquals(1L, state.results.single().id)
        assertTrue(state.canPause)
        assertEquals("Running", state.startLabel)
    }

    @Test fun widgetOffersThreeIndividuallyIdentifiedRecentHosts() {
        val job = job("running")
        val evidence = (1L..4L).map { id ->
            RangeEvidence(id, job.runId, job.cidr, "192.168.1.$id", listOf(80), id,
                listOf(WebServiceProbe.Finding(80, "http", 200, "Page", "nginx", "")), "new")
        }
        val state = RangeScanWidgetState.from(job, evidence, RangeScanWidgetCommand.StartDecision.NONE)
        assertEquals(listOf(1L, 2L, 3L), state.results.map { it.id })
        assertTrue(state.results.all { it.label.contains("web") })
    }

    @Test fun widgetActionsRequireAValidSavedScopeAndPlan() {
        assertEquals(RangeScanWidgetCommand.StartDecision.RESUME,
            RangeScanWidgetCommand.decideStart(job("paused"), emptySet()))
        assertEquals(RangeScanWidgetCommand.StartDecision.RESTART,
            RangeScanWidgetCommand.decideStart(job("completed"), emptySet()))
        assertEquals(RangeScanWidgetCommand.StartDecision.NONE,
            RangeScanWidgetCommand.decideStart(job("running"), emptySet()))
        assertEquals(RangeScanWidgetCommand.StartDecision.NONE,
            RangeScanWidgetCommand.decideStart(job("paused", "8.8.8.0/30"), emptySet()))
        assertEquals(RangeScanWidgetCommand.StartDecision.RESUME,
            RangeScanWidgetCommand.decideStart(job("paused", "8.8.8.0/30"), setOf("8.8.8.0/30")))
        assertEquals(RangeScanWidgetCommand.StartDecision.NONE,
            RangeScanWidgetCommand.decideStart(job("completed", ports = listOf(0)), emptySet()))
        assertEquals(RangeScanWidgetCommand.StartDecision.NONE,
            RangeScanWidgetCommand.decideStart(job("paused").copy(nextIndex = 254), emptySet()))
        assertEquals("Set up", RangeScanWidgetState.from(null, null, RangeScanWidgetCommand.StartDecision.NONE).startLabel)
    }
}
