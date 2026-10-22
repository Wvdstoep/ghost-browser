package engineer.myapp.gb.shared

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * THE TRAINING PIPELINE, AS A PAGE YOU CAN LOOK AT.
 *
 * The loop is meant to improve the model every night without anybody driving it, which is exactly
 * why it needs a surface: an unattended process with no face is indistinguishable from a broken one.
 *
 * The page answers four questions in the order somebody actually asks them:
 *
 *   IS ANYTHING HAPPENING RIGHT NOW?   first, because it is the only one with a time limit.
 *   WHAT HAS BEEN COLLECTED?           and is it enough to be worth a machine tonight.
 *   WHAT IS SERVING?                   and what it beat, so a rollback needs nothing else on screen.
 *   WHAT HAPPENED BEFORE?              every round kept, the losses included — those are the
 *                                      evidence that the promotion gate is doing its job.
 *
 * Deliberately read-only except for one button. Promotion is the single act with a consequence, and
 * the cluster refuses it for any round that did not beat its own baseline, so the button can be
 * offered without it being a way to make a mistake.
 */
@Composable
fun TrainingScreen(
    view: TrainingWatch.View,
    onRefresh: () -> Unit,
    onPromote: (String) -> Unit,
    /* Three controls and no more. The loop runs itself; these exist to stop it, to force it, and to
       say which machines may take part. Everything else on this page is something to read. */
    onSetAuto: (Boolean) -> Unit = {},
    onRunNow: () -> Unit = {},
    onAllowTrainer: (String, Boolean) -> Unit = { _, _ -> },
    onSetUpTrainer: (String) -> Unit = {},
    /* The fourth control: let the browser collect its own training data instead of somebody
       typing one prompt at a time. Off by default, because it spends model credit. */
    onSetHarvest: (Boolean) -> Unit = {},
    /* The fifth: give the old runs their pages back. Browser time only, no model credit. */
    onSetResight: (Boolean) -> Unit = {},
    /* The sixth: how the trained model is served - mode (off/shadow/canary/primary) or model tag. */
    onSetServing: (mode: String?, model: String?) -> Unit = { _, _ -> },
    /* The seventh: where rounds run. Fields: trainOn, key, gpuType, maxHours - any subset. */
    onSetGpu: (fields: Map<String, String>) -> Unit = {},
    onDestroyGpu: () -> Unit = {},
    /* The eighth: the teacher judging old runs. And the runs browser: the rows, one open run, a label. */
    onSetJudge: (Boolean) -> Unit = {},
    /* The ninth and tenth: the practice collector (a thin role, signed in) and autopilot serving. */
    onSetPractice: (Boolean) -> Unit = {},
    onSetAutopilot: (Boolean) -> Unit = {},
    /* The eleventh: end a round on any machine. The hub marks it, tells the machine to kill its
       trainer, and answers the trainer's next line with stop in case the machine was not told. */
    onStopRound: (String) -> Unit = {},
    /* GPU nodes: mint a join for a kind, revoke one, set Modal (tokenId, tokenSecret, gpu, auto), start or stop the Modal node. */
    onNodeJoin: (String) -> Unit = {},
    onNodeRevoke: (String) -> Unit = {},
    onSetModal: (Map<String, String>) -> Unit = {},
    /* The twelfth: score the candidate students on the same paper. An empty list means all of them. */
    onTrialStudents: (List<String>) -> Unit = {},
    /* The scoreboard: every measured round in one table, loaded when the tab is opened. */
    results: TrainingWatch.Results? = null,
    onLoadResults: () -> Unit = {},
    /* Side by side: what may be replayed, the run in progress, and the two ways to start one. */
    compareOffer: TrainingWatch.CompareOffer? = null,
    compareRun: TrainingWatch.CompareRun? = null,
    onLoadCompare: () -> Unit = {},
    onCompareRecorded: (jobId: String, model: String) -> Unit = { _, _ -> },
    onCompareLive: (prompt: String, model: String) -> Unit = { _, _ -> },
    onCompareStop: () -> Unit = {},
    onModalStart: () -> Unit = {},
    onModalStop: () -> Unit = {},
    runs: List<TrainingWatch.RunRow> = emptyList(),
    runDetail: TrainingWatch.RunDetail? = null,
    onLoadRuns: () -> Unit = {},
    onOpenRun: (String) -> Unit = {},
    onCloseRun: () -> Unit = {},
    onLabelStep: (id: String, n: Int, verdict: String) -> Unit = { _, _, _ -> },
    modifier: Modifier = Modifier,
    topInset: Modifier = Modifier,
) {
    val cs = MaterialTheme.colorScheme
    /*
     * THE STUDIO. One screen was a stack of eleven cards; nobody reads eleven cards. It is now five
     * sections a person moves between - Overview, Data, Rounds, Model, Machines - each answering one
     * question, with the state that matters most (is the data ready, what happens next, what is
     * running) on the first. The layout follows the width: a phone gets the sections as tabs and one
     * column; a laptop or a wide window gets a rail on the left and two columns, so the page is a
     * dashboard rather than a very long phone.
     */
    var section by remember { mutableStateOf(Section.OVERVIEW) }
    /* One open run lies over the page, so the list it came from is still there when it closes. */
    if (runDetail != null) { RunDetailScreen(runDetail, onCloseRun, onLabelStep, modifier, topInset); return }
    Surface(color = cs.background, contentColor = cs.onBackground, modifier = modifier.fillMaxSize()) {
        BoxWithConstraints(Modifier.fillMaxSize().then(topInset)) {
            val wide = maxWidth >= 760.dp
            val twoColumns = maxWidth >= 1080.dp
            Column(Modifier.fillMaxSize()) {
                StudioHeader(view, onRefresh)
                if (view.error.isNotBlank()) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(view.error, color = cs.onSurfaceVariant, fontSize = 13.sp)
                    }
                    return@Column
                }
                if (!wide) SectionTabs(section) { section = it }
                Row(Modifier.fillMaxSize()) {
                    if (wide) SectionRail(section) { section = it }
                    val left = mutableListOf<@Composable () -> Unit>()
                    val right = mutableListOf<@Composable () -> Unit>()
                    when (section) {
                        Section.OVERVIEW -> {
                            /* THE BATCH: every connected machine as a lane with its own share, progress and phase,
                               the merge lane, and the chain as a strip - or one plain card per round before the batches. */
                            if (view.actives.isNotEmpty() || view.pending.isNotEmpty()) left += { BatchStage(view, onStopRound) }
                            view.actives.filter { it.batch.isBlank() }.forEach { r -> left += { RunningCard(r, onStopRound) } }
                            view.readiness?.let { r -> left += { ReadinessHero(r, view.plan, view.dataset, view.corpus, view.serving, view.auto, onSetAuto, onRunNow) } }
                                ?: run { left += { AutoCard(view, onSetAuto, onRunNow) } }
                            right += { LoopsCard(view, onSetAuto, onSetHarvest, onSetResight, onSetJudge, onSetPractice) }
                            view.student?.let { s -> right += { ModelGlance(s, view.serving) } }
                            right += { MachinesGlance(view.trainers, view.gpu) }
                        }
                        Section.DATA -> {
                            LaunchedEffect(Unit) { onLoadRuns() }
                            left += { CorpusCard(view.corpus) }
                            view.dataset?.let { d -> left += { DatasetCard(d, view.resight, onSetResight) } }
                            view.readiness?.let { r -> left += { CoverageCard(r, view.coverage) } }
                            right += { RunsCard(runs, view.judge, onLoadRuns, onOpenRun, onSetJudge) }
                            view.harvest?.let { h -> right += { HarvestCard(h, onSetHarvest) } }
                            view.practice?.let { p -> right += { PracticeCard(p, onSetPractice) } }
                        }
                        Section.ROUNDS -> {
                            if (view.actives.isNotEmpty() || view.pending.isNotEmpty()) left += { BatchStage(view) }
                            view.actives.filter { it.batch.isBlank() }.forEach { r -> left += { RunningCard(r) } }
                            left += { AutoCard(view, onSetAuto, onRunNow) }
                            if (view.rounds.isNotEmpty()) right += { RoundsCard2(view.rounds, onPromote) }
                            else right += { EmptyCard("No round yet", "The first one starts by itself once the data is ready and a machine is switched on.") }
                        }
                        Section.RESULTS -> {
                            left += { ResultsCard(results, onLoadResults) }
                        }
                        Section.COMPARE -> {
                            left += { CompareCard(compareOffer, compareRun, onLoadCompare, onCompareRecorded, onCompareLive, onCompareStop) }
                        }
                        Section.MODEL -> {
                            left += { ServingCard(view.serving) }
                            if (view.scopes.isNotEmpty()) left += { ModelMapCard(view.scopes, view.student, view.readiness, onSetAutopilot) }
                            view.student?.let { s -> right += { StudentCard(s, onSetServing) } }
                                ?: run { right += { EmptyCard("No model server yet", "This cluster cannot serve a trained model; update it.") } }
                            if (view.platformMap.isNotEmpty()) right += { PlatformMapCard(view.platformMap) }
                            view.students?.let { st -> left += { StudentsCard(st, onTrialStudents) } }
                        }
                        Section.MACHINES -> {
                            view.plan?.let { p -> if (p.run && p.scope.isNotBlank()) left += { NextRoundCard(p) } }
                            left += { TrainersCard(view.sizing, view.trainers, onAllowTrainer, onSetUpTrainer, view.gpu, onSetGpu, onDestroyGpu, view.nodes, onNodeJoin, onNodeRevoke, onSetModal, onModalStart, onModalStop) }
                        }
                    }
                    val scroll = rememberScrollState()
                    /* Wider than the studio's max width the page centres rather than stretches. */
                    Box(Modifier.fillMaxSize().verticalScroll(scroll), contentAlignment = Alignment.TopCenter) {
                        if (twoColumns) {
                            Row(Modifier.widthIn(max = Studio.maxContent).fillMaxWidth().padding(20.dp), horizontalArrangement = Arrangement.spacedBy(Studio.gapL)) {
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Studio.gapL)) { left.forEach { it() } }
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Studio.gapL)) { right.forEach { it() }; Spacer(Modifier.height(24.dp)) }
                            }
                        } else {
                            Column(Modifier.widthIn(max = 820.dp).fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(Studio.gapM)) {
                                left.forEach { it() }
                                right.forEach { it() }
                                Spacer(Modifier.height(32.dp))
                            }
                        }
                    }
                }
            }
        }
    }
}

/** The five questions the studio answers, in the order a person asks them. */
enum class Section(val label: String, val short: String) {
    OVERVIEW("Overview", "Now"), DATA("Data", "Data"), ROUNDS("Rounds", "Rounds"),
    /* Every measured round, whatever model trained it, set against every other. */
    RESULTS("Results", "Results"),
    /* One job, two answers: the teacher's and a model's, step by step. */
    COMPARE("Compare", "Compare"),
    MODEL("Model", "Model"), MACHINES("Machines", "Machines");
}

@Composable
private fun StudioHeader(view: TrainingWatch.View, onRefresh: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 14.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Training Studio", style = MaterialTheme.typography.headlineSmall)
            Text(TrainingWatch.headline(view), color = cs.onSurfaceVariant, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        view.active?.let {
            Surface(color = BrandSoft, shape = RoundedCornerShape(999.dp)) {
                Row(Modifier.padding(horizontal = 10.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(7.dp).clip(CircleShape).background(Brand)); Spacer(Modifier.width(6.dp))
                    Text(if (view.actives.size > 1) "training ×${view.actives.size}" else "training", color = Brand, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            Spacer(Modifier.width(6.dp))
        }
        IconButton(onClick = onRefresh) { Icon(Icons.Default.Refresh, "Refresh", tint = cs.onSurface) }
    }
    HorizontalDivider(color = cs.outline)
}

@Composable
private fun SectionTabs(current: Section, onPick: (Section) -> Unit) {
    val cs = MaterialTheme.colorScheme
    ScrollableTabRow(
        selectedTabIndex = current.ordinal, edgePadding = 12.dp, containerColor = cs.background, contentColor = cs.onSurface,
        indicator = { positions -> TabRowDefaults.SecondaryIndicator(Modifier.tabIndicatorOffset(positions[current.ordinal]), color = Brand) },
        divider = { HorizontalDivider(color = cs.outline) },
    ) {
        Section.entries.forEach { s ->
            Tab(selected = s == current, onClick = { onPick(s) },
                text = { Text(s.label, fontSize = 13.sp, fontWeight = if (s == current) FontWeight.SemiBold else FontWeight.Normal, color = if (s == current) Brand else cs.onSurfaceVariant) })
        }
    }
}

@Composable
private fun SectionRail(current: Section, onPick: (Section) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Column(Modifier.width(132.dp).fillMaxHeight().padding(top = 12.dp, start = 12.dp, end = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Section.entries.forEach { s ->
            val on = s == current
            Surface(color = if (on) BrandSoft else Color.Transparent, shape = RoundedCornerShape(10.dp),
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable(enabled = !on) { onPick(s) }) {
                Text(s.label, Modifier.padding(horizontal = 12.dp, vertical = 9.dp), color = if (on) Brand else cs.onSurfaceVariant, fontSize = 13.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium)
            }
        }
    }
}

/* ── the overview ────────────────────────────────────────────────────────────────────────────── */

/**
 * THE HERO: is the data ready, and what happens next. The score is drawn as a ring because a ring
 * is read before a number is; the six checks sit under it, gates first; the next action is the
 * planner's sentence with the one button that changes it.
 */
@Composable
private fun ReadinessHero(
    r: TrainingWatch.Readiness, plan: TrainingWatch.Plan?, dataset: TrainingWatch.Dataset?, corpus: TrainingWatch.Corpus,
    serving: TrainingWatch.Serving?, auto: Boolean, onSetAuto: (Boolean) -> Unit, onRunNow: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(18.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                ScoreRing(r.score, r.ok)
                Spacer(Modifier.width(18.dp))
                Column(Modifier.weight(1f)) {
                    Text(if (r.ok) "Ready to train" else "Collecting", style = MaterialTheme.typography.titleLarge, color = cs.onSurface)
                    Spacer(Modifier.height(4.dp))
                    Text(r.why, color = cs.onSurfaceVariant, fontSize = 12.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                }
            }
            Spacer(Modifier.height(16.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                KpiTile("SIGHTED TURNS", if (dataset != null && dataset.sightedTurns >= 0) "${dataset.sightedTurns}" else "—", Modifier.weight(1f))
                KpiTile("USABLE RUNS", "${corpus.tiers.usable}", Modifier.weight(1f))
                KpiTile("IN SERVICE", if (serving != null && serving.agreement >= 0) TrainingWatch.pct(serving.agreement) else "stock", Modifier.weight(1f))
            }
            Spacer(Modifier.height(16.dp))
            Eyebrow("CHECKS")
            Spacer(Modifier.height(6.dp))
            r.checks.sortedByDescending { it.gate }.forEach { c ->
                val tone = if (c.ok) Tone.GOOD else if (c.gate) Tone.BAD else Tone.WARN
                Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        ToneDot(tone)
                        Spacer(Modifier.width(10.dp))
                        Text(c.name, color = cs.onSurface, fontSize = 12.sp, fontWeight = FontWeight.Medium, modifier = Modifier.width(84.dp))
                        Caption(c.text, Modifier.weight(1f), maxLines = 1)
                        Spacer(Modifier.width(8.dp))
                        Figure(if (c.threshold > 0) "${c.value}/${c.threshold}" else "${c.value}", color = cs.onSurfaceVariant, size = 11)
                        if (!c.gate) { Spacer(Modifier.width(6.dp)); StatusChip("advisory", Tone.NEUTRAL) }
                    }
                    Spacer(Modifier.height(4.dp))
                    Meter(c.score / 100f, Modifier.fillMaxWidth().padding(start = 18.dp), tone = tone, height = 4.dp)
                }
            }
            if (plan != null) {
                Spacer(Modifier.height(14.dp))
                HorizontalDivider(color = cs.outline)
                Spacer(Modifier.height(12.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Eyebrow("NEXT")
                        Spacer(Modifier.height(3.dp))
                        Text(if (plan.run) "A round starts on the next tick — ${plan.why}" else plan.why, color = cs.onSurface, fontSize = 13.sp)
                    }
                    Spacer(Modifier.width(12.dp))
                    if (!auto) Button(onClick = { onSetAuto(true) }, shape = RoundedCornerShape(10.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand)) { Text("Switch on", fontSize = 12.sp) }
                    else if (!plan.run) TextButton(onClick = onRunNow) { Text("Run now", color = Brand, fontSize = 12.sp) }
                }
            }
        }
    }
}

/** The score, as an arc: filled to the weakest check, brand when every gate passes. */
@Composable
private fun ScoreRing(score: Int, ok: Boolean) {
    val cs = MaterialTheme.colorScheme
    val track = cs.surfaceVariant
    val fill = if (ok) Brand else if (score >= 60) Brand.copy(alpha = 0.75f) else cs.error
    Box(Modifier.size(88.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val stroke = 9.dp.toPx()
            val inset = stroke / 2
            val arcSize = androidx.compose.ui.geometry.Size(size.width - stroke, size.height - stroke)
            drawArc(track, startAngle = 135f, sweepAngle = 270f, useCenter = false, topLeft = Offset(inset, inset), size = arcSize, style = Stroke(stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round))
            drawArc(fill, startAngle = 135f, sweepAngle = 270f * (score.coerceIn(0, 100) / 100f), useCenter = false, topLeft = Offset(inset, inset), size = arcSize, style = Stroke(stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round))
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("$score", color = cs.onSurface, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
            Text("/100", color = cs.onSurfaceVariant, fontSize = 10.sp)
        }
    }
}

@Composable
private fun KpiTile(label: String, value: String, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surfaceVariant, shape = RoundedCornerShape(12.dp), modifier = modifier) {
        Column(Modifier.padding(12.dp)) {
            Text(label, color = cs.onSurfaceVariant, fontSize = 9.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.8.sp)
            Spacer(Modifier.height(4.dp))
            Text(value, color = cs.onSurface, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace)
        }
    }
}

/** The three loops, as three switches with one line each - the whole control surface, in one card. */
@Composable
private fun LoopsCard(view: TrainingWatch.View, onSetAuto: (Boolean) -> Unit, onSetHarvest: (Boolean) -> Unit, onSetResight: (Boolean) -> Unit, onSetJudge: (Boolean) -> Unit = {}, onSetPractice: (Boolean) -> Unit = {}) {
    val cs = MaterialTheme.colorScheme
    Card("The loops", "each runs by itself; every switch is one tap") {
        LoopRow("Training", if (view.auto) "rounds start when the data is ready and a machine is on" else "paused — nothing starts without you", view.auto, onSetAuto)
        view.harvest?.let { h ->
            HorizontalDivider(color = cs.outline); Spacer(Modifier.height(2.dp))
            LoopRow("Collecting", TrainingWatch.harvestLine(h).removePrefix("on — ").removePrefix("on, "), h.on, onSetHarvest)
        }
        view.resight?.let { r ->
            HorizontalDivider(color = cs.outline); Spacer(Modifier.height(2.dp))
            LoopRow("Re-sighting old runs", TrainingWatch.resightLine(r).removePrefix("on — ").removePrefix("off — "), r.on, onSetResight)
        }
        view.judge?.let { j ->
            HorizontalDivider(color = cs.outline); Spacer(Modifier.height(2.dp))
            LoopRow("Teacher judging steps", TrainingWatch.judgeLine(j).removePrefix("on — ").removePrefix("off — "), j.on, onSetJudge)
        }
        view.practice?.let { p ->
            HorizontalDivider(color = cs.outline); Spacer(Modifier.height(2.dp))
            LoopRow("Practising the roles", TrainingWatch.practiceLine(p).removePrefix("on — ").removePrefix("off — "), p.on, onSetPractice)
        }
    }
}

/*
 * THE RUNS BROWSER. Every recorded run as a row - grade, how much of it is sighted, judged, marked
 * by a person, the tools it used - and one tap opens it. A collector nobody can audit is a collector
 * nobody should leave on; a set nobody can read is a set nobody should train on.
 */
@Composable
private fun RunsCard(runs: List<TrainingWatch.RunRow>, judge: TrainingWatch.Judge?, onLoad: () -> Unit, onOpen: (String) -> Unit, onSetJudge: (Boolean) -> Unit) {
    val cs = MaterialTheme.colorScheme
    StudioCard("Recorded runs", "newest first — open one to read it step by step and mark a step",
        chip = { TextButton(onClick = onLoad, contentPadding = PaddingValues(horizontal = 8.dp)) { Text("Refresh", color = Brand, fontSize = 12.sp) } }) {
        if (runs.isEmpty()) { EmptyState("Nothing loaded yet", "Runs appear here as they are recorded; tap Refresh.") ; return@StudioCard }
        runs.forEach { r ->
            val tone = when (r.tier) { "gold" -> Tone.GOOD; "silver" -> Tone.NEUTRAL; "bronze" -> Tone.WARN; "void" -> Tone.BAD; else -> Tone.NEUTRAL }
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { onOpen(r.id) }.padding(vertical = 8.dp, horizontal = 4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusChip(r.grade.ifBlank { r.tier.ifBlank { r.status } }, tone)
                    Spacer(Modifier.width(8.dp))
                    Text(r.role, color = cs.onSurfaceVariant, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Caption(r.createdAt.take(16).replace('T', ' '), maxLines = 1)
                }
                Spacer(Modifier.height(3.dp))
                Text(r.goal, color = cs.onSurface, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(3.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Figure("${r.calls} calls", color = cs.onSurfaceVariant, size = 10)
                    Figure("${r.sighted} sighted", color = if (r.sighted > 0) Brand else cs.onSurfaceVariant, size = 10)
                    if (r.judged > 0) Figure("${r.judged} judged", color = cs.onSurfaceVariant, size = 10)
                    if (r.wrong > 0) Figure("${r.wrong} wrong", color = cs.error, size = 10)
                    if (r.human > 0) Figure("${r.human} by hand", color = Brand, size = 10)
                }
                if (r.tools.isNotEmpty()) Figure(r.tools.joinToString("  "), color = cs.onSurfaceVariant, size = 10)
            }
            HorizontalDivider(color = cs.outline)
        }
    }
}

/**
 * ONE RUN, READ BACK. The goal, the outcome, then every step in order: what was called, what was
 * seen after it (the page's head, folded), and every verdict on it - the record's, the teacher's
 * with its reason, and a person's. Three buttons per call: good, wrong, clear. A person's label
 * outranks the rest in the next set build; that is the whole point of this screen.
 */
@Composable
private fun RunDetailScreen(run: TrainingWatch.RunDetail, onClose: () -> Unit, onLabel: (String, Int, String) -> Unit, modifier: Modifier, topInset: Modifier) {
    val cs = MaterialTheme.colorScheme
    val tone = when (run.tier) { "gold" -> Tone.GOOD; "silver" -> Tone.NEUTRAL; "bronze" -> Tone.WARN; "void" -> Tone.BAD; else -> Tone.NEUTRAL }
    Surface(color = cs.background, contentColor = cs.onBackground, modifier = modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().then(topInset)) {
            Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onClose) { Text("‹ Runs", color = Brand, fontSize = 13.sp) }
                Spacer(Modifier.width(4.dp))
                StatusChip(run.tier.ifBlank { run.status }, tone)
                Spacer(Modifier.width(8.dp))
                Caption("${run.role} · ${run.profile} · ${run.createdAt.take(16).replace('T', ' ')}", Modifier.weight(1f), maxLines = 1)
            }
            HorizontalDivider(color = cs.outline)
            Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.TopCenter) {
                Column(Modifier.widthIn(max = 900.dp).fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(Studio.gapM)) {
                    StudioCard("Goal", "") {
                        Text(run.goal, color = cs.onSurface, fontSize = 13.sp)
                        if (run.report.isNotBlank()) { Hairline(); Eyebrow("Report"); Spacer(Modifier.height(4.dp)); Text(run.report, color = cs.onSurfaceVariant, fontSize = 12.sp) }
                        if (run.why.isNotEmpty()) { Spacer(Modifier.height(6.dp)); Caption(run.why.joinToString(" · "), maxLines = 3) }
                    }
                    var k = 0
                    run.steps.forEach { s ->
                        if (s.isCall) {
                            k++
                            val verdict = s.humanVerdict.ifBlank { s.judgedVerdict }
                            val vt = when (verdict) { "good" -> Tone.GOOD; "wrong" -> Tone.BAD; else -> Tone.NEUTRAL }
                            StudioCard("$k · ${s.tool}", s.args.take(160), chip = { if (verdict.isNotBlank()) StatusChip(if (s.humanVerdict.isNotBlank()) "$verdict · by hand" else "$verdict · teacher", vt) }) {
                                if (s.reason.isNotBlank()) { Caption("“${s.reason}”", maxLines = 3, color = cs.onSurface); Spacer(Modifier.height(6.dp)) }
                                if (s.judgedWhy.isNotBlank() && s.judgedVerdict == "wrong") { Caption("teacher: ${s.judgedWhy}", maxLines = 2, color = cs.error); Spacer(Modifier.height(6.dp)) }
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    LabelChip("good", s.humanVerdict == "good", Tone.GOOD) { onLabel(run.id, s.n, "good") }
                                    LabelChip("wrong", s.humanVerdict == "wrong", Tone.BAD) { onLabel(run.id, s.n, "wrong") }
                                    if (s.humanVerdict.isNotBlank()) LabelChip("clear", false, Tone.NEUTRAL) { onLabel(run.id, s.n, "clear") }
                                }
                            }
                        } else if (s.text.isNotBlank()) {
                            Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
                                Row(verticalAlignment = Alignment.Top) {
                                    Figure(s.kind, Modifier.width(64.dp), color = if (s.kind == "blocked" || s.kind == "error") cs.error else cs.onSurfaceVariant, size = 10)
                                    Caption(s.text + (if (s.marks > 0) "  · ${s.marks} marks" else "") + (if (s.resighted) "  · re-sighted" else ""), Modifier.weight(1f), maxLines = 3, color = cs.onSurface)
                                }
                                if (s.content.isNotBlank()) {
                                    Fold("the page it read", "${s.content.length}+ chars") {
                                        Text(s.content, color = cs.onSurfaceVariant, fontSize = 10.sp, fontFamily = FontFamily.Monospace, lineHeight = 14.sp)
                                    }
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(32.dp))
                }
            }
        }
    }
}

@Composable
private fun LabelChip(text: String, on: Boolean, tone: Tone, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    val c = toneColor(tone)
    Surface(color = if (on) c.copy(alpha = 0.18f) else cs.surfaceVariant, shape = RoundedCornerShape(8.dp), modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { onClick() }) {
        Text(text, Modifier.padding(horizontal = 12.dp, vertical = 7.dp), color = if (on) c else cs.onSurface, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun LoopRow(name: String, line: String, on: Boolean, onSet: (Boolean) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(name, color = cs.onSurface, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            Text(line, color = cs.onSurfaceVariant, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.width(10.dp))
        Switch(checked = on, onCheckedChange = onSet)
    }
}

@Composable
private fun ModelGlance(s: TrainingWatch.Student, serving: TrainingWatch.Serving?) {
    val cs = MaterialTheme.colorScheme
    Card("The model", TrainingWatch.studentLine(s)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            KpiTile("MODE", if (s.autopilot && s.map.isNotEmpty()) "autopilot" else s.mode, Modifier.weight(1f))
            KpiTile("LIVE AGREEMENT", if (s.seen > 0) TrainingWatch.pct(s.agreePct) else "—", Modifier.weight(1f))
            KpiTile("EXAM", if (serving != null && serving.agreement >= 0) TrainingWatch.pct(serving.agreement) else "—", Modifier.weight(1f))
        }
    }
}

@Composable
private fun MachinesGlance(trainers: List<TrainingWatch.Trainer>, gpu: TrainingWatch.Gpu?) {
    val cs = MaterialTheme.colorScheme
    Card("Machines", if (gpu != null) TrainingWatch.gpuLine(gpu) else "a round runs on whichever one is awake and switched on") {
        if (trainers.isEmpty()) Text("No machine has offered to train yet.", color = cs.onSurfaceVariant, fontSize = 12.sp)
        trainers.forEach { t ->
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(when { !t.online -> cs.onSurfaceVariant; t.able && t.allowed -> Brand; else -> cs.surfaceVariant }))
                Spacer(Modifier.width(9.dp))
                Text(t.name, color = cs.onSurface, fontSize = 13.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(TrainingWatch.trainerLine(t), color = cs.onSurfaceVariant, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** The set per tool, on the Data page rather than folded under the score. */
@Composable
private fun CoverageCard(r: TrainingWatch.Readiness, coverage: TrainingWatch.Coverage?) {
    val cs = MaterialTheme.colorScheme
    Card("The set per tool", if (coverage != null) "${coverage.sighted} of ${coverage.total} turns sighted — the brand share is what a round can learn from" else "") {
        if (r.aim.isNotEmpty()) {
            Eyebrow("THE COLLECTOR IS AIMING AT")
            Spacer(Modifier.height(4.dp))
            Text(r.aim.joinToString("  "), color = cs.onSurface, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
            Spacer(Modifier.height(10.dp))
        }
        if (coverage != null && coverage.perTool.isNotEmpty()) {
            val max = coverage.perTool.maxOf { it.all }.coerceAtLeast(1)
            coverage.perTool.take(24).forEach { t -> ToolBar(t, max) }
            if (coverage.perTool.size > 24) {
                Fold("Every tool", "${coverage.perTool.size - 24} more") { coverage.perTool.drop(24).forEach { t -> ToolBar(t, max) } }
            }
        }
    }
}

@Composable
private fun EmptyCard(title: String, line: String) {
    val cs = MaterialTheme.colorScheme
    Card(title, "") { Text(line, color = cs.onSurfaceVariant, fontSize = 12.sp) }
}

/**
 * COLLECTING BY ITSELF.
 *
 * The toggle is the whole control, and the rest of the card exists to answer the question a
 * toggle cannot: is it doing anything USEFUL. So it shows what it is going after — the tools the
 * set is short of — and the next prompt in its own words. A generator writing twenty variations of
 * a Google search looks identical to a good one until you can read what it chose.
 */
@Composable
private fun HarvestCard(h: TrainingWatch.Harvest, onSetHarvest: (Boolean) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Card("Collecting by itself", TrainingWatch.harvestLine(h)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    if (h.on) "one run after another, on public pages only"
                    else "a run at a time, prompts chosen from what the set is missing",
                    color = cs.onSurfaceVariant, fontSize = 12.sp,
                )
                if (h.on && h.capPerHour > 0) {
                    Spacer(Modifier.height(2.dp))
                    Text("at most ${h.capPerHour} an hour, because every run costs credit", color = cs.onSurfaceVariant, fontSize = 11.sp)
                }
            }
            Switch(checked = h.on, onCheckedChange = onSetHarvest)
        }

        if (h.collected > 0) {
            Spacer(Modifier.height(10.dp))
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("${h.collected} collected", color = cs.onSurface, fontSize = 13.sp)
                if (h.tally.isNotEmpty()) {
                    Spacer(Modifier.width(10.dp))
                    /* The grades, best first. This is the only line that says whether the loop is
                       producing anything worth training on, so it sits beside the count and not
                       three folds down. */
                    Text(h.tally.joinToString("  ") { "${it.first} ${it.second}" },
                        color = cs.onSurfaceVariant, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                }
            }
        }

        if (h.walks.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            /* What is happening RIGHT NOW: each walk, where it is, how far it got. "3 live" beside a
               switch was a number; this is a state somebody can watch. */
            Eyebrow("RUNNING NOW")
            Spacer(Modifier.height(4.dp))
            h.walks.forEach { w ->
                Column(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(7.dp).clip(CircleShape).background(Brand))
                        Spacer(Modifier.width(7.dp))
                        Text(w.profile.ifBlank { "?" }, color = cs.onSurface, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.width(8.dp))
                        Text("${w.steps} step(s)", color = cs.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                    }
                    Text(w.goal, color = cs.onSurfaceVariant, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (w.last.isNotBlank()) Text(w.last, color = cs.onSurfaceVariant, fontSize = 10.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }

        if (h.aiming.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            Eyebrow("GOING AFTER")
            Spacer(Modifier.height(4.dp))
            /* The gaps, thinnest first. A tool with no examples at all is where one run changes
               the most, and it is the sentence that explains why it picked what it picked. */
            Text(h.aiming.joinToString("  "), color = cs.onSurface, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
        }

        if (h.next.isNotBlank()) {
            Spacer(Modifier.height(10.dp))
            Eyebrow("NEXT")
            Spacer(Modifier.height(4.dp))
            Text(h.next, color = cs.onSurface, fontSize = 12.sp)
        }

        if (h.runs.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            /*
             * WHAT IT COLLECTED, newest first, folded away.
             *
             * Folded because it is forty rows and the card above it has to stay readable, and
             * present because a collector nobody can audit is a collector nobody should leave on.
             */
            Fold("What it collected", "${h.runs.size} run(s)") {
                h.runs.forEach { r -> CollectedRow(r) }
            }
        }

        if (h.stoppedBecause.isNotBlank()) {
            Spacer(Modifier.height(10.dp))
            /* It switched ITSELF off. Saying why is the difference between a bug and a decision. */
            Text(h.stoppedBecause, color = cs.error, fontSize = 12.sp)
        }
    }
}

/**
 * A SECTION THE READER OPENS.
 *
 * Compose has no disclosure widget of its own, and a modal for this would be wrong: the point is
 * to read a list against the numbers above it, which a sheet covering them defeats.
 */
@Composable
private fun Fold(title: String, sub: String = "", body: @Composable ColumnScope.() -> Unit) {
    val cs = MaterialTheme.colorScheme
    var open by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable { open = !open }.padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(if (open) Icons.Default.KeyboardArrowDown else Icons.Default.KeyboardArrowRight,
                null, tint = cs.onSurfaceVariant, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text(title, color = cs.onSurface, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            if (sub.isNotBlank()) Text(sub, color = cs.onSurfaceVariant, fontSize = 11.sp)
        }
        if (open) { Spacer(Modifier.height(6.dp)); body() }
    }
}

/** One collected prompt: what it asked for, what it graded, and what it actually used. */
@Composable
private fun CollectedRow(r: TrainingWatch.Collected) {
    val cs = MaterialTheme.colorScheme
    /* The grade is the first thing read, so it is the only thing coloured. `best` is what the
       sampler draws first; `void` contributes nothing and should look like nothing. */
    val tint = when (r.grade) {
        "best" -> Brand
        "gold", "clean" -> cs.onSurface
        "void" -> cs.onSurfaceVariant
        else -> cs.onSurfaceVariant
    }
    Column(Modifier.fillMaxWidth().padding(bottom = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(r.state.ifBlank { "?" }, color = tint, fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace)
            Spacer(Modifier.width(8.dp))
            Text(r.at.drop(11).take(5), color = cs.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            if (r.calls > 0) {
                Spacer(Modifier.width(8.dp))
                Text("${r.calls} calls", color = cs.onSurfaceVariant, fontSize = 11.sp)
            }
        }
        Spacer(Modifier.height(2.dp))
        Text(r.prompt, color = cs.onSurface, fontSize = 12.sp)
        if (r.tools.isNotEmpty()) {
            Spacer(Modifier.height(2.dp))
            Text(r.tools.joinToString("  "), color = cs.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
        }
        if (r.why.isNotBlank()) {
            Spacer(Modifier.height(2.dp))
            Text(r.why, color = cs.onSurfaceVariant, fontSize = 11.sp)
        }
    }
}

@Composable
private fun Card(title: String, sub: String = "", body: @Composable ColumnScope.() -> Unit) {
    /* Every card on this page is the studio's one card (StudioKit), so they read as one product. */
    StudioCard(title, sub, body = body)
}

@Composable
private fun Stat(label: String, value: String, valueColor: Color, modifier: Modifier = Modifier) {
    val cs = MaterialTheme.colorScheme
    Column(modifier) {
        Text(label, color = cs.onSurfaceVariant, fontSize = 9.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(3.dp))
        Text(value, color = valueColor, fontSize = 13.sp, fontFamily = FontFamily.Monospace)
    }
}

/** What is happening right now — first on the page, because it is the only thing with a clock on it. */
@Composable
private fun RunningCard(r: TrainingWatch.Round, onStop: (String) -> Unit = {}) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surface, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, Brand), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(9.dp).clip(CircleShape).background(Brand))
                Spacer(Modifier.width(9.dp))
                Text(if (r.scope.isNotBlank() && r.scope != "base") "Training now · ${TrainingWatch.scopeLabel(r.scope)}" else "Training now · base", color = cs.onSurface, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Text(r.device, color = cs.onSurfaceVariant, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (r.status == "running") { Spacer(Modifier.width(8.dp)); StopButton { onStop(r.id) } }
            }
            /* The recipe, on the card, because a round without one cannot be compared to the next. */
            if (r.recipe.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(r.recipe, color = cs.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            }
            if (r.validation.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                ValidationStrip(r)
            }
            Spacer(Modifier.height(12.dp))
            /*
             * The device's own lines, newest LAST, exactly as it reported them. A round on a CPU is
             * hours long, and a page that shows nothing for an hour is a page nobody trusts twice.
             */
            if (r.lines.isEmpty()) {
                Text("just started — no progress reported yet", color = cs.onSurfaceVariant, fontSize = 12.sp)
            } else {
                r.lines.takeLast(6).forEach { line ->
                    Text(line, color = cs.onSurfaceVariant, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                    Spacer(Modifier.height(3.dp))
                }
                if (r.lines.size > 6) {
                    Spacer(Modifier.height(4.dp))
                    /*
                     * The whole of what the device has said, folded.
                     *
                     * The cluster keeps forty of these lines and the card showed six, so the shape
                     * of a round - a loss falling, or wandering, or an adapter saved every half
                     * hour - was never visible on the surface that exists to show it.
                     */
                    Fold("Everything it has reported", "${r.lines.size} line(s)") {
                        r.lines.asReversed().forEach { line ->
                            Text(line, color = cs.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                            Spacer(Modifier.height(2.dp))
                        }
                    }
                }
            }
        }
    }
}

/**
 * IS THE DATA READY? THE SIX CHECKS, THE SCORE, AND WHAT HAPPENS NEXT.
 *
 * The one card a person reads first. The score is the weakest check, never an average, because an
 * average of five passes and one collapse is a collapse. Each check carries its own sentence - the
 * same sentence the planner refuses with - so the screen and the loop can never disagree. Under
 * it, the set per tool: sighted examples in the brand colour, blind ones in grey, because the grey
 * part cannot teach the model anything and it is the part that used to be the whole bar.
 */
@Composable
private fun StudioCard(r: TrainingWatch.Readiness, plan: TrainingWatch.Plan?, coverage: TrainingWatch.Coverage?) {
    val cs = MaterialTheme.colorScheme
    Card("Ready to train?", if (r.ok) "every gate passes" else "not yet — ${r.why}") {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("${r.score}", color = if (r.ok) Brand else cs.onSurface, fontSize = 34.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.width(6.dp))
            Text("/ 100", color = cs.onSurfaceVariant, fontSize = 13.sp)
            Spacer(Modifier.width(14.dp))
            Surface(color = if (r.ok) BrandSoft else cs.surfaceVariant, shape = RoundedCornerShape(6.dp)) {
                Text(if (r.ok) "ready" else "collecting", Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                    color = if (r.ok) Brand else cs.onSurfaceVariant, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        Spacer(Modifier.height(10.dp))
        r.checks.forEach { c ->
            Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.Top) {
                Box(Modifier.padding(top = 5.dp).size(8.dp).clip(CircleShape).background(if (c.ok) Brand else if (c.gate) cs.error else cs.onSurfaceVariant))
                Spacer(Modifier.width(9.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(c.name, color = cs.onSurface, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            if (c.threshold > 0) "${c.value} / ${c.threshold}" else "${c.value}",
                            color = cs.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                        )
                        if (!c.gate) {
                            Spacer(Modifier.width(8.dp))
                            Text("advisory", color = cs.onSurfaceVariant, fontSize = 9.sp)
                        }
                    }
                    Text(c.text, color = cs.onSurfaceVariant, fontSize = 11.sp)
                }
                Text("${c.score}", color = cs.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            }
        }
        if (plan != null) {
            Spacer(Modifier.height(10.dp))
            HorizontalDivider(color = cs.outline)
            Spacer(Modifier.height(8.dp))
            Eyebrow("NEXT")
            Spacer(Modifier.height(3.dp))
            Text(if (plan.run) "a round starts on the next tick — ${plan.why}" else plan.why, color = cs.onSurface, fontSize = 12.sp)
        }
        if (r.aim.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            Eyebrow("THE COLLECTOR IS AIMING AT")
            Spacer(Modifier.height(3.dp))
            Text(r.aim.joinToString("  "), color = cs.onSurface, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
        }
        if (coverage != null && coverage.perTool.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            Fold("The set per tool", "${coverage.sighted} of ${coverage.total} turns sighted") {
                val max = coverage.perTool.maxOf { it.all }.coerceAtLeast(1)
                coverage.perTool.forEach { t -> ToolBar(t, max) }
            }
        }
    }
}

/** One tool: sighted turns in the brand colour, blind ones grey, the counts beside it. */
@Composable
private fun ToolBar(t: TrainingWatch.ToolRow, max: Int) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(t.tool, color = cs.onSurface, fontSize = 11.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.width(120.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Box(Modifier.weight(1f).height(8.dp).clip(RoundedCornerShape(4.dp)).background(cs.surfaceVariant)) {
            val sightedShare = t.sighted.toFloat() / max
            val blindShare = (t.all - t.sighted).toFloat() / max
            Row(Modifier.fillMaxSize()) {
                if (sightedShare > 0f) Box(Modifier.fillMaxHeight().fillMaxWidth(sightedShare.coerceIn(0f, 1f)).background(Brand))
                if (blindShare > 0f) Box(Modifier.fillMaxHeight().fillMaxWidth((blindShare / (1f - sightedShare).coerceAtLeast(0.001f)).coerceIn(0f, 1f)).background(cs.onSurfaceVariant.copy(alpha = 0.35f)))
            }
        }
        Spacer(Modifier.width(8.dp))
        Text("${t.sighted} / ${t.all}", color = cs.onSurfaceVariant, fontSize = 10.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.width(88.dp))
    }
}

/**
 * THE MODEL WE TRAINED, AT WORK - OR WATCHING.
 *
 * Four modes in the order a model earns them: off, shadow (the teacher drives, the student answers
 * beside it and is scored), canary (the student drives a share of the jobs with the teacher as the
 * fallback), primary. The live ledger under it is the exam that matters: agreement per tool on real
 * jobs, and how often a driving student had to be handed back.
 */
@Composable
private fun StudentCard(s: TrainingWatch.Student, onSetServing: (String?, String?) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Card("The trained model at work", TrainingWatch.studentLine(s)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("off", "shadow", "canary", "primary").forEach { m ->
                val on = s.mode == m
                val can = m == "off" || (s.hasModel && s.reachable != false)
                Surface(
                    color = if (on) BrandSoft else cs.surfaceVariant, shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable(enabled = can && !on) { onSetServing(m, null) },
                ) {
                    Text(m, Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                        color = if (on) Brand else if (can) cs.onSurface else cs.onSurfaceVariant, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        if (s.models.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            Eyebrow("MODELS ON THE SERVER")
            Spacer(Modifier.height(4.dp))
            s.models.forEach { m ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).clickable(enabled = m != s.model) { onSetServing(null, m) }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(7.dp).clip(CircleShape).background(if (m == s.model) Brand else cs.outline))
                    Spacer(Modifier.width(8.dp))
                    Text(m, color = cs.onSurface, fontSize = 12.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                    if (m == s.model) Text("chosen", color = Brand, fontSize = 10.sp) else Text("use", color = cs.onSurfaceVariant, fontSize = 10.sp)
                }
            }
        }
        if (s.seen > 0) {
            Spacer(Modifier.height(10.dp))
            HorizontalDivider(color = cs.outline)
            Spacer(Modifier.height(10.dp))
            Row {
                Stat("STEPS SCORED", "${s.seen}", cs.onSurface, Modifier.weight(1f))
                Stat("SAME TOOL", TrainingWatch.pct(s.agreePct), Brand, Modifier.weight(1f))
                Stat("SAME ARGS TOO", TrainingWatch.pct(s.argsPct), cs.onSurface, Modifier.weight(1f))
                Stat("NO ANSWER", TrainingWatch.pct(s.unusablePct), cs.onSurfaceVariant, Modifier.weight(1f))
            }
            if (s.perTool.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Fold("Per tool, on real jobs", "${s.perTool.size} tool(s)") {
                    s.perTool.forEach { t ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                            Text(t.name, color = cs.onSurface, fontSize = 11.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
                            Text("${t.agree} / ${t.seen}  ${TrainingWatch.pct(t.pct)}", color = cs.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                        }
                    }
                }
            }
            if (s.recent.isNotEmpty()) {
                Fold("What it said, step by step", "last ${s.recent.size}") {
                    s.recent.forEach { r ->
                        Column(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                            Text("teacher  ${r.teacher}", color = cs.onSurfaceVariant, fontSize = 10.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("student  ${r.student}", color = if (r.agree) Brand else cs.error, fontSize = 10.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
        if (s.drivenSteps > 0) {
            Spacer(Modifier.height(8.dp))
            Text("${s.drivenSteps} step(s) driven across ${s.drivenJobs} job(s) — ${TrainingWatch.pct(s.fallbackPct)} handed back to the teacher",
                color = cs.onSurfaceVariant, fontSize = 11.sp)
        }
    }
}

/**
 * THE VALIDATION CURVE, DRAWN.
 *
 * A held-out loss per check, over the turns seen. Falling means it is still learning; flat or
 * rising means the round is coasting and the best checkpoint is already behind it. This is the one
 * picture that says whether the hours still running are worth running, and it is drawn rather than
 * listed because a shape is read in a glance and a column of numbers is not.
 */
@Composable
private fun ValidationStrip(r: TrainingWatch.Round) {
    val cs = MaterialTheme.colorScheme
    val pts = r.validation
    val lo = pts.minOf { it.second }
    val hi = pts.maxOf { it.second }
    val last = pts.last()
    val bestIdx = pts.indexOfFirst { it.second == lo }
    val muted = cs.onSurfaceVariant
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Validation loss", color = cs.onSurfaceVariant, fontSize = 11.sp, modifier = Modifier.weight(1f))
            Text(
                "${TrainingWatch.loss(last.second)} now · best ${TrainingWatch.loss(lo)} at ${pts[bestIdx].first} turns",
                color = cs.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
            )
        }
        Spacer(Modifier.height(4.dp))
        Canvas(Modifier.fillMaxWidth().height(56.dp)) {
            val w = size.width
            val h = size.height
            val pad = 4f
            val span = (hi - lo).let { if (it < 1e-6) 1.0 else it }
            val n = pts.size
            fun x(i: Int) = if (n == 1) w / 2 else pad + (w - 2 * pad) * i / (n - 1)
            fun y(v: Double) = (pad + (h - 2 * pad) * ((v - lo) / span)).toFloat()
            /* A faint floor line at the best value, so "how far above the best" is visible. */
            drawLine(muted.copy(alpha = 0.25f), Offset(0f, y(lo)), Offset(w, y(lo)), strokeWidth = 1f)
            if (n > 1) {
                val path = Path()
                pts.forEachIndexed { i, p ->
                    if (i == 0) path.moveTo(x(i), y(p.second)) else path.lineTo(x(i), y(p.second))
                }
                drawPath(path, Brand, style = Stroke(width = 2.5f))
            }
            pts.forEachIndexed { i, p ->
                drawCircle(if (i == bestIdx) Brand else muted, radius = if (i == bestIdx) 5f else 3f, center = Offset(x(i), y(p.second)))
            }
        }
    }
}

/**
 * THE SWITCH, AND THE ONE BUTTON THAT OVERRIDES THE WAITING.
 *
 * Automatic is the normal state — a loop that has to be started by hand is not a loop. The switch
 * exists because a machine that grinds all night when you need it for something else is a machine
 * you unplug, and unplugging it is a worse outcome than pausing it.
 */
@Composable
private fun AutoCard(v: TrainingWatch.View, onSetAuto: (Boolean) -> Unit, onRunNow: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Card("Training by itself", if (v.auto) "rounds start on their own when there is something to learn" else "paused — nothing will start without you") {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(if (v.auto) "On" else "Off", color = if (v.auto) Brand else cs.onSurfaceVariant, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                /* Learned = kept by an adapter that passed the gates. Attempted = trained on and thrown away. */
                Text(
                    if (v.covered > 0) "${v.covered} turns learned" + (if (v.attempted > v.covered) " · ${v.attempted - v.covered} more trained on by rounds that were not kept" else "")
                    else if (v.attempted > 0) "0 turns learned — ${v.attempted} trained on by rounds that did not pass the gates"
                    else "nothing learned yet",
                    color = cs.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            }
            Switch(checked = v.auto, onCheckedChange = onSetAuto)
        }
        Spacer(Modifier.height(8.dp))
        /* Forcing skips the reasons to WAIT, never the reasons it cannot run. */
        TextButton(onClick = onRunNow, enabled = v.active == null) {
            Text(if (v.active == null) "Run a round now" else "a round is already running", color = if (v.active == null) Brand else cs.onSurfaceVariant, fontSize = 12.sp)
        }
    }
}

@Composable
private fun CorpusCard(c: TrainingWatch.Corpus) {
    val cs = MaterialTheme.colorScheme
    Card("Data collected", "${c.jobs} recorded runs, judged against what actually happened") {
        Row {
            /* Gold means something OUTSIDE the run's own report agreed the work happened. Silver is
               the run's own word for it. The distinction is the whole reason the set is worth
               anything, so it is shown rather than summed away. */
            Stat("GOLD", "${c.tiers.gold}", Brand, Modifier.weight(1f))
            Stat("SILVER", "${c.tiers.silver}", cs.onSurface, Modifier.weight(1f))
            Stat("BRONZE", "${c.tiers.bronze}", cs.onSurface, Modifier.weight(1f))
            Stat("SET ASIDE", "${c.tiers.void}", cs.onSurfaceVariant, Modifier.weight(1f))
        }
        Spacer(Modifier.height(12.dp))
        HorizontalDivider(color = cs.outline)
        Spacer(Modifier.height(12.dp))
        Text(TrainingWatch.readiness(c), color = if (c.enoughForARound && !c.scanning) Brand else cs.onSurfaceVariant, fontSize = 12.sp)
        if (c.unjudged > 0) {
            Spacer(Modifier.height(4.dp))
            Text("${c.unjudged} run(s) not judged — usually still going", color = cs.onSurfaceVariant, fontSize = 11.sp)
        }
    }
}

@Composable
private fun DatasetCard(d: TrainingWatch.Dataset, resight: TrainingWatch.Resight?, onSetResight: (Boolean) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Card("The set that is ready", if (d.builtAt.isNotBlank()) "built ${d.builtAt.take(16).replace('T', ' ')}" else "") {
        Row {
            Stat("TO TRAIN ON", "${d.trainTurns}", cs.onSurface, Modifier.weight(1f))
            Stat("TO SCORE ON", "${d.evalTurns}", cs.onSurface, Modifier.weight(1f))
            Stat("WHAT NOT TO DO", "${d.rejectTurns}", cs.onSurface, Modifier.weight(1f))
        }
        /*
         * THE NUMBER NOBODY WOULD THINK TO ASK FOR.
         *
         * A turn whose answer is "click element 13" can only be learnt if the numbered list that 13
         * came from was recorded. It was not, until recently — so these turns currently teach the
         * model to GUESS an index, which is the exact mistake the fine-tune exists to remove. It
         * heals as fresh runs land, and until it does the page says so plainly.
         */
        /*
         * THE GATE A ROUND WAITS ON. A turn can only teach "open this url" or "finish now" if the
         * page it decided on was recorded with it. Two rounds trained on a set where it was not,
         * and both collapsed. This is the count the planner compares to a slice before it starts
         * anything, so it belongs on the card that says the set is ready.
         */
        if (d.sightedTurns >= 0 && d.trainTurns > 0) {
            Spacer(Modifier.height(12.dp))
            HorizontalDivider(color = cs.outline)
            Spacer(Modifier.height(12.dp))
            val share = (100.0 * d.sightedTurns / d.trainTurns).let { kotlin.math.round(it * 10) / 10.0 }
            Text(
                "${d.sightedTurns} of ${d.trainTurns} turns can see the page they decide on ($share%)" +
                    if (d.sightedTurns == 0) " — nothing sighted yet, keep collecting" else "",
                color = if (d.sightedTurns == 0) cs.error else cs.onSurfaceVariant, fontSize = 11.sp,
            )
        }
        /*
         * THE WAY TO RAISE THAT NUMBER WITHOUT SPENDING A MODEL CALL. The old runs read pages whose
         * addresses are in the record; re-opening them today gives those decisions their page back.
         * Accepted only when the page is the same size on the same site; the rest stay blind.
         */
        if (resight != null) {
            Spacer(Modifier.height(10.dp))
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Give the old runs their pages back", color = cs.onSurface, fontSize = 13.sp)
                    Text(TrainingWatch.resightLine(resight), color = cs.onSurfaceVariant, fontSize = 11.sp)
                }
                Spacer(Modifier.width(8.dp))
                Switch(checked = resight.on, onCheckedChange = onSetResight)
            }
        }
        if (d.indexTurns > 0) {
            Spacer(Modifier.height(12.dp))
            HorizontalDivider(color = cs.outline)
            Spacer(Modifier.height(12.dp))
            val ok = d.indexLearnable
            Text(
                "$ok of ${d.indexTurns} turns that click or type can actually be learnt" +
                    if (ok == 0) " — the numbered list was not recorded yet" else "",
                color = if (ok == 0) cs.error else cs.onSurfaceVariant, fontSize = 11.sp,
            )
        }
        if (d.dropped.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            Text("THROWN AWAY", color = cs.onSurfaceVariant, fontSize = 9.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            d.dropped.take(4).forEach { (why, n) ->
                Row(Modifier.fillMaxWidth()) {
                    Text(why, color = cs.onSurfaceVariant, fontSize = 11.sp, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text("$n", color = cs.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                }
                Spacer(Modifier.height(2.dp))
            }
        }
    }
}

@Composable
private fun ServingCard(s: TrainingWatch.Serving?) {
    val cs = MaterialTheme.colorScheme
    Card("In service", "the model answering right now") {
        if (s == null) {
            Text("Nothing promoted yet — the stock model is answering.", color = cs.onSurfaceVariant, fontSize = 12.sp)
            return@Card
        }
        Row {
            Stat("AGREEMENT", TrainingWatch.pct(s.agreement), Brand, Modifier.weight(1f))
            /* What it beat travels with it, so deciding to roll back needs nothing else on screen. */
            Stat("BEAT", TrainingWatch.pct(s.beat), cs.onSurfaceVariant, Modifier.weight(1f))
            Stat("TRAINED ON", s.device.ifBlank { "—" }, cs.onSurface, Modifier.weight(1f))
        }
        if (s.adapter.isNotBlank()) {
            Spacer(Modifier.height(8.dp))
            Text(s.adapter, color = cs.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun TrainersCard(
    sizing: TrainingWatch.Sizing?,
    trainers: List<TrainingWatch.Trainer>,
    onAllow: (String, Boolean) -> Unit,
    onSetUp: (String) -> Unit,
    gpu: TrainingWatch.Gpu? = null,
    onSetGpu: (Map<String, String>) -> Unit = {},
    onDestroyGpu: () -> Unit = {},
    nodes: TrainingWatch.Nodes? = null,
    onNodeJoin: (String) -> Unit = {},
    onNodeRevoke: (String) -> Unit = {},
    onSetModal: (Map<String, String>) -> Unit = {},
    onModalStart: () -> Unit = {},
    onModalStop: () -> Unit = {},
) {
    val cs = MaterialTheme.colorScheme
    /* WHICH KIND OF MACHINE the page is about: the laptops, a Modal node the hub starts itself, a Colab
       session by a pasted line, Kaggle by its API, or a rented card. The tab is a view; only the rented
       card changes where rounds run (trainOn) - nodes are machines like laptops. */
    var tab by remember(gpu?.trainOn) { mutableStateOf(if (gpu?.trainOn == "gpu") "gpu" else "laptop") }
    Card("Machines", if (gpu != null) TrainingWatch.gpuLine(gpu) else "a round runs on whichever one is awake and switched on") {
        /*
         * WHERE ROUNDS RUN - one flow, chosen here, never guessed. The laptops that offered, or a
         * card rented per round (twenty minutes and about a euro) and destroyed the moment the round
         * has reported. The key stays on the server; the screen only knows it is set.
         */
        if (gpu != null) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("laptop" to "Laptop", "modal" to "Modal", "colab" to "Colab", "kaggle" to "Kaggle", "gpu" to "GPU (rented)").forEach { (m, label) ->
                    val on = tab == m
                    val dot = when (m) { "modal" -> nodes?.modal?.online == true; "colab" -> nodes?.joins?.any { it.kind == "colab" && it.online } == true; "kaggle" -> nodes?.joins?.any { it.kind == "kaggle" && it.online } == true; else -> false }
                    Surface(color = if (on) BrandSoft else cs.surfaceVariant, shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable(enabled = !on) {
                            tab = m
                            if (m == "gpu" && gpu.trainOn != "gpu") onSetGpu(mapOf("trainOn" to "gpu"))
                            if (m != "gpu" && gpu.trainOn == "gpu") onSetGpu(mapOf("trainOn" to "laptop"))
                        }) {
                        Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            if (dot) { Box(Modifier.size(6.dp).clip(CircleShape).background(Brand)); Spacer(Modifier.width(6.dp)) }
                            Text(label, color = if (on) Brand else cs.onSurface, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
            if (tab == "modal") { Spacer(Modifier.height(10.dp)); ModalPanel(nodes, onSetModal, onModalStart, onModalStop, onNodeRevoke) }
            if (tab == "colab") { Spacer(Modifier.height(10.dp)); PastePanel("colab", nodes, onNodeJoin, onNodeRevoke) }
            if (tab == "kaggle") { Spacer(Modifier.height(10.dp)); PastePanel("kaggle", nodes, onNodeJoin, onNodeRevoke) }
            if (tab == "laptop") {
                /*
                 * HOW LONG A LAPTOP ROUND MAY RUN. Three hours proves the whole chain the same
                 * afternoon on ~200 sighted turns; twelve is a night; the slice follows the hours,
                 * so a short round is a small honest round, not a cut-off long one.
                 */
                Spacer(Modifier.height(10.dp))
                Eyebrow("ROUND LENGTH")
                Spacer(Modifier.height(4.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(3, 6, 12, 24).forEach { h ->
                        val on = gpu.trainHours == h
                        Surface(color = if (on) BrandSoft else cs.surfaceVariant, shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable(enabled = !on) { onSetGpu(mapOf("trainHours" to h.toString())) }) {
                            Text("$h h", Modifier.padding(horizontal = 12.dp, vertical = 6.dp), color = if (on) Brand else cs.onSurface, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
                /*
                 * HOW THE MACHINES ARE USED. Every connected laptop works on one batch of one scope
                 * and the adapters are averaged at the end; the choice is only what the round length
                 * means: the batch's hours split over the machines, or the full hours on each.
                 */
                Spacer(Modifier.height(10.dp))
                Eyebrow("HOW THE MACHINES ARE USED")
                Spacer(Modifier.height(4.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("time" to "Split the time", "work" to "Double the work").forEach { (m, label) ->
                        val on = gpu.trainShare == m
                        Surface(color = if (on) BrandSoft else cs.surfaceVariant, shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable(enabled = !on) { onSetGpu(mapOf("trainShare" to m)) }) {
                            Text(label, Modifier.padding(horizontal = 12.dp, vertical = 6.dp), color = if (on) Brand else cs.onSurface, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
                Spacer(Modifier.height(4.dp))
                val n = maxOf(1, gpu.machines)
                /* The hub cuts the batch to the hours at three epochs from the machines' measured speed (sizing);
                   an older hub without it is read the old way. */
                val sz = sizing
                val batchTurns = sz?.batchTurns?.takeIf { it > 0 } ?: maxOf(120, (if (gpu.trainShare == "work") gpu.trainHours * n else gpu.trainHours) * 40 / 3)
                val turnsEach = sz?.turnsEach?.takeIf { it > 0 } ?: (batchTurns / n)
                val each = sz?.hoursEach?.takeIf { it > 0 } ?: (if (gpu.trainShare == "work") gpu.trainHours.toDouble() else gpu.trainHours.toDouble() / n)
                val eachText = if (each == each.toLong().toDouble()) "${each.toLong()}" else "${kotlin.math.round(each * 10) / 10}"
                val speed = sz?.let { " Cut for ${it.secPerTurn.toInt()} s a turn at ${it.epochs} epochs — the epochs never give, the turns do." } ?: ""
                Text(
                    if (n > 1) "$n machines on one batch of $batchTurns sighted turns: $eachText h and $turnsEach turns each on its own share, then the adapters are averaged and examined once. Base first, always.$speed"
                    else "one machine: a ${gpu.trainHours} h round of $batchTurns sighted turns; a second laptop joins the same batch when it connects. The exam takes about an hour at each end on a CPU.$speed",
                    color = cs.onSurfaceVariant, fontSize = 11.sp, lineHeight = 15.sp,
                )
            }
            if (gpu.trainOn == "gpu") {
                Spacer(Modifier.height(10.dp))
                var key by remember { mutableStateOf("") }
                var hours by remember(gpu.maxHours) { mutableStateOf(TrainingWatch.trimPublic(gpu.maxHours)) }
                OutlinedTextField(key, { key = it }, label = { Text(if (gpu.keySet) "RunPod API key (set, ${gpu.keyHint} — enter to replace)" else "RunPod API key") },
                    singleLine = true, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), visualTransformation = PasswordVisualTransformation())
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(hours, { hours = it }, label = { Text("Hard stop, hours") }, singleLine = true, modifier = Modifier.width(150.dp), shape = RoundedCornerShape(10.dp))
                    Spacer(Modifier.width(10.dp))
                    Button(onClick = {
                        val f = mutableMapOf<String, String>()
                        if (key.isNotBlank()) f["key"] = key.trim()
                        hours.trim().toDoubleOrNull()?.let { f["maxHours"] = it.toString() }
                        if (f.isNotEmpty()) onSetGpu(f); key = ""
                    }, shape = RoundedCornerShape(10.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand)) { Text("Save", fontSize = 12.sp) }
                }
                if (gpu.types.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    Eyebrow("CARD")
                    Spacer(Modifier.height(4.dp))
                    gpu.types.forEach { t ->
                        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).clickable(enabled = t != gpu.gpuType) { onSetGpu(mapOf("gpuType" to t)) }.padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(7.dp).clip(CircleShape).background(if (t == gpu.gpuType) Brand else cs.outline))
                            Spacer(Modifier.width(8.dp))
                            Text(t, color = cs.onSurface, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                        }
                    }
                }
                val pod = gpu.pod
                if (pod != null) {
                    Spacer(Modifier.height(8.dp))
                    HorizontalDivider(color = cs.outline)
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(9.dp).clip(CircleShape).background(Brand))
                        Spacer(Modifier.width(9.dp))
                        Text("Renting ${pod.gpuType} · ${pod.id}", color = cs.onSurface, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        TextButton(onClick = onDestroyGpu) { Text("Destroy now", color = cs.error, fontSize = 12.sp) }
                    }
                    pod.notes.takeLast(6).forEach { n -> Text(n, color = cs.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
                val last = gpu.last
                if (pod == null && last != null) {
                    Spacer(Modifier.height(6.dp))
                    Text("last rental: ${last.gpuType} · ${last.why}", color = cs.onSurfaceVariant, fontSize = 11.sp)
                }
            }
            Spacer(Modifier.height(10.dp))
            HorizontalDivider(color = cs.outline)
            Spacer(Modifier.height(6.dp))
        }
        if (trainers.isEmpty()) {
            Text("No machine has offered to train yet. Open Ghost Browser on a laptop and it will appear here.",
                color = cs.onSurfaceVariant, fontSize = 12.sp)
            return@Card
        }
        trainers.forEach { t ->
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(
                    when { !t.online -> cs.onSurfaceVariant; t.able && t.allowed -> Brand; else -> cs.surfaceVariant }))
                Spacer(Modifier.width(9.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(t.name, color = cs.onSurface, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (t.gpu.isNotBlank()) { Spacer(Modifier.width(6.dp)); StatusChip(t.gpu, Tone.GOOD) }
                        else if (t.node.isNotBlank()) { Spacer(Modifier.width(6.dp)); StatusChip(t.node, Tone.NEUTRAL) }
                    }
                    /*
                     * Why it is or is not going to be given work. A machine that merely never gets
                     * picked teaches nobody anything; "needs 6 GB on D:" is a minute's work.
                     */
                    Text(TrainingWatch.trainerLine(t), color = if (t.missing.isNotEmpty() && t.online) cs.error else cs.onSurfaceVariant,
                        fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    val line = TrainingWatch.deviceLine(t.round)
                    if (line.isNotBlank()) {
                        Text(line, color = if (t.round?.stale == true) cs.error else cs.onSurfaceVariant, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
                when {
                    /* Able: the owner decides. Not able but could be: offer to make it able. */
                    t.able -> Switch(checked = t.allowed, onCheckedChange = { on -> onAllow(t.deviceId, on) })
                    t.canSetUp && t.online -> TextButton(onClick = { onSetUp(t.deviceId) }) {
                        Text("Set up", color = Brand, fontSize = 12.sp)
                    }
                    else -> {}
                }
            }
            HorizontalDivider(color = cs.outline)
        }
    }
}

@Composable
private fun RoundsCard(rounds: List<TrainingWatch.Round>, onPromote: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Card("Every round", "the ones that lost are kept too — they are how you know the gate works") {
        rounds.forEach { r ->
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(r.device.ifBlank { "unknown" }, color = cs.onSurface, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Spacer(Modifier.width(8.dp))
                        val tag = when {
                            r.promoted -> "in service"
                            r.status == "running" -> "running"
                            r.won -> "won, not promoted"
                            r.status == "done" -> "did not beat it"
                            else -> r.status
                        }
                        Surface(color = if (r.promoted || r.status == "running") BrandSoft else cs.surfaceVariant, shape = RoundedCornerShape(6.dp)) {
                            Text(tag, Modifier.padding(horizontal = 7.dp, vertical = 2.dp), color = if (r.promoted || r.status == "running") Brand else cs.onSurfaceVariant, fontSize = 9.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                    Spacer(Modifier.height(2.dp))
                    Text(
                        "${r.turns} turns · ${TrainingWatch.pct(r.baseline)} → ${TrainingWatch.pct(r.result)}" +
                            (if (r.bestValLoss >= 0) " · val ${TrainingWatch.loss(r.bestValLoss)}" else ""),
                        color = cs.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                    )
                    /* The recipe beside the score: without it two rounds cannot be compared at all. */
                    if (r.recipe.isNotBlank()) {
                        Text(r.recipe, color = cs.onSurfaceVariant, fontSize = 10.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                /* Offered only where it could succeed. The cluster refuses a round that did not beat
                   its baseline, so this button can never be the way a worse model reaches service. */
                if (r.won && !r.promoted && r.status == "done") {
                    TextButton(onClick = { onPromote(r.id) }) { Text("Use it", color = Brand, fontSize = 12.sp) }
                }
            }
            HorizontalDivider(color = cs.outline)
        }
    }
}

/*
 * EVERY ROUND, AS A LEDGER.
 *
 * One row per round: the state as a chip whose tone says the thing (won / lost / collapsed /
 * failed / in service), the exam before and after with the argument agreement beside it, the
 * validation loss the round ended on, and the recipe in one line - because a score without its
 * recipe cannot be compared to the next. The collapse ratio is shown only when it bites: a round
 * that beat its baseline by answering one thing to everything is the mistake this page exists to
 * make visible. Under the list, the last two finished rounds side by side.
 */
@Composable
private fun RoundsCard2(rounds: List<TrainingWatch.Round>, onPromote: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val finished = rounds.filter { it.status == "done" && it.result >= 0 }
    StudioCard("Every round", "the ones that lost are kept too — they are how you know the gate works",
        chip = { StatusChip("${rounds.size} round(s)", Tone.NEUTRAL) }) {
        rounds.forEach { r ->
            val (label, tone) = when {
                r.promoted -> "in service" to Tone.GOOD
                r.status == "running" -> "running" to Tone.GOOD
                r.status == "failed" -> "failed" to Tone.BAD
                r.status == "done" && r.collapsed -> "collapsed" to Tone.BAD
                r.won -> "won" to Tone.GOOD
                r.status == "done" -> "did not beat it" to Tone.WARN
                else -> r.status to Tone.NEUTRAL
            }
            Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusChip(label, tone)
                    /* What it trained - a platform or a role - beside how it did. Base says nothing: it is the default. */
                    if (r.scope.isNotBlank() && r.scope != "base") { Spacer(Modifier.width(6.dp)); StatusChip(TrainingWatch.scopeLabel(r.scope), Tone.NEUTRAL) }
                    if (r.merge) { Spacer(Modifier.width(6.dp)); StatusChip("merged", Tone.GOOD) }
                    else if (r.batch.isNotBlank() && r.share > 1) { Spacer(Modifier.width(6.dp)); StatusChip("share of ${r.share}", Tone.NEUTRAL) }
                    Spacer(Modifier.width(8.dp))
                    Text(r.device.ifBlank { "unknown" }, color = cs.onSurface, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Caption(r.startedAt.take(16).replace('T', ' '), maxLines = 1)
                    if (r.won && !r.promoted && r.status == "done" && !r.collapsed) {
                        Spacer(Modifier.width(6.dp))
                        TextButton(onClick = { onPromote(r.id) }, contentPadding = PaddingValues(horizontal = 8.dp)) { Text("Use it", color = Brand, fontSize = 12.sp) }
                    }
                }
                Spacer(Modifier.height(6.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Mini("exam", if (r.baseline >= 0 || r.result >= 0) "${TrainingWatch.pct(r.baseline)} → ${TrainingWatch.pct(r.result)}" else "—", if (r.won) Tone.GOOD else Tone.NEUTRAL)
                    if (r.args >= 0) Mini("with args", "${TrainingWatch.pct(r.baselineArgs)} → ${TrainingWatch.pct(r.args)}", Tone.NEUTRAL)
                    Mini("turns", "${r.trainedOrTurns()}", Tone.NEUTRAL)
                    if (r.bestValLoss >= 0) Mini("val loss", TrainingWatch.loss(r.bestValLoss), Tone.NEUTRAL)
                    if (r.collapse >= 0) Mini("collapse", "${TrainingWatch.trimPublic(r.collapse)}× ${r.collapseTool}", if (r.collapsed) Tone.BAD else Tone.GOOD)
                }
                if (r.recipe.isNotBlank()) { Spacer(Modifier.height(4.dp)); Figure(r.recipe, color = cs.onSurfaceVariant, size = 10) }
                if (r.why.isNotBlank() && r.status != "running") { Spacer(Modifier.height(2.dp)); Caption(r.why, maxLines = 2) }
            }
            HorizontalDivider(color = cs.outline)
        }
        if (finished.size >= 2) {
            Spacer(Modifier.height(Studio.gapM))
            Fold("Compare the last two", "${finished[0].device} against ${finished[1].device}") {
                val a = finished[0]; val b = finished[1]
                CompareRow("exam", TrainingWatch.pct(a.result), TrainingWatch.pct(b.result))
                CompareRow("with args", TrainingWatch.pct(a.args), TrainingWatch.pct(b.args))
                CompareRow("collapse", if (a.collapse >= 0) "${TrainingWatch.trimPublic(a.collapse)}×" else "—", if (b.collapse >= 0) "${TrainingWatch.trimPublic(b.collapse)}×" else "—")
                CompareRow("val loss", TrainingWatch.loss(a.bestValLoss), TrainingWatch.loss(b.bestValLoss))
                CompareRow("turns trained", "${a.trainedOrTurns()}", "${b.trainedOrTurns()}")
                CompareRow("no answer", TrainingWatch.pct(a.unusable), TrainingWatch.pct(b.unusable))
                CompareRow("recipe", a.recipe.ifBlank { "—" }, b.recipe.ifBlank { "—" })
                if (a.perTool.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    Eyebrow("Per tool, newest round")
                    Spacer(Modifier.height(4.dp))
                    a.perTool.take(12).forEach { t ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                            Figure(t.name, Modifier.width(120.dp), color = cs.onSurface, size = 11)
                            Meter(t.pct.toFloat() / 100f, Modifier.weight(1f), tone = if (t.pct >= 50) Tone.GOOD else Tone.WARN)
                            Spacer(Modifier.width(8.dp))
                            Figure("${t.agree}/${t.seen}", color = cs.onSurfaceVariant, size = 10)
                        }
                    }
                }
            }
        }
    }
}

/*
 * THE MODEL MAP. One row per scope of weights - base, each platform, the roles with the most data -
 * with what the set holds for it, how much of that its rounds have seen, and what serves for it:
 * nothing yet, an adapter promoted but not exported, or a served model and the stage it has earned.
 * Autopilot is the one switch: on, the most specific model that earned its stage answers; off, the
 * mode on the serving card applies to the most specific model there is.
 */
@Composable
private fun ModelMapCard(scopes: List<TrainingWatch.Scope>, student: TrainingWatch.Student?, readiness: TrainingWatch.Readiness?, onSetAutopilot: (Boolean) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val slice = readiness?.checks?.firstOrNull { it.name == "sight" }?.threshold?.takeIf { it > 0 } ?: 120
    val base = scopes.filter { it.level == "base" }
    val platforms = scopes.filter { it.level == "platform" }.sortedByDescending { it.sighted }
    val roles = scopes.filter { it.level == "role" }.sortedByDescending { it.sighted }
    val rolesOn = { platform: String -> roles.filter { (it.platform.ifBlank { "web" }) == platform } }
    val served = scopes.count { it.model.isNotBlank() }
    /*
     * THE WHOLE TREE, on the surface: base, then every platform with every role under it, each
     * with its sighted turns, its paper, how much its rounds have seen, what serves for it and
     * what it chains from. The roles fold under their platform so the page stays readable, but
     * nothing is left off it.
     */
    StudioCard("The model map", "one adapter per platform and per role, each chained from the one above it — ${platforms.size} platform(s), ${roles.size} role(s)",
        chip = { StatusChip(if (served > 0) "$served served" else "nothing served yet", if (served > 0) Tone.GOOD else Tone.NEUTRAL) }) {
        student?.let { s ->
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Autopilot", color = cs.onSurface, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    Caption(if (s.autopilot) "the most specific model that earned its stage answers — shadow, canary, primary on the ledger, and back down on the same numbers"
                        else "off — the mode on the serving card applies to the most specific model there is")
                }
                Spacer(Modifier.width(10.dp))
                Switch(checked = s.autopilot, onCheckedChange = onSetAutopilot)
            }
            Hairline()
        }
        base.forEach { sc ->
            ScopeRow(sc, slice)
            val webRoles = rolesOn("web")
            if (webRoles.isNotEmpty()) Fold("${webRoles.size} role(s) on the open web", "they train with base until one holds $slice sighted turns") {
                webRoles.forEach { r -> Box(Modifier.padding(start = 14.dp)) { ScopeRow(r, slice) } }
            }
        }
        platforms.forEach { sc ->
            Hairline()
            ScopeRow(sc, slice)
            val mine = rolesOn(sc.name)
            if (mine.isNotEmpty()) Fold("${mine.size} role(s) on ${sc.name}", "${mine.sumOf { it.sighted }} sighted turns between them") {
                mine.forEach { r -> Box(Modifier.padding(start = 14.dp)) { ScopeRow(r, slice) } }
            }
        }
    }
}

@Composable
private fun ScopeRow(sc: TrainingWatch.Scope, slice: Int) {
    val cs = MaterialTheme.colorScheme
    val (label, tone) = when {
        sc.model.isNotBlank() && sc.stage.isNotBlank() -> sc.stage to (when (sc.stage) { "primary" -> Tone.GOOD; "canary" -> Tone.WARN; else -> Tone.NEUTRAL })
        sc.model.isNotBlank() -> "served" to Tone.GOOD
        sc.adapter.isNotBlank() -> "promoted, not exported" to Tone.WARN
        sc.level == "role" && sc.sighted < slice -> "rides with ${sc.platform.ifBlank { "base" }.let { if (it == "web") "base" else it }}" to Tone.NEUTRAL
        sc.level == "platform" && sc.sighted < slice -> "rides with base" to Tone.NEUTRAL
        else -> "no adapter yet" to Tone.NEUTRAL
    }
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(sc.label, color = cs.onSurface, fontSize = 13.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (sc.level == "role" && sc.platform.isNotBlank() && sc.platform != "web") { Caption(sc.platform, maxLines = 1); Spacer(Modifier.width(8.dp)) }
            StatusChip(label, tone)
        }
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Meter(if (sc.sighted > 0) sc.seen.toFloat() / sc.sighted else 0f, Modifier.weight(1f), tone = if (sc.sighted > 0 && sc.seen >= sc.sighted) Tone.GOOD else Tone.NEUTRAL)
            Spacer(Modifier.width(10.dp))
            Figure("${sc.seen}/${sc.sighted} trained · ${sc.untrained} to go · paper ${sc.exam}${if (sc.exam in 1..29) " (too small to promote on)" else ""}", color = cs.onSurfaceVariant, size = 10)
        }
        /* What serves for it and what it chains from, in one line - the pointer and its parent. */
        val chain = when {
            sc.adapter.isNotBlank() -> "adapter ${sc.adapter.substringAfterLast('/').substringAfterLast('\\')}"
            sc.parentAdapter.isNotBlank() -> "chains from ${sc.parentAdapter.substringAfterLast('/').substringAfterLast('\\')}"
            sc.level == "base" -> "chains from the bare model"
            else -> "chains from base once base has an adapter"
        }
        Spacer(Modifier.height(2.dp))
        Figure(if (sc.model.isNotBlank()) "${sc.model} · $chain" + (if (sc.stageWhy.isNotBlank()) " — ${sc.stageWhy}" else "") else chain, color = cs.onSurfaceVariant, size = 10)
    }
}

/*
 * THE PRACTICE COLLECTOR. The base collector walks public pages as nobody in particular; this one
 * lets a thin role do its own job in its platform's signed-in profile. The switch is disabled while
 * automatic acting is on, and the card says so in red: a practice run must never post by itself.
 */
@Composable
private fun PracticeCard(p: TrainingWatch.Practice, onSetPractice: (Boolean) -> Unit) {
    val cs = MaterialTheme.colorScheme
    StudioCard("Practising the roles", TrainingWatch.practiceLine(p),
        chip = { StatusChip(if (p.autoAct) "blocked" else if (p.on) "on" else "off", if (p.autoAct) Tone.BAD else if (p.on) Tone.GOOD else Tone.NEUTRAL) }) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("A thin role does its own job in its platform's signed-in profile, one walk at a time.", color = cs.onSurfaceVariant, fontSize = 12.sp)
                Spacer(Modifier.height(2.dp))
                Text("Outward steps stay proposals at the gate; account tasks are never written; at most ${p.capPerHour} an hour; a role rests an hour between runs.", color = cs.onSurfaceVariant, fontSize = 11.sp)
            }
            Spacer(Modifier.width(10.dp))
            Switch(checked = p.on, onCheckedChange = onSetPractice, enabled = !p.autoAct)
        }
        if (p.autoAct) { Spacer(Modifier.height(6.dp)); Text("Automatic acting is on. Switch it off in Settings before practising — a practice run must not post on its own.", color = cs.error, fontSize = 12.sp) }
        Spacer(Modifier.height(Studio.gapS))
        Eyebrow("SIGNED-IN PLATFORMS")
        Spacer(Modifier.height(4.dp))
        if (p.logins.isEmpty()) Caption("none — a platform is practised only from a profile that holds its login")
        else Caption(p.logins.map { "${it.platform} (${it.profile})" }.distinct().joinToString(", "), maxLines = 3)
        if (p.currentRole.isNotBlank()) {
            Spacer(Modifier.height(Studio.gapS))
            Eyebrow("NOW")
            Spacer(Modifier.height(4.dp))
            Text("${p.currentRole} in ${p.currentProfile}", color = cs.onSurface, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            Caption(p.currentPrompt, maxLines = 3)
        }
        if (p.history.isNotEmpty()) {
            Spacer(Modifier.height(Studio.gapS))
            Fold("Practised", "last ${p.history.size}") {
                p.history.forEach { h ->
                    Column(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) { Figure(h.role, color = cs.onSurface, size = 11); Spacer(Modifier.width(8.dp)); Caption(h.at.take(16).replace('T', ' '), maxLines = 1) }
                        Caption(h.prompt, maxLines = 2)
                    }
                }
            }
        }
    }
}

/** The platform map: what the set knows about each platform, carried in every system message on it. */
@Composable
private fun PlatformMapCard(rows: List<TrainingWatch.PlatformPages>) {
    val cs = MaterialTheme.colorScheme
    StudioCard("Platform notes", "the pages each platform showed, what was pressed and typed on them — from the set, in every system message on that platform") {
        rows.take(12).forEach { p ->
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(p.name, color = cs.onSurface, fontSize = 13.sp, modifier = Modifier.weight(1f))
                Figure("${p.pages} page(s) · ${p.turns} steps", color = cs.onSurfaceVariant, size = 11)
            }
        }
    }
}

/** The planner's next choice, from the model map. */
@Composable
private fun NextRoundCard(p: TrainingWatch.Plan) {
    StudioCard("What runs next", "the planner's choice, from the model map", chip = { StatusChip(TrainingWatch.scopeLabel(p.scope), Tone.GOOD) }) {
        Caption(p.why, maxLines = 3)
    }
}

/*
 * ═══ THE BATCH STAGE ═══════════════════════════════════════════════════════════════════════════
 *
 * One batch of one scope, every connected machine as a lane. A lane shows the share the machine
 * holds - its round, its phase (baseline exam, training, final exam, upload), how far into it, the
 * loss and the minutes left - or why the machine holds none: fetching its slice, idle, offline,
 * setting up. Under the lanes, the merge lane: waiting for the shares, merging on a machine, the
 * merged adapter's exam against the start. Above them, the chain as a strip. Everything on it is a
 * measurement the hub already has; nothing here is decoration.
 */
@Composable
private fun BatchStage(view: TrainingWatch.View, onStopRound: (String) -> Unit = {}) {
    val cs = MaterialTheme.colorScheme
    val shares = view.actives.filter { !it.merge }
    val merging = view.actives.firstOrNull { it.merge }
    val batchId = shares.firstOrNull { it.batch.isNotBlank() }?.batch ?: view.pending.firstOrNull { it.batch.isNotBlank() }?.batch ?: ""
    val members = if (batchId.isNotBlank()) view.rounds.filter { it.batch == batchId && !it.merge } else shares
    val mergedRound = if (batchId.isNotBlank()) view.rounds.firstOrNull { it.merge && it.batch == batchId } else null
    val scopeKey = (shares.firstOrNull() ?: members.firstOrNull())?.scope?.ifBlank { "base" } ?: view.pending.firstOrNull()?.scope ?: "base"
    val machines = view.trainers.filter { it.online || it.round != null }
    /* Hours per machine: the hub's sizing when it has one, else from the batch's own share (not the machines online now). */
    val shareN = maxOf(1, members.maxOfOrNull { it.share } ?: view.pending.maxOfOrNull { it.share } ?: view.gpu?.machines ?: 1)
    /* A RUNNING batch shows its own hours, from its rounds (a round knows how long it was given); the
       owner's settings describe the NEXT batch and may already differ. */
    val runningHours = members.mapNotNull { r -> r.hours.takeIf { it > 0 } }.maxOrNull()
    val hoursEach = runningHours ?: view.sizing?.hoursEach?.takeIf { it > 0 } ?: view.gpu?.let { g -> if (g.trainShare == "work") g.trainHours.toDouble() else g.trainHours.toDouble() / shareN } ?: 0.0
    val modeText = if (runningHours != null && shareN > 1) (if (members.any { it.mode == "work" }) "double the work" else if (members.any { it.mode == "time" }) "split the time" else null) else null
    val eachText = if (hoursEach == hoursEach.toLong().toDouble()) "${hoursEach.toLong()}" else "${kotlin.math.round(hoursEach * 10) / 10}"

    /* The chain's position: the earliest phase any share is in, or the merge's. */
    val phases = members.map { TrainingWatch.stageOf(it).phase }
    val chainAt = when {
        mergedRound != null && mergedRound.status == "done" -> if (mergedRound.promoted) "serving" else "measured"
        merging != null -> "merging"
        members.isNotEmpty() && members.all { it.status == "done" } -> "uploaded"
        phases.contains("baseline exam") || phases.contains("starting") -> "baseline exam"
        phases.contains("training") -> "training"
        phases.contains("final check") -> "final check"
        phases.contains("final exam") -> "final exam"
        else -> "baseline exam"
    }

    Surface(color = cs.surface, shape = RoundedCornerShape(Studio.radius), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(Studio.gapL)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                LivePulse()
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text("One batch · ${TrainingWatch.scopeLabel(scopeKey)}", style = MaterialTheme.typography.titleMedium, color = cs.onSurface)
                    Caption(buildString {
                        append("${maxOf(1, members.size + view.pending.size)} machine(s)")
                        if (runningHours != null) append(" · ${modeText ?: "one batch"} · $eachText h each on this batch")
                        else view.gpu?.let { g -> append(" · ${if (g.trainShare == "work") "double the work" else "split the time"} · ${g.trainHours} h batch, $eachText h each") }
                        if (batchId.isNotBlank()) append(" · ${batchId.takeLast(8)}")
                    })
                }
                StatusChip(chainAt, if (chainAt == "serving") Tone.GOOD else Tone.NEUTRAL)
            }
            Spacer(Modifier.height(Studio.gapM))
            ChainStrip(chainAt)
            Spacer(Modifier.height(Studio.gapM))

            /* One lane per machine. A machine with a share shows it; without one, why not. */
            val laneMachines = (machines.map { it.name } + members.map { it.device } + view.pending.map { it.device })
                .map { it.lowercase() }.distinct()
            laneMachines.forEachIndexed { i, key ->
                val trainer = machines.firstOrNull { it.name.lowercase() == key }
                val round = members.firstOrNull { it.device.lowercase() == key } ?: shares.firstOrNull { it.device.lowercase() == key }
                val pending = view.pending.firstOrNull { it.device.lowercase() == key }
                MachineLane(name = trainer?.name ?: round?.device ?: pending?.device ?: key, trainer = trainer, round = round, pending = pending, hoursEach = hoursEach, onStop = onStopRound)
                if (i < laneMachines.size - 1) Spacer(Modifier.height(Studio.gapS))
            }

            /*
             * ONLY A REAL BATCH MERGES. Two rounds running at once used to mean one scope split
             * into shares; it now also means two students on two cards, which never merge - their
             * adapters belong to different models and do not even have the same shape.
             */
            val realBatch = batchId.isNotBlank() && members.size > 1 && members.all { it.batch == batchId }
            if (realBatch || merging != null || mergedRound != null) {
                Spacer(Modifier.height(Studio.gapM))
                Hairline()
                Spacer(Modifier.height(Studio.gapS))
                MergeLane(members, merging ?: mergedRound, onStopRound)
            }
        }
    }
}

/** A dot that breathes while something runs. */
@Composable
private fun LivePulse() {
    val t = rememberInfiniteTransition()
    val a by t.animateFloat(0.35f, 1f, infiniteRepeatable(tween(1400, easing = LinearEasing), RepeatMode.Reverse))
    Box(Modifier.size(12.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(12.dp).clip(CircleShape).background(Brand.copy(alpha = 0.18f * a + 0.05f)))
        Box(Modifier.size(7.dp).clip(CircleShape).background(Brand.copy(alpha = a)))
    }
}

/** The chain as a strip: exam → train → exam → hub → merge → exam → serve, the current one lit. */
@Composable
private fun ChainStrip(current: String) {
    val cs = MaterialTheme.colorScheme
    val labels = listOf("baseline exam" to "exam", "training" to "train", "final check" to "check", "final exam" to "exam", "uploaded" to "hub", "merging" to "merge", "measured" to "exam", "serving" to "serve")
    val at = labels.indexOfFirst { it.first == current }.coerceAtLeast(0)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        labels.forEachIndexed { i, (_, label) ->
            val done = i < at; val now = i == at
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.weight(1f)) {
                Box(Modifier.height(6.dp).fillMaxWidth().clip(RoundedCornerShape(3.dp)).background(if (done) Brand.copy(alpha = 0.55f) else if (now) Brand else cs.surfaceVariant))
                Spacer(Modifier.height(4.dp))
                Text(label, color = if (now) Brand else if (done) cs.onSurface else cs.onSurfaceVariant, fontSize = 9.sp, fontWeight = if (now) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1)
            }
            if (i < labels.size - 1) Spacer(Modifier.width(4.dp))
        }
    }
}

/** A machine's lane: the ring is how far into the phase, the words are the phase and its numbers. */
@Composable
private fun MachineLane(name: String, trainer: TrainingWatch.Trainer?, round: TrainingWatch.Round?, pending: TrainingWatch.Pending?, hoursEach: Double, onStop: (String) -> Unit = {}) {
    val cs = MaterialTheme.colorScheme
    val stage = round?.let { TrainingWatch.stageOf(it) }
    val (phase, detail, tone) = when {
        round != null && stage != null -> Triple(stage.phase, stage.detail, if (stage.phase == "failed") Tone.BAD else if (stage.phase == "done") Tone.GOOD else Tone.NEUTRAL)
        pending != null -> Triple("fetching its share", "${pending.turns} turns of ${TrainingWatch.scopeLabel(pending.scope)} on the way", Tone.NEUTRAL)
        trainer == null -> Triple("offline", "", Tone.NEUTRAL)
        trainer.settingUp -> Triple("setting up", trainer.setupLine, Tone.WARN)
        !trainer.online -> Triple("offline", "last seen with a round: ${trainer.round?.roundId ?: "none"}", Tone.NEUTRAL)
        !trainer.able -> Triple("cannot train", trainer.missing.firstOrNull() ?: "", Tone.WARN)
        !trainer.allowed -> Triple("not switched on", "allow it on the Machines page to join the next batch", Tone.WARN)
        else -> Triple("idle", "joins the next batch", Tone.NEUTRAL)
    }
    val fraction = stage?.fraction ?: (if (pending != null) 0f else -1f)
    val active = round != null && round.status == "running"
    Surface(color = if (active) cs.surfaceVariant.copy(alpha = 0.55f) else cs.surfaceVariant.copy(alpha = 0.25f), shape = RoundedCornerShape(Studio.radiusS),
        border = if (active) BorderStroke(1.dp, Brand.copy(alpha = 0.45f)) else null, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            LaneRing(fraction, active)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(name, color = cs.onSurface, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    StatusChip(phase, tone)
                    if (active && round != null) { Spacer(Modifier.width(6.dp)); StopButton { onStop(round.id) } }
                }
                if (detail.isNotBlank()) { Spacer(Modifier.height(3.dp)); Caption(detail, maxLines = 2) }
                if (round != null) {
                    Spacer(Modifier.height(4.dp))
                    Figure(buildString {
                        append("${round.turns} turns")
                        if (hoursEach > 0) append(" · ${if (hoursEach == hoursEach.toLong().toDouble()) "${hoursEach.toLong()}" else "${kotlin.math.round(hoursEach * 10) / 10}"} h")
                        if (round.bestValLoss >= 0) append(" · val ${TrainingWatch.loss(round.bestValLoss)}")
                        if (round.startedAt.length >= 16) append(" · since ${round.startedAt.substring(11, 16)}")
                        round.lines.lastOrNull()?.let { l -> append(" · ").append(l.take(48)) }
                    }, color = cs.onSurfaceVariant, size = 10)
                }
            }
        }
    }
}

@Composable
private fun LaneRing(fraction: Float, active: Boolean) {
    val cs = MaterialTheme.colorScheme
    val spin = rememberInfiniteTransition()
    val angle by spin.animateFloat(0f, 360f, infiniteRepeatable(tween(2400, easing = LinearEasing)))
    Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val stroke = 5.dp.toPx(); val inset = stroke / 2
            val arc = androidx.compose.ui.geometry.Size(size.width - stroke, size.height - stroke)
            drawArc(cs.surfaceVariant, 0f, 360f, false, Offset(inset, inset), arc, style = Stroke(stroke))
            if (fraction >= 0f) drawArc(Brand, -90f, 360f * fraction.coerceIn(0f, 1f), false, Offset(inset, inset), arc, style = Stroke(stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round))
            else if (active) drawArc(Brand, angle, 80f, false, Offset(inset, inset), arc, style = Stroke(stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round))
        }
        if (fraction >= 0f) Text("${(fraction * 100).toInt()}", color = cs.onSurface, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
    }
}

/** The merge lane: waiting for the shares, merging, or the merged adapter's exam against the start. */
@Composable
private fun MergeLane(members: List<TrainingWatch.Round>, merge: TrainingWatch.Round?, onStop: (String) -> Unit = {}) {
    val cs = MaterialTheme.colorScheme
    val done = members.count { it.status == "done" }
    val (label, detail, tone) = when {
        merge != null && merge.status == "done" && merge.promoted -> Triple("serving", "merged adapter ${TrainingWatch.pct(merge.result)} against ${TrainingWatch.pct(merge.baseline)} — promoted, exporting to the model server", Tone.GOOD)
        merge != null && merge.status == "done" -> Triple(if (merge.won) "merged · won" else "merged · did not beat it", "${TrainingWatch.pct(merge.result)} against ${TrainingWatch.pct(merge.baseline)}${if (merge.collapse >= 0) " · collapse ${TrainingWatch.trimPublic(merge.collapse)}×" else ""}", if (merge.won) Tone.GOOD else Tone.WARN)
        merge != null -> Triple("merging on ${merge.device}", TrainingWatch.stageOf(merge).detail, Tone.NEUTRAL)
        done == members.size && members.isNotEmpty() -> Triple("shares in — merging next", "every share is on the hub; a free machine averages them and takes the exam once", Tone.NEUTRAL)
        else -> Triple("merge waits", "$done of ${members.size} share(s) done — the average is taken when all are on the hub", Tone.NEUTRAL)
    }
    /* Read the theme here, not inside the draw lambda - that one is not composable. */
    val ringColor = toneColor(tone)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.size(44.dp)) {
                val stroke = 5.dp.toPx(); val inset = stroke / 2
                val arc = androidx.compose.ui.geometry.Size(size.width - stroke, size.height - stroke)
                drawArc(cs.surfaceVariant, 0f, 360f, false, Offset(inset, inset), arc, style = Stroke(stroke))
                if (members.isNotEmpty()) drawArc(ringColor, -90f, 360f * done / members.size, false, Offset(inset, inset), arc, style = Stroke(stroke, cap = androidx.compose.ui.graphics.StrokeCap.Round))
            }
            Text("${done}/${members.size}", color = cs.onSurface, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Merge", color = cs.onSurface, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                StatusChip(label, tone)
                if (merge != null && merge.status == "running") { Spacer(Modifier.width(6.dp)); StopButton { onStop(merge.id) } }
            }
            Spacer(Modifier.height(3.dp))
            Caption(detail, maxLines = 2)
        }
    }
}

/**
 * Stop, armed by a first tap. A round is hours of a laptop's work; one stray tap must not end
 * it, so the first tap asks and the second answers. It disarms itself after a few seconds.
 */
/**
 * WHO SHOULD BE THE STUDENT.
 *
 * The model underneath every adapter was a pragmatic default, never a measured choice. Each
 * candidate here sits the SAME paper the rounds are scored on, with no adapter at all, so the
 * numbers compare to each other and to the start of every round. A trial trains nothing and takes
 * no turns out of the corpus, which is what makes it safe to run while the data cannot grow.
 *
 * What it settles is the STARTING point. An adapter belongs to the model under it, so changing
 * student throws away every adapter we hold: the winner earns one full round on the same turns,
 * and that round decides.
 */
@Composable
private fun StudentsCard(s: TrainingWatch.Students, onTrial: (List<String>) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Card("Which student", "the same paper, no adapter, and the numbers decide") {
        val scored = s.candidates.count { it.trial != null && it.trial.agreement >= 0 }
        Text(
            if (s.running) "A trial is running. One at a time, and never beside a round."
            else if (scored == 0) "Nobody has sat the paper yet. A trial takes about twenty minutes a candidate on the rented card and costs no turns."
            else "$scored of ${s.candidates.size} have sat the paper.",
            color = cs.onSurfaceVariant, fontSize = 12.sp,
        )
        Spacer(Modifier.height(10.dp))
        s.candidates.forEach { c ->
            val t = c.trial
            val lead = s.leaderId.isNotBlank() && c.id == s.leaderId
            Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(c.name, color = if (lead) Brand else cs.onSurface, fontSize = 13.sp,
                            fontWeight = if (lead) FontWeight.SemiBold else FontWeight.Normal)
                        Spacer(Modifier.width(6.dp))
                        Text(c.params, color = cs.onSurfaceVariant, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                        if (c.queued) { Spacer(Modifier.width(6.dp)); Text("QUEUED", color = cs.onSurfaceVariant, fontSize = 9.sp, fontWeight = FontWeight.SemiBold) }
                    }
                    Text(c.why, color = cs.onSurfaceVariant, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (t != null && t.status == "failed") {
                        Text(t.why.ifBlank { "the trial failed" }, color = cs.error, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                Spacer(Modifier.width(8.dp))
                /* Never seen is not a zero, and a zero would sort like a loss. */
                when {
                    t == null -> Text("not tried", color = cs.onSurfaceVariant, fontSize = 11.sp)
                    t.running -> Text("sitting it", color = Brand, fontSize = 11.sp)
                    t.agreement >= 0 -> Column(horizontalAlignment = Alignment.End) {
                        Text(TrainingWatch.pct(t.agreement), color = if (lead) Brand else cs.onSurface, fontSize = 14.sp, fontFamily = FontFamily.Monospace)
                        Text("${t.turns} turns" + (if (t.unusable >= 0) " · ${TrainingWatch.pct(t.unusable)} unusable" else ""),
                            color = cs.onSurfaceVariant, fontSize = 9.sp)
                    }
                    else -> Text("—", color = cs.onSurfaceVariant, fontSize = 11.sp)
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        if (s.leaderName.isNotBlank()) {
            Text("Ahead: ${s.leaderName} at ${TrainingWatch.pct(s.leader)}. A trial nominates; one full round on the same turns decides, because every adapter we hold belongs to the model under it.",
                color = cs.onSurfaceVariant, fontSize = 11.sp)
            Spacer(Modifier.height(6.dp))
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { onTrial(emptyList()) }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
                Text(if (scored == 0) "Score them all" else "Score them again", color = Brand, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
            val untried = s.candidates.filter { it.trial == null && !it.queued }.map { it.id }
            if (untried.isNotEmpty() && scored > 0) {
                TextButton(onClick = { onTrial(untried) }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
                    Text("Score the ${untried.size} untried", color = cs.onSurfaceVariant, fontSize = 12.sp)
                }
            }
        }
    }
}

/**
 * THE SCOREBOARD.
 *
 * Every measured round in one table with the model as a column, so a Qwen3 round and a Qwen2.5 one
 * are read against each other rather than remembered from two screens. A round is judged against
 * ITS OWN start - they begin in different places - and the model that serves is marked, because
 * that is the bar any of them has to clear to replace it.
 *
 * Below the table the same rounds become columns with the tools as rows, ordered by how often each
 * tool is asked. That is the view that says WHERE a round won or lost, which a headline never
 * does: one round tonight gained on four tools and lost the night on one.
 */
@Composable
private fun ResultsCard(results: TrainingWatch.Results?, onLoad: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    LaunchedEffect(Unit) { onLoad() }
    Card("Results", "every measured round, whatever model trained it") {
        if (results == null) { Text("Loading the rounds...", color = cs.onSurfaceVariant, fontSize = 12.sp); return@Card }
        if (results.error.isNotBlank()) { Text(results.error, color = cs.error, fontSize = 12.sp); return@Card }
        if (results.rounds.isEmpty()) { Text("No round has been measured yet.", color = cs.onSurfaceVariant, fontSize = 12.sp); return@Card }
        if (results.servingModel.isNotBlank()) {
            Text("Serving now: " + shortName(results.servingModel) + " at " + TrainingWatch.pct(results.serving) + " - the bar a round has to clear to replace it.",
                color = cs.onSurfaceVariant, fontSize = 11.sp)
            Spacer(Modifier.height(10.dp))
        }
        Row(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
            Eyebrow("MODEL", Modifier.weight(1.6f))
            Eyebrow("START", Modifier.weight(0.8f))
            Eyebrow("AFTER", Modifier.weight(0.8f))
            Eyebrow("CHANGE", Modifier.weight(0.9f))
            Eyebrow("COLLAPSE", Modifier.weight(1f))
            Eyebrow("VERDICT", Modifier.weight(1.2f))
        }
        results.rounds.forEach { r ->
            val serving = r.id == results.servingId
            val tone = when (r.verdict) {
                "promoted" -> Brand
                "refused" -> toneColor(Tone.BAD)
                else -> cs.onSurface
            }
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1.6f)) {
                    Text(shortName(r.model) + (if (r.wore.isNotBlank()) " +adapter" else ""),
                        color = if (serving) Brand else cs.onSurface, fontSize = 12.sp,
                        fontWeight = if (serving) FontWeight.SemiBold else FontWeight.Normal,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text((if (r.trial) "bare trial" else r.turns.toString() + " turns") + " - " + r.scope,
                        color = cs.onSurfaceVariant, fontSize = 9.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text(if (r.start >= 0) TrainingWatch.pct(r.start) else "-", Modifier.weight(0.8f),
                    color = cs.onSurfaceVariant, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                Text(TrainingWatch.pct(r.after), Modifier.weight(0.8f), color = tone, fontSize = 13.sp, fontFamily = FontFamily.Monospace)
                Text(changeText(r.change), Modifier.weight(0.9f), color = changeColor(r.change, cs.onSurfaceVariant),
                    fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                Text(if (r.collapse >= 0) r.collapse.toString() + "/" + r.collapseTool else "-",
                    Modifier.weight(1f), color = if (r.collapse > 2.0) toneColor(Tone.BAD) else cs.onSurfaceVariant,
                    fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(r.verdict, Modifier.weight(1.2f), color = tone, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }

        val shown = results.rounds.filter { it.perTool.isNotEmpty() }.take(3)
        if (shown.isNotEmpty() && results.tools.isNotEmpty()) {
            Spacer(Modifier.height(14.dp))
            Eyebrow("WHERE EACH ROUND WON OR LOST")
            Spacer(Modifier.height(6.dp))
            Row(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
                Text("tool", Modifier.weight(1.1f), color = cs.onSurfaceVariant, fontSize = 9.sp, fontWeight = FontWeight.SemiBold)
                Text("asked", Modifier.weight(0.6f), color = cs.onSurfaceVariant, fontSize = 9.sp, fontWeight = FontWeight.SemiBold)
                shown.forEach { r ->
                    Text(shortName(r.model).take(11), Modifier.weight(1.2f), color = cs.onSurfaceVariant, fontSize = 9.sp,
                        fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            results.tools.take(14).forEach { tool ->
                val cells = shown.map { r -> r.perTool.firstOrNull { it.tool == tool } }
                val asked = cells.filterNotNull().maxOfOrNull { it.seen } ?: 0
                Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(tool, Modifier.weight(1.1f), color = cs.onSurface, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(asked.toString(), Modifier.weight(0.6f), color = cs.onSurfaceVariant, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                    cells.forEach { c ->
                        Column(Modifier.weight(1.2f)) {
                            Text(if (c == null || c.after < 0) "-" else TrainingWatch.pct(c.after),
                                color = cs.onSurface, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
                            if (c != null && c.change > -900.0 && c.change != 0.0) {
                                Text(changeText(c.change), color = changeColor(c.change, cs.onSurfaceVariant),
                                    fontSize = 9.sp, fontFamily = FontFamily.Monospace)
                            }
                        }
                    }
                }
            }
            Text("Each column is judged against its own start, so the small figure is the change that round made to that tool.",
                color = cs.onSurfaceVariant, fontSize = 10.sp, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

/** The model without its owner, for a column heading. */
private fun shortName(model: String): String = model.substringAfterLast('/')

/** A change, with its sign, or a dash when there was nothing to compare against. */
private fun changeText(v: Double): String = if (v <= -900.0) "-" else (if (v > 0) "+" else "") + v.toString()

@Composable
private fun changeColor(v: Double, neutral: Color): Color = when {
    v <= -900.0 -> neutral
    v > 0 -> Brand
    v < 0 -> toneColor(Tone.BAD)
    else -> neutral
}

/**
 * SIDE BY SIDE.
 *
 * A percentage says a model is worse. It never says where, and it never shows you the answer. This
 * does both: the teacher's action and the model's, step by step, on the same job.
 *
 * Two ways in. A RECORDED job is replayed from the set, which costs nothing and needs no teacher -
 * it is teacher-forced, so the model always sees the page the teacher saw and a wrong step costs
 * it nothing later. A LIVE prompt has the teacher work the job for real with the model answering
 * beside it, which is the honest test and needs the teacher to have credit.
 */
@Composable
private fun CompareCard(
    offer: TrainingWatch.CompareOffer?,
    run: TrainingWatch.CompareRun?,
    onLoad: () -> Unit,
    onRecorded: (String, String) -> Unit,
    onLive: (String, String) -> Unit,
    onStop: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    LaunchedEffect(Unit) { onLoad() }
    var live by remember { mutableStateOf(false) }
    var prompt by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var job by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf("") }
    LaunchedEffect(offer?.models) { if (model.isBlank()) model = offer?.models?.firstOrNull() ?: "" }

    Card("Side by side", "the teacher and a model, on the same job, step by step") {
        if (offer == null) { Text("Loading...", color = cs.onSurfaceVariant, fontSize = 12.sp); return@Card }
        if (offer.error.isNotBlank()) { Text(offer.error, color = cs.error, fontSize = 12.sp); return@Card }

        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { live = false }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
                Text("A recorded job", color = if (!live) Brand else cs.onSurfaceVariant, fontSize = 12.sp,
                    fontWeight = if (!live) FontWeight.SemiBold else FontWeight.Normal)
            }
            TextButton(onClick = { live = true }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
                Text("A prompt of your own", color = if (live) Brand else cs.onSurfaceVariant, fontSize = 12.sp,
                    fontWeight = if (live) FontWeight.SemiBold else FontWeight.Normal)
            }
        }
        Text(
            if (live) "The teacher works the prompt for real and the model answers beside it. This needs the teacher to have credit, and it can only ask the model that is set to serve."
            else "Replayed from the recorded set: the model sees exactly the page the teacher saw. No teacher calls, so this works whatever the allowance says.",
            color = cs.onSurfaceVariant, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp, bottom = 8.dp),
        )

        Eyebrow("MODEL")
        Spacer(Modifier.height(4.dp))
        if (offer.models.isEmpty()) {
            Text("The model server holds nothing yet — export a round first.", color = cs.onSurfaceVariant, fontSize = 11.sp)
        } else {
            Column {
                offer.models.forEach { m ->
                    val chosen = m == model
                    val servable = offer.serving.any { it.removeSuffix(":latest") == m.removeSuffix(":latest") }
                    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = { model = m }, contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp)) {
                            Text(if (chosen) "● $m" else "○ $m", color = if (chosen) Brand else cs.onSurface, fontSize = 12.sp,
                                fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        if (servable) Text("serving", color = cs.onSurfaceVariant, fontSize = 9.sp)
                    }
                }
            }
        }

        Spacer(Modifier.height(10.dp))
        if (live) {
            OutlinedTextField(
                value = prompt, onValueChange = { prompt = it },
                label = { Text("What should they both be asked to do?") },
                placeholder = { Text("Go to Google Maps, search tandarts Groningen, collect four leads") },
                modifier = Modifier.fillMaxWidth(), minLines = 2, maxLines = 4,
                textStyle = LocalTextStyle.current.copy(fontSize = 13.sp),
            )
            Spacer(Modifier.height(8.dp))
            val canLive = prompt.isNotBlank() && model.isNotBlank() && offer.serving.any { it.removeSuffix(":latest") == model.removeSuffix(":latest") }
            TextButton(onClick = { onLive(prompt, model) }, enabled = canLive,
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
                Text("Run them both", color = if (canLive) Brand else cs.onSurfaceVariant, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
            if (model.isNotBlank() && !offer.serving.any { it.removeSuffix(":latest") == model.removeSuffix(":latest") }) {
                Text("Only the serving model can be asked beside the teacher. Set this one to serve first, or use a recorded job.",
                    color = cs.onSurfaceVariant, fontSize = 10.sp, modifier = Modifier.padding(top = 4.dp))
            }
        } else {
            OutlinedTextField(
                value = filter, onValueChange = { filter = it },
                label = { Text("Find a job") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(), textStyle = LocalTextStyle.current.copy(fontSize = 13.sp),
            )
            Spacer(Modifier.height(6.dp))
            val shown = offer.jobs.filter { filter.isBlank() || it.goal.contains(filter, true) || it.role.contains(filter, true) }.take(8)
            shown.forEach { j ->
                val chosen = j.jobId == job
                Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.Top) {
                    TextButton(onClick = { job = j.jobId }, contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp)) {
                        Text(if (chosen) "●" else "○", color = if (chosen) Brand else cs.onSurfaceVariant, fontSize = 12.sp)
                    }
                    Column(Modifier.weight(1f)) {
                        Text(j.goal.ifBlank { j.jobId }, color = if (chosen) Brand else cs.onSurface, fontSize = 12.sp,
                            maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(j.turns.toString() + " turns - " + j.role.ifBlank { "general" }, color = cs.onSurfaceVariant, fontSize = 9.sp)
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
            val canRun = job.isNotBlank() && model.isNotBlank()
            TextButton(onClick = { onRecorded(job, model) }, enabled = canRun,
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
                Text("Walk it", color = if (canRun) Brand else cs.onSurfaceVariant, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            }
        }

        if (run != null) {
            Spacer(Modifier.height(14.dp))
            Hairline()
            Spacer(Modifier.height(8.dp))
            if (run.error.isNotBlank()) {
                Text(run.error, color = cs.error, fontSize = 12.sp)
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(run.goal.ifBlank { run.jobId }, color = cs.onSurface, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(
                            (if (run.mode == "live") "live - " else "replayed - ") + run.model +
                                (if (run.steps.isEmpty()) "" else " - " + run.same.toString() + " of " + run.steps.size + " the same" +
                                    (if (run.agreement >= 0) " (" + TrainingWatch.pct(run.agreement) + ")" else "")),
                            color = cs.onSurfaceVariant, fontSize = 10.sp,
                        )
                    }
                    if (!run.done) StopButton(onStop)
                }
                Spacer(Modifier.height(8.dp))
                Row(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
                    Text("", Modifier.weight(0.25f))
                    Eyebrow("TEACHER", Modifier.weight(1f))
                    Eyebrow("MODEL", Modifier.weight(1f))
                }
                run.steps.forEach { s ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.Top) {
                        Text(s.n.toString(), Modifier.weight(0.25f), color = cs.onSurfaceVariant, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                        Column(Modifier.weight(1f)) {
                            Text(s.teacherTool, color = cs.onSurface, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                            if (s.teacherArgs.isNotBlank()) Text(s.teacherArgs, color = cs.onSurfaceVariant, fontSize = 9.sp,
                                fontFamily = FontFamily.Monospace, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        }
                        Column(Modifier.weight(1f)) {
                            Text(s.modelTool.ifBlank { "not a tool call" },
                                color = if (s.same) Brand else toneColor(Tone.BAD), fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                            val detail = if (s.modelArgs.isNotBlank()) s.modelArgs else s.raw
                            if (detail.isNotBlank()) Text(detail, color = cs.onSurfaceVariant, fontSize = 9.sp,
                                fontFamily = FontFamily.Monospace, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                if (!run.done) Text("Working... " + run.steps.size + (if (run.total > 0) " of " + run.total else "") + " steps",
                    color = cs.onSurfaceVariant, fontSize = 10.sp, modifier = Modifier.padding(top = 6.dp))
            }
        }
    }
}

@Composable
private fun StopButton(onStop: () -> Unit) {
    var armed by remember { mutableStateOf(false) }
    LaunchedEffect(armed) { if (armed) { kotlinx.coroutines.delay(5000); armed = false } }
    TextButton(onClick = { if (armed) { armed = false; onStop() } else armed = true }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
        Text(if (armed) "Stop it?" else "Stop", color = toneColor(Tone.BAD), fontSize = 12.sp, fontWeight = if (armed) FontWeight.SemiBold else FontWeight.Normal)
    }
}

/**
 * MODAL. The hub starts a GPU node in the owner's Modal workspace by itself: the token is pasted
 * once, the GPU chosen, and with the auto switch on a node is up whenever there is something to
 * learn and gone when idle. Start now for the impatient; Stop ends the app on Modal.
 */
@Composable
private fun ModalPanel(nodes: TrainingWatch.Nodes?, onSetModal: (Map<String, String>) -> Unit, onStart: () -> Unit, onStop: () -> Unit, onRevoke: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val m = nodes?.modal
    var tokenId by remember { mutableStateOf("") }
    var tokenSecret by remember { mutableStateOf("") }
    Column {
        Text("A GPU node in your Modal workspace, started by the hub. The free plan gives about \$30 of credits a month; a T4 costs about \$0.60 an hour and trains the whole corpus in about three hours. The node leaves when idle, so it costs only while it works.",
            color = cs.onSurfaceVariant, fontSize = 12.sp)
        Spacer(Modifier.height(8.dp))
        if (m == null) { Text("This hub has no Modal support yet — update it.", color = cs.error, fontSize = 12.sp); return@Column }
        if (!m.ready) { Text("The hub image has no Modal client yet — it comes with the next hub build.", color = cs.error, fontSize = 12.sp); Spacer(Modifier.height(6.dp)) }
        Eyebrow("TOKEN")
        Spacer(Modifier.height(4.dp))
        if (m.configured) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusChip("token set ${m.tokenHint}", Tone.GOOD)
                Spacer(Modifier.width(8.dp))
                Caption("Settings → API tokens in Modal makes a new one; paste it below to replace.")
            }
            Spacer(Modifier.height(6.dp))
        } else Caption("In Modal: Settings → API tokens → New token. Paste the id (ak-…) and the secret (as-…) here once.")
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(tokenId, { tokenId = it }, label = { Text("Token id (ak-…)") }, singleLine = true, modifier = Modifier.weight(1f), shape = RoundedCornerShape(10.dp))
            Spacer(Modifier.width(8.dp))
            OutlinedTextField(tokenSecret, { tokenSecret = it }, label = { Text("Secret (as-…)") }, singleLine = true, modifier = Modifier.weight(1f), shape = RoundedCornerShape(10.dp))
            Spacer(Modifier.width(8.dp))
            Button(onClick = { if (tokenId.isNotBlank() && tokenSecret.isNotBlank()) { onSetModal(mapOf("tokenId" to tokenId.trim(), "tokenSecret" to tokenSecret.trim())); tokenId = ""; tokenSecret = "" } },
                enabled = tokenId.isNotBlank() && tokenSecret.isNotBlank(), shape = RoundedCornerShape(10.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand)) { Text("Save", fontSize = 12.sp) }
        }
        Spacer(Modifier.height(10.dp))
        Eyebrow("GPU")
        Spacer(Modifier.height(4.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("T4" to "T4 · \$0.60/h", "L4" to "L4 · \$0.80/h", "A10G" to "A10G · \$1.10/h", "A100" to "A100 · \$2.50/h").forEach { (g, label) ->
                val on = m.gpu == g
                Surface(color = if (on) BrandSoft else cs.surfaceVariant, shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable(enabled = !on) { onSetModal(mapOf("gpu" to g)) }) {
                    Text(label, Modifier.padding(horizontal = 10.dp, vertical = 6.dp), color = if (on) Brand else cs.onSurface, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Keep a node up by itself", color = cs.onSurface, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Caption("whenever training is on and there is something to learn; it leaves when idle and is not restarted within an hour of a start that got no round")
            }
            Switch(checked = m.auto, onCheckedChange = { onSetModal(mapOf("auto" to it.toString())) }, enabled = m.configured && m.ready)
        }
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            val state = when {
                m.online -> "node online" to Tone.GOOD
                m.starting.isNotBlank() -> "starting (the first start builds the image, a few minutes)" to Tone.NEUTRAL
                m.lastError.isNotBlank() -> "last start failed" to Tone.BAD
                m.lastStart.isNotBlank() -> "last started ${m.lastStart.take(16).replace('T', ' ')}" to Tone.NEUTRAL
                else -> "no node yet" to Tone.NEUTRAL
            }
            StatusChip(state.first, state.second)
            Spacer(Modifier.weight(1f))
            if (m.app.isNotBlank() || m.online) TextButton(onClick = onStop) { Text("Stop the node", color = toneColor(Tone.BAD), fontSize = 12.sp) }
            Button(onClick = onStart, enabled = m.configured && m.ready && m.starting.isBlank(), shape = RoundedCornerShape(10.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand)) { Text("Start a node now", fontSize = 12.sp) }
        }
        if (m.lastError.isNotBlank()) { Spacer(Modifier.height(4.dp)); Text(m.lastError, color = cs.error, fontSize = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 3, overflow = TextOverflow.Ellipsis) }
        val joins = nodes.joins.filter { it.kind == "modal" }
        if (joins.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            joins.takeLast(3).forEach { j -> JoinRow(j, onRevoke) }
        }
    }
}

/**
 * COLAB AND KAGGLE. No API on Colab's free tier, so the node is one line pasted into a cell; the
 * same line runs in any Python session with a GPU. Kaggle gets its API path later; until then the
 * same line in a Kaggle notebook (GPU on, internet on) is a machine too.
 */
@Composable
private fun PastePanel(kind: String, nodes: TrainingWatch.Nodes?, onJoin: (String) -> Unit, onRevoke: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    val joins = nodes?.joins?.filter { it.kind == kind } ?: emptyList()
    val label = if (kind == "colab") "Colab" else "Kaggle"
    Column {
        Text(
            if (kind == "colab") "Google Colab's free tier gives a T4 for a few hours at a time, with the tab open. Mint a line, paste it into a cell in a GPU notebook, run it: the session is a machine on this hub until Colab ends it or it goes idle."
            else "Kaggle gives 30 GPU hours a week and runs a notebook in the background for up to 12 hours (Save & Run All). Turn the GPU and internet on in the notebook settings, paste the line into a cell, and Save & Run All. The API path that does this for you comes next.",
            color = cs.onSurfaceVariant, fontSize = 12.sp)
        Spacer(Modifier.height(8.dp))
        Button(onClick = { onJoin(kind) }, shape = RoundedCornerShape(10.dp), colors = ButtonDefaults.buttonColors(containerColor = Brand)) { Text("Mint a line for $label", fontSize = 12.sp) }
        if (joins.isEmpty()) { Spacer(Modifier.height(6.dp)); Caption("no $label node joined yet") }
        joins.takeLast(3).forEach { j -> Spacer(Modifier.height(8.dp)); JoinRow(j, onRevoke) }
    }
}

@Composable
private fun JoinRow(j: TrainingWatch.NodeJoin, onRevoke: (String) -> Unit) {
    val cs = MaterialTheme.colorScheme
    Surface(color = cs.surfaceVariant.copy(alpha = 0.4f), shape = RoundedCornerShape(Studio.radiusS), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(if (j.online) Brand else cs.onSurfaceVariant))
                Spacer(Modifier.width(8.dp))
                Text(j.name, color = cs.onSurface, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                if (j.gpu.isNotBlank()) StatusChip(j.gpu, Tone.GOOD) else StatusChip(if (j.expired) "expired" else if (j.online) "online" else "waiting to be run", if (j.expired) Tone.WARN else Tone.NEUTRAL)
                TextButton(onClick = { onRevoke(j.code) }, contentPadding = PaddingValues(horizontal = 8.dp)) { Text("Revoke", color = toneColor(Tone.BAD), fontSize = 12.sp) }
            }
            if (j.line.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                SelectionContainer { Text(j.line, color = cs.onSurfaceVariant, fontSize = 11.sp, fontFamily = FontFamily.Monospace) }
                Caption("used ${j.uses} time(s) · good for a day · the line carries this node's own token")
            }
        }
    }
}

/** turns trained, else the turns handed over - a round that died early trained on none. */
private fun TrainingWatch.Round.trainedOrTurns(): Int = turns

@Composable
private fun Mini(label: String, value: String, tone: Tone) {
    Column {
        Eyebrow(label)
        Figure(value, color = if (tone == Tone.NEUTRAL) MaterialTheme.colorScheme.onSurface else toneColor(tone), size = 12)
    }
}

@Composable
private fun CompareRow(label: String, a: String, b: String) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
        Caption(label, Modifier.width(96.dp), maxLines = 1)
        Figure(a, Modifier.weight(1f), color = cs.onSurface, size = 11)
        Figure(b, Modifier.weight(1f), color = cs.onSurfaceVariant, size = 11)
    }
}
