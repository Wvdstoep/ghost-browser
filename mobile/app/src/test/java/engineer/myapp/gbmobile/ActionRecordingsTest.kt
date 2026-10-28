package engineer.myapp.gbmobile
import org.json.JSONObject
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class ActionRecordingsTest {
 @Test fun parsesSavedLibraryWithoutConfusingItWithVideoRecordings() {
  val rows=AssistantJson.actionRecordings("""{"cards":[{"id":"maps","origin":"https://www.google.com","intent":"maps.v1","kind":"Built-in browser routine","status":"Ready for compatible runs","reason":"Fresh inputs","uses":2,"lastVerifiedLabel":"2026-10-28T07:31:28Z"}]}""")
  assertEquals(1,rows.size); assertEquals(2,rows[0].uses); assertEquals("Built-in browser routine",rows[0].kind)
 }
 @Test fun distinguishesEmptyLibraryFromApiFailure() {
  assertTrue(AssistantJson.actionRecordings("""{"cards":[]}""").isEmpty())
  var failed=false
  try { AssistantJson.actionRecordings("""{"error":"Unauthorized"}""") } catch (e:Exception) { failed=true }
  assertTrue(failed)
 }
 @Test fun preservesFreshQueryAndExplicitReplayOutcome() {
  val evidence=AssistantJson.execution(JSONObject("""{"data":{"execution":{"mode":"Saved routine reused","input":"animal doctors in Amsterdam","reason":"City verified","recording":"maps.v1","verified":true}}}"""))
  assertTrue(evidence.contains("animal doctors in Amsterdam")); assertTrue(evidence.contains("Verified outcome"))
 }
 @Test fun olderJobsAreNotLabelledAsReplay() {
  assertTrue(AssistantJson.execution(JSONObject()).contains("No execution evidence"))
 }
}
