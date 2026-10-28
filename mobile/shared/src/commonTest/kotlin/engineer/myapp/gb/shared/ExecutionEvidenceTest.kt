package engineer.myapp.gb.shared
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.assertFalse
class ExecutionEvidenceTest {
 @Test fun olderRunsDoNotPretendToUseReplay() {
  assertEquals("No execution evidence · Older run or unsupported executor", executionEvidence("", "", "", "", false))
 }
 @Test fun replayShowsFreshInputsAndVerifiedOutcome() {
  val s=executionEvidence("Saved routine reused", "animal doctors in Amsterdam", "City checked", "maps.v1", true)
  assertTrue(s.contains("animal doctors in Amsterdam"));assertTrue(s.contains("Recording: maps.v1"));assertTrue(s.contains("Verified outcome"))
 }
 @Test fun blockedRunsAndCapturesRemainDistinct() {
  val s=executionEvidence("Replay fallback", "", "Needs login", "card", false, "new-card", "Needs verification")
  assertTrue(s.contains("Outcome not verified"));assertTrue(s.contains("Captured: new-card"));assertFalse(s.contains("Verified outcome"))
 }
}
