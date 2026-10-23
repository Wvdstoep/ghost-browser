package engineer.myapp.gbmobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalReconScheduleTest {
    private val hour = 60 * 60_000L

    @Test fun runsOnlyActiveScheduledHttpTargetsWhenDue() {
        assertTrue(LocalReconSchedule.due(true, true, "https://example.org", hour, 0, 60))
        assertFalse(LocalReconSchedule.due(false, true, "https://example.org", hour, 0, 60))
        assertFalse(LocalReconSchedule.due(true, false, "https://example.org", hour, 0, 60))
        assertFalse(LocalReconSchedule.due(true, true, "ftp://example.org", hour, 0, 60))
        assertFalse(LocalReconSchedule.due(true, true, "https://example.org", hour - 1, 0, 60))
    }

    @Test fun enforcesAndroidsFifteenMinuteMinimum() {
        assertFalse(LocalReconSchedule.due(true, true, "http://example.org", 14 * 60_000L, 0, 1))
        assertTrue(LocalReconSchedule.due(true, true, "http://example.org", 15 * 60_000L, 0, 1))
    }
}
