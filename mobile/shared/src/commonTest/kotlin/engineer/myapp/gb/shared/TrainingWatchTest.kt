package engineer.myapp.gb.shared

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * THE PIPELINE SCREEN, AND THE WAYS IT WOULD LIE CONFIDENTLY.
 *
 * A status screen that is merely missing is annoying. A status screen that is WRONG is worse than
 * none, because everything downstream is decided on it — whether to leave a laptop running, whether
 * tonight is worth a machine, whether the model that is serving is the good one. So every test here
 * is one confident falsehood:
 *
 *   - a device four hours into a round reads as idle, and somebody closes the lid;
 *   - a round that died overnight still reads as progress;
 *   - a round that LOST is shown as a win, because it finished;
 *   - two `tiers` objects exist in the payload and the screen reads the wrong one, so the corpus
 *     and the dataset silently swap numbers;
 *   - a number is still being counted and is shown as if it were final.
 *
 * Parsed at string level, like RingWatch, so braces and quotes inside goals and log lines are the
 * thing that actually breaks.
 */
class TrainingWatchTest {

    private val payload = """
    {
     "corpus": {
      "jobsWithVerdict": 1396,
      "tiers": {"gold": 1147, "silver": 97, "bronze": 152, "void": 829},
      "unjudged": 12,
      "jobs": 2226,
      "scanning": false,
      "pending": 0,
      "usableSinceLastRound": 240,
      "enoughForARound": true
     },
     "dataset": {
      "builtAt": "2026-09-22T19:45:24.859Z",
      "turns": {"train": 23233, "eval": 3298, "reject": 8715},
      "tiers": {"gold": 1147, "silver": 97, "bronze": 152, "void": 829},
      "dropped": {"the call itself threw": 341, "an identical decision in an identical situation": 5791},
      "marks": {"turnsWithMarks": 0, "indexTurns": 2987, "indexWithMarks": 0}
     },
     "serving": {"adapter": "gb-role-lora-v1", "agreement": 58.9, "beat": 41.2, "device": "laptop-carla"},
     "rounds": [
      {"id": "r-2", "device": "laptop-carla", "status": "running", "startedAt": "t2", "endedAt": null,
       "turns": 1250, "promoted": false, "baseline": null, "result": null,
       "lines": [{"at": "t", "text": "420 turns, loss 0.712, 95 min in"}]},
      {"id": "r-1", "device": "laptop-carla", "status": "done", "startedAt": "t1", "endedAt": "t1b",
       "turns": 900, "promoted": false, "why": "22% against 41%",
       "baseline": 41.2, "result": 22.0, "lines": []}
     ],
     "trainers": [
      {"name": "laptop-carla", "online": true,
       "training": {"roundId": "r-2", "status": "running", "stale": false, "silentForMin": 3,
                    "turns": 1250, "last": {"at": "t", "text": "420 turns, loss 0.712, 95 min in"},
                    "promoted": false, "baseline": null, "result": null}},
      {"name": "spare-laptop", "online": false, "training": null}
     ],
     "byDevice": {
      "laptop-carla": {"roundId": "r-2", "status": "running", "stale": false, "silentForMin": 3,
                       "turns": 1250, "last": {"at": "t", "text": "420 turns, loss 0.712, 95 min in"},
                       "promoted": false, "baseline": null, "result": null}
     }
    }
    """.trimIndent()

    @Test
    fun readsTheCorpus() {
        val v = TrainingWatch.parse(payload)
        assertEquals(1147, v.corpus.tiers.gold)
        assertEquals(829, v.corpus.tiers.void)
        assertEquals(2226, v.corpus.jobs)
        /* Bronze and void are kept, but neither is something a round can learn the right answer from. */
        assertEquals(1244, v.corpus.tiers.usable)
        assertTrue(v.corpus.enoughForARound)
    }

    @Test
    fun doesNotConfuseTheCorpusTiersWithTheDatasetTiers() {
        /* Both objects carry a `tiers` key. A plain search for the name finds whichever the server
           happened to serialise first, and the two numbers then swap places for no visible reason. */
        val v = TrainingWatch.parse(payload)
        assertEquals(23233, v.dataset?.trainTurns)
        assertEquals(3298, v.dataset?.evalTurns)
        assertEquals(1147, v.dataset?.tiers?.gold)
    }

    @Test
    fun surfacesHowMuchOfTheSetIsNotActuallyLearnable() {
        /* 2,987 turns answer with an element NUMBER, and the numbered list they came from was never
           recorded. Training on them teaches index-guessing. The screen has to say so, because the
           number only heals as fresh runs land and nobody would think to ask. */
        val v = TrainingWatch.parse(payload)
        assertEquals(2987, v.dataset?.indexTurns)
        assertEquals(0, v.dataset?.indexLearnable)
    }

    @Test
    fun readsWhyTurnsWereThrownAway() {
        val dropped = TrainingWatch.parse(payload).dataset?.dropped ?: emptyList()
        assertEquals("an identical decision in an identical situation", dropped.first().first)
        assertEquals(5791, dropped.first().second)
    }

    @Test
    fun aRoundThatLostIsNotAWin() {
        /* Finishing is not winning. If this reads the other way a worse adapter reaches service on
           the strength of being the most recent thing to complete. */
        val lost = TrainingWatch.parse(payload).rounds.first { it.id == "r-1" }
        assertEquals("done", lost.status)
        assertFalse(lost.won)
        assertFalse(lost.promoted)
        /* And it is still listed — the losing rounds are the evidence the gate works. */
        assertEquals(2, TrainingWatch.parse(payload).rounds.size)
    }

    @Test
    fun findsTheRoundHappeningNow() {
        val v = TrainingWatch.parse(payload)
        assertEquals("r-2", v.active?.id)
        assertEquals(1250, v.active?.turns)
        assertEquals("420 turns, loss 0.712, 95 min in", v.active?.lines?.last())
    }

    @Test
    fun readsWhatIsServing() {
        val s = TrainingWatch.parse(payload).serving
        assertEquals("gb-role-lora-v1", s?.adapter)
        assertEquals(58.9, s?.agreement)
        /* What it beat travels with it, so a rollback decision needs nothing else on screen. */
        assertEquals(41.2, s?.beat)
    }

    @Test
    fun aTrainerCarriesItsOwnRound() {
        val t = TrainingWatch.parse(payload).trainers
        assertEquals(2, t.size)
        assertEquals("r-2", t[0].round?.roundId)
        assertTrue(t[0].round!!.running)
        /* A trainer with nothing to do says so, rather than being left off the list. */
        assertNull(t[1].round)
        assertFalse(t[1].online)
    }

    @Test
    fun theDeviceRowSaysWhatTheMachineIsActuallyDoing() {
        /* "online, idle" next to a laptop four hours into a round is how somebody closes the lid. */
        val r = TrainingWatch.parse(payload).byDevice["laptop-carla"]
        assertEquals("training — 420 turns, loss 0.712, 95 min in", TrainingWatch.deviceLine(r))
    }

    @Test
    fun aSilentRoundIsNotReportedAsProgress() {
        val r = TrainingWatch.DeviceRound(status = "running", stale = true, silentForMin = 240)
        assertEquals("training — nothing heard for 240 min", TrainingWatch.deviceLine(r))
    }

    @Test
    fun aFinishedRoundThatLostSaysItWasNotUsed() {
        val r = TrainingWatch.DeviceRound(status = "done", baseline = 41.2, result = 22.0)
        assertEquals("last round: 22% against 41.2% — not better, not used", TrainingWatch.deviceLine(r))
    }

    @Test
    fun aDeviceWithNoRoundSaysNothingAtAll() {
        assertEquals("", TrainingWatch.deviceLine(null))
    }

    @Test
    fun saysThatTheHistoryIsStillBeingRead() {
        /* 284 MB of job files are read in slices, so the count climbs over several polls. Showing a
           partial number as if it were final is the quiet version of being wrong. */
        val c = TrainingWatch.Corpus(scanning = true, pending = 1826)
        assertTrue(TrainingWatch.readiness(c).contains("1826"))
        assertTrue(TrainingWatch.readiness(c).startsWith("reading the history"))
    }

    @Test
    fun saysWhenThereIsNotEnoughNewWorkToBeWorthANight() {
        val c = TrainingWatch.Corpus(tiers = TrainingWatch.Tiers(gold = 10), usableSinceLastRound = 12)
        assertTrue(TrainingWatch.readiness(c).startsWith("waiting"))
        assertTrue(TrainingWatch.readiness(c).contains("200"))
    }

    @Test
    fun survivesBracesAndQuotesInsideAGoalOrALogLine() {
        /* The parser is character-level, so this is the thing that actually breaks it. */
        val tricky = """
        {"corpus":{"tiers":{"gold":1},"jobs":1,"scanning":false,"pending":0,
          "usableSinceLastRound":0,"enoughForARound":false},
         "rounds":[{"id":"r-1","status":"running","device":"d",
           "lines":[{"at":"t","text":"wrote {\"tool\":\"look\",\"args\":{}} — and it worked"}]}],
         "trainers":[],"byDevice":{}}
        """.trimIndent()
        val v = TrainingWatch.parse(tricky)
        assertEquals(1, v.rounds.size)
        assertEquals("wrote {\"tool\":\"look\",\"args\":{}} — and it worked", v.rounds[0].lines.first())
        assertEquals(1, v.corpus.tiers.gold)
    }

    @Test
    fun survivesAnEmptyMachineAndAnError() {
        val empty = TrainingWatch.parse("""{"corpus":{"tiers":{},"jobs":0},"rounds":[],"trainers":[],"byDevice":{}}""")
        assertEquals(0, empty.corpus.tiers.judged)
        assertTrue(empty.rounds.isEmpty())
        assertNull(empty.serving)
        assertNull(empty.active)

        assertEquals("nothing came back", TrainingWatch.parse("").error)
        assertEquals("nope", TrainingWatch.parse("""{"error":"nope"}""").error)
    }

    @Test
    fun showsADashRatherThanAFakeZeroWhenThereIsNoNumber() {
        /* A round still running has no result. Rendering that as 0% reads as a catastrophic model. */
        assertEquals("—", TrainingWatch.pct(-1.0))
        assertEquals("58.9%", TrainingWatch.pct(58.9))
        assertEquals("41%", TrainingWatch.pct(41.0))
    }

    /* A round carries what it trained with and whether it was still learning. A score with neither
       beside it is a number nobody can compare to the next one. */
    @Test
    fun aRoundCarriesItsRecipeAndItsValidationCurve() {
        val json = """{"corpus":{"tiers":{}},"rounds":[{"id":"r-1","device":"laptop","status":"running","turns":900,
          "recipe":{"base":"Qwen/Qwen2.5-0.5B-Instruct","device":"cpu","dtype":"float32","loraR":32,"loraAlpha":64,"loraScope":"all","lr":0.0002,"epochs":3,"batch":1,"accum":16},
          "validation":[{"step":10,"turns":160,"valLoss":1.42},{"step":20,"turns":320,"valLoss":1.21},{"step":30,"turns":480,"valLoss":1.25}],
          "bestValLoss":1.21,"bestAtTurns":320,"lines":[]}]}"""
        val r = TrainingWatch.parse(json).rounds.single()
        assertEquals("r32 all · lr 2e-4 · 3 epochs × 16 · cpu float32", r.recipe)
        assertEquals(listOf(160 to 1.42, 320 to 1.21, 480 to 1.25), r.validation)
        assertEquals(1.21, r.bestValLoss)
        assertEquals(320, r.bestAtTurns)
        assertEquals("1.210", TrainingWatch.loss(1.21))
        assertEquals("—", TrainingWatch.loss(-1.0))
    }

    /* "On" with nothing moving reads as broken. When the allowance is spent the line says so, and
       says the collector comes back on its own — that is the difference between a pause and a fault. */
    @Test
    fun theCollectorSaysWhyItIsWaiting() {
        val spent = TrainingWatch.parseHarvest("""{"on":true,"queued":9,"inLastHour":3,"capPerHour":48,"collected":94,
          "keys":{"total":2,"usable":0},"plan":{"run":false,"why":"the model allowance is spent (0 of 2 keys usable) — waiting, resumes by itself when a key works again"}}""")!!
        assertTrue(spent.waiting)
        assertEquals(0, spent.keysUsable)
        assertEquals("on, waiting — the model allowance is spent (0 of 2 keys usable); resumes by itself", TrainingWatch.harvestLine(spent))

        val width = TrainingWatch.parseHarvest("""{"on":true,"queued":9,"inLastHour":3,"capPerHour":48,"collected":94,
          "keys":{"total":2,"usable":2},"plan":{"run":false,"why":"4 walk(s) already running, and the width is 4"}}""")!!
        assertEquals("on, waiting — 4 walk(s) already running, and the width is 4", TrainingWatch.harvestLine(width))

        val running = TrainingWatch.parseHarvest("""{"on":true,"queued":9,"inLastHour":3,"capPerHour":48,"collected":94,
          "keys":{"total":2,"usable":2},"plan":{"run":true,"why":"9 prompt(s) queued"}}""")!!
        assertFalse(running.waiting)
        assertEquals("on — 9 queued, 3 of 48 run this hour", TrainingWatch.harvestLine(running))
    }

    /* The six checks, the plan and the set per tool travel on the state; the headline is the
       planner's own sentence, and the older corpus rule only when the cluster sends no plan. */
    @Test
    fun readsTheReadinessEngineAndSpeaksWithThePlannersWords() {
        val v = TrainingWatch.parse("""{"corpus":{"tiers":{}},"rounds":[],
          "plan":{"run":false,"why":"only 98 turn(s) can see the page they decide on, and a round draws 440 — collecting"},
          "readiness":{"ok":false,"score":22,"why":"only 98 turn(s) can see the page they decide on, and a round draws 440 — collecting","aim":["hover","type"],
            "checks":[{"name":"sight","gate":true,"value":98,"threshold":440,"ok":false,"score":22,"text":"only 98 turn(s)..."},
                      {"name":"coverage","gate":false,"value":29,"threshold":66,"ok":false,"score":44,"text":"37 tool(s) have fewer than 4 sighted examples"}]},
          "coverage":{"total":11731,"sighted":98,"perTool":[{"tool":"look","all":2089,"sighted":40,"gold":30},{"tool":"open","all":2830,"sighted":12,"gold":9}]}}""")
        assertEquals(22, v.readiness!!.score)
        assertFalse(v.readiness!!.ok)
        assertEquals(listOf("hover", "type"), v.readiness!!.aim)
        assertEquals("coverage", v.readiness!!.checks[1].name)
        assertFalse(v.readiness!!.checks[1].gate)
        assertEquals(2, v.coverage!!.perTool.size)
        assertEquals(12, v.coverage!!.perTool[1].sighted)
        assertEquals("waiting — only 98 turn(s) can see the page they decide on, and a round draws 440 — collecting · ready 22%", TrainingWatch.headline(v))

        val old = TrainingWatch.parse("""{"corpus":{"tiers":{"gold":3},"usableSinceLastRound":59},"rounds":[]}""")
        assertNull(old.plan)
        assertEquals("waiting — 59 new usable run(s), a round wants about 200", TrainingWatch.headline(old))
    }

    @Test
    fun theCollectorShowsWhatIsRunningNow() {
        val h = TrainingWatch.parseHarvest("""{"on":true,"queued":3,"inLastHour":2,"capPerHour":48,"collected":10,
          "walks":[{"jobId":"j1","profile":"default","goal":"Go to anwb.nl and record the traffic jams","steps":7,"since":"2026-09-24T09:00:00Z","last":"read the page (1200 characters)"}]}""")!!
        assertEquals(1, h.walks.size)
        assertEquals("default", h.walks[0].profile)
        assertEquals(7, h.walks[0].steps)
    }

    @Test
    fun aRoundFromBeforeTheRecipeExistedStillReads() {
        val r = TrainingWatch.parse("""{"corpus":{"tiers":{}},"rounds":[{"id":"r-0","status":"done","turns":10,"baseline":3.3,"result":15.3}]}""").rounds.single()
        assertEquals("", r.recipe)
        assertTrue(r.validation.isEmpty())
        assertEquals(-1.0, r.bestValLoss)
    }

    @Test
    fun theFieldOfStudentsReadsItsOwnScores() {
        val v = TrainingWatch.parse("""{"corpus":{"tiers":{}},"students":{
          "candidates":[
            {"id":"Qwen/Qwen2.5-0.5B-Instruct","name":"Qwen2.5 0.5B","params":"0.5B","why":"the incumbent","queued":false,
             "trial":{"round":"r-a","status":"done","turns":354,"agreement":6.1,"args":2.0,"unusable":18.2,"collapse":3.1,"collapseTool":"read","running":false}},
            {"id":"Qwen/Qwen3-1.7B","name":"Qwen3 1.7B","params":"1.7B","why":"three times the size","queued":true,"trial":null}
          ],
          "queue":["Qwen/Qwen3-1.7B"],"leader":{"id":"Qwen/Qwen2.5-0.5B-Instruct","name":"Qwen2.5 0.5B","agreement":6.1},"running":false}}""")
        val s = v.students!!
        assertEquals(2, s.candidates.size)
        assertEquals(354, s.candidates[0].trial!!.turns)
        assertEquals(6.1, s.candidates[0].trial!!.agreement)
        /* Never tried is null, not zero: a zero would sort like a loss. */
        assertEquals(null, s.candidates[1].trial)
        assertTrue(s.candidates[1].queued)
        assertEquals("Qwen2.5 0.5B", s.leaderName)
        assertEquals(listOf("Qwen/Qwen3-1.7B"), s.queue)
    }

    @Test
    fun anOlderHubSimplyHasNoField() {
        assertEquals(null, TrainingWatch.parse("""{"corpus":{"tiers":{}}}""").students)
    }

    @Test
    fun theScoreboardReadsEveryModelAsAColumn() {
        val r = TrainingWatch.parseResults("""{
          "rounds":[
            {"id":"r-a","at":"2026-09-26T09:00:00Z","model":"Qwen/Qwen2.5-0.5B-Instruct","wore":"hub:r-x","scope":"base",
             "trial":false,"device":"Modal L4","turns":2031,"epochs":3,"lr":0.00004,"answerTokens":320,
             "start":36.44,"after":41.2,"change":4.76,"args":19.2,"unusable":1.7,
             "collapse":1.54,"collapseTool":"read","distinct":24,"verdict":"promoted","why":"",
             "perTool":[{"tool":"open","seen":75,"before":18.7,"after":28.0,"change":9.3}]},
            {"id":"r-t","at":"2026-09-26T05:00:00Z","model":"Qwen/Qwen3-1.7B","wore":"","scope":"base",
             "trial":true,"device":"Modal L4","turns":0,"start":null,"after":12.43,"change":null,
             "collapse":0.99,"collapseTool":"open","distinct":25,"verdict":"measured","perTool":[]}
          ],
          "tools":[{"tool":"open","seen":75},{"tool":"read","seen":41}],
          "models":["Qwen/Qwen2.5-0.5B-Instruct","Qwen/Qwen3-1.7B"],
          "serving":{"id":"r-a","model":"Qwen/Qwen2.5-0.5B-Instruct","agreement":41.2}}""")
        assertEquals(2, r.rounds.size)
        assertEquals("Qwen2.5-0.5B-Instruct", r.rounds[0].shortModel)
        assertEquals(4.76, r.rounds[0].change)
        assertEquals(9.3, r.rounds[0].perTool[0].change)
        assertEquals(listOf("open", "read"), r.tools)
        assertEquals("r-a", r.servingId)
        /* A trial never had a start, and absent is not zero. */
        val trial = r.rounds[1]
        assertTrue(trial.trial)
        assertEquals(-1.0, trial.start)
        assertEquals(-999.0, trial.change)
    }

    @Test
    fun aScoreboardFromAnOlderHubSaysSoRatherThanShowingNothing() {
        assertEquals("nothing came back", TrainingWatch.parseResults("").error)
        /* An empty list is a real answer: nothing has been measured. */
        val empty = TrainingWatch.parseResults("""{"rounds":[],"tools":[]}""")
        assertEquals(0, empty.rounds.size)
        assertEquals("", empty.error)
        /* No list at all is a cluster that has never heard of this - a different thing to say. */
        val older = TrainingWatch.parseResults("""{"error":"Cannot GET /v1/training/results"}""")
        assertTrue(older.error.contains("update the cluster"))
        assertTrue(TrainingWatch.parseResults("<!DOCTYPE html><html>404</html>").error.contains("update the cluster"))
    }
}
