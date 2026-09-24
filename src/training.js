/*
 * training.js — THE PIPELINE AS SOMETHING YOU CAN LOOK AT.
 *
 * The loop is meant to improve the model every night without anybody driving it, and that is exactly
 * why it needs a face. An unattended process with no surface is indistinguishable from a broken one:
 * the model either gets better or it does not, and nobody finds out which for weeks.
 *
 * So this holds three things and nothing else:
 *
 *   WHAT HAS BEEN COLLECTED   the corpus as it stands, by tier, and how much of it is new since the
 *                             last round — which is the honest answer to "is there anything to train
 *                             on tonight".
 *   WHAT EACH ROUND DID       every round kept forever, with the score before and after and whether
 *                             it was promoted. A round that made the model worse is as important to
 *                             keep as one that helped: it is the evidence the gate is working.
 *   WHAT IS SERVING NOW       which adapter is live, when it was promoted, and what it scored. One
 *                             pointer, so a rollback is moving it back.
 *
 * Deliberately NOT here: the training itself. That happens on a device with a CPU to spare, because
 * this node has none — it is the controller, and the one time it held eleven gigabytes for an idle
 * service nobody noticed for three weeks.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const corpusLib = require('./corpus');

/*
 * The paths are resolved per call, not frozen at import.
 *
 * Freezing them at module load makes the store depend on WHEN this file is first required relative
 * to the environment being set up — a difference that does not show in any test and shows in
 * production as an empty history nobody can explain. Resolving per call costs a string join.
 */
const DIR = () => path.join(process.env.PROFILE_DIR || '/profiles', 'training');
const ROUNDS = () => path.join(DIR(), 'rounds.json');
const CURRENT = () => path.join(DIR(), 'current.json');

const ensure = () => { try { fs.mkdirSync(DIR(), { recursive: true }); } catch { /* already there */ } };
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p, v) => { ensure(); fs.writeFileSync(p + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(p + '.tmp', p); };

/* ── rounds ─────────────────────────────────────────────────────────────────────────────────── */

const allRounds = () => readJson(ROUNDS(), []);

/* ── the pending dispatch ─────────────────────────────────────────────────────────────────────
 *
 * THE HUB OWNS THE SCOPE; THE DEVICE NEVER HEARS OF IT. The planner chooses what the next round
 * trains (base, a platform, a role) and writes it here at dispatch. The device fetches its slice
 * and its paper - both are drawn for the pending scope - and then registers the round, which
 * takes the scope with it. No installer changes, no flag on the trainer, and a GPU rental works
 * the same way. A pending older than PENDING_MS is a dispatch nobody picked up.
 */
const PENDING = () => path.join(DIR(), 'pending.json');
const PENDING_MS = 3 * 60 * 60 * 1000;
const platforms = require('./trainScopes');
const normScope = (s) => { const sc = platforms.parse(s || 'base'); return { level: sc.level, name: sc.name, key: sc.key }; };

function setPending({ scope = null, device = '', base = '' } = {}) {
  const p = { scope: normScope(scope), device: String(device || ''), base: String(base || ''), at: new Date().toISOString() };
  writeJson(PENDING(), p);
  return p;
}
function peekPending(now = Date.now()) {
  const p = readJson(PENDING(), null);
  if (!p || !p.at) return null;
  if (now - (Date.parse(p.at) || 0) > PENDING_MS) return null;
  return p;
}
function takePending(now = Date.now()) {
  const p = peekPending(now);
  try { fs.unlinkSync(PENDING()); } catch { /* none */ }
  return p;
}
/** The scope a round trains, or the pending one when the round is not registered yet. */
function scopeOfRound(id) {
  if (id) { const r = allRounds().find((x) => x.id === id); if (r) return normScope(r.scope || 'base'); }
  const p = peekPending();
  return p ? normScope(p.scope) : null;
}

/**
 * A round starts when a device takes it, not when it is dispatched.
 *
 * The difference matters: a round recorded at dispatch and never picked up looks identical to one
 * that ran and vanished, and telling those apart is the whole job of a status page.
 */
function startRound({ device = '', base = '', turns = 0, note = '', recipe = null, scope = null } = {}) {
  const pend = scope ? null : takePending();
  const r = {
    scope: normScope(scope || (pend && pend.scope) || 'base'),
    id: `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    startedAt: new Date().toISOString(),
    endedAt: null,
    device: String(device || 'unknown'),
    base: String(base || ''),
    turns: Number(turns) || 0,
    status: 'running',
    note: String(note || '').slice(0, 300),
    /* The recipe the device trained with - rank, scope, learning rate, epochs, accumulation,
       device. Two rounds are comparable only if this is; a score without it is a score nobody
       can reproduce. Free-form on purpose: the trainer owns its own vocabulary. */
    recipe: recipe && typeof recipe === 'object' && !Array.isArray(recipe) ? recipe : null,
    baseline: null,     // what the model scored BEFORE this round
    result: null,       // and after
    promoted: false,
    why: '',
  };
  const rows = allRounds();
  rows.unshift(r);
  writeJson(ROUNDS(), rows.slice(0, 200));
  return r;
}

/** Progress from the device while it works — one line, so the UI is never silent for an hour. */
function noteRound(id, line) {
  const rows = allRounds();
  const r = rows.find((x) => x.id === id);
  if (!r) return null;
  r.lines = [...(r.lines || []), { at: new Date().toISOString(), text: String(line || '').slice(0, 300) }].slice(-40);
  writeJson(ROUNDS(), rows);
  return r;
}

/** Where a round's adapter lives, when that is only known after the round - a rented machine
    hands it to the hub as its last act. */
function setAdapter(id, adapter) {
  const rows = allRounds();
  const r = rows.find((x) => x.id === id);
  if (!r) return null;
  r.adapter = String(adapter || '').slice(0, 200);
  writeJson(ROUNDS(), rows);
  return r;
}

/**
 * ONE VALIDATION POINT FROM THE DEVICE.
 *
 * The exam runs twice a round because it costs half an hour on a CPU; the validation loss runs
 * every hour because it costs two minutes. This is the curve that says whether a round is still
 * learning, and the reason a round can stop early and keep its best checkpoint rather than its
 * last. Kept in full (two hundred points is a long round) because the shape is the information.
 */
function checkRound(id, point = {}) {
  const rows = allRounds();
  const r = rows.find((x) => x.id === id);
  if (!r) return null;
  const v = Number(point.valLoss);
  if (!Number.isFinite(v)) return r;
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
  const p = {
    at: new Date().toISOString(),
    step: Number(point.step) || 0,
    turns: Number(point.turns) || 0,
    valLoss: v,
    trainLoss: num(point.trainLoss),
    lr: num(point.lr),
  };
  r.validation = [...(r.validation || []), p].slice(-200);
  if (r.bestValLoss == null || v < r.bestValLoss) { r.bestValLoss = v; r.bestAtTurns = p.turns; }
  writeJson(ROUNDS(), rows);
  return r;
}

/**
 * END A ROUND, AND DECIDE NOTHING HERE.
 *
 * Whether the new adapter is better is the device's measurement, taken on the frozen evaluation
 * split; this only records it. Promotion is a separate, explicit act — a round that finished is not
 * a round that won, and conflating them is how a worse model reaches production quietly.
 */
function endRound(id, { status = 'done', baseline = null, result = null, why = '', adapter = '', trained = 0, drawSeed = null } = {}) {
  const rows = allRounds();
  const r = rows.find((x) => x.id === id);
  if (!r) return null;
  r.endedAt = new Date().toISOString();
  r.status = status;
  r.baseline = baseline;
  r.result = result;
  r.why = String(why || '').slice(0, 400);
  /*
   * HOW MANY TURNS THIS ROUND ACTUALLY TRAINED ON — not how many were available to it.
   *
   * `turns` above is the size of the set the device was handed: 23,233. What it reached in six
   * hours was 685. Coverage is decided by summing this field, and summing the other one instead
   * would report the whole corpus as learned after a single night, at which point the loop
   * correctly concludes there is nothing left to do and quietly stops.
   */
  r.trained = Number(trained) || 0;
  if (drawSeed != null) r.drawSeed = Number(drawSeed);
  if (adapter) r.adapter = String(adapter).slice(0, 200);
  writeJson(ROUNDS(), rows);
  return r;
}

/**
 * Promote an adapter to serving. Explicit, and only ever after a measured win.
 *
 * Every version is kept — an adapter is a few megabytes — so rolling back is moving this pointer,
 * not rebuilding anything.
 */
/*
 * HOW FAR THE LOUDEST ANSWER MAY BE FROM HOW OFTEN IT IS RIGHT.
 *
 * 1.0 is a model that names each tool about as often as that tool is the answer. Above this, it has
 * stopped reading the page and started reaching for whichever answer is cheapest to produce.
 *
 * Two is generous and deliberately so. The evidence: the first round to finish this path came out at
 * 3.6 on `look` - it said look on 36% of a paper where look is correct 10% of the time - while a
 * balanced model measures 1.0. Anything near 2 is already guessing; the threshold exists to catch
 * the collapse, not to police a model that slightly over-reaches for a common tool.
 */
const MAX_COLLAPSE = 2.0;

function promote(roundId) {
  const rows = allRounds();
  const r = rows.find((x) => x.id === roundId);
  if (!r) return { error: 'no such round' };
  if (r.status !== 'done') return { error: `round ${roundId} is ${r.status}, not done` };
  if (!r.result || !r.baseline) return { error: 'that round has no measurement, so there is nothing to promote on' };
  if (Number(r.result.agreement_pct) <= Number(r.baseline.agreement_pct)) {
    return { error: `it did not beat the baseline (${r.result.agreement_pct}% against ${r.baseline.agreement_pct}%)` };
  }
  /*
   * A COLLAPSED MODEL BEATS ITS BASELINE AND IS STILL WORSE THAN NOTHING.
   *
   * The gate compared one number, and one number cannot see this. The first round to finish this path
   * scored 15.33% against 3.33% and answered `look` to almost everything: scroll -> look, open ->
   * look, read -> look, run_script -> look, finish -> look. It beat its baseline because the cheap
   * answer is also a common one, and its `unusable` share FELL from 21% to 16% because it had learnt
   * to emit valid JSON. Every headline on the page improved.
   *
   * Promoting it would have been the expensive mistake, not the wasted night: rounds chain from
   * whatever is serving, so a collapsed adapter becomes the starting weights for every round after
   * it. A bad round costs one round only if it is not promoted.
   *
   * Absent is not refused. A round measured before this existed carries no collapse figure, and
   * refusing those would lock out every earlier round on a number nobody took.
   */
  const c = r.result.collapse;
  if (c && typeof c.ratio === 'number' && c.ratio > MAX_COLLAPSE) {
    return {
      error: `it collapsed onto ${c.tool}: said on ${c.said_pct}% of the exam, correct on ${c.correct_pct}% `
        + `(${c.ratio}x, and anything over ${MAX_COLLAPSE}x is guessing rather than reading)`,
    };
  }
  /* A PAPER TOO SMALL TO MEAN ANYTHING. A platform with four exam turns can score 100% by luck;
     nothing is promoted on fewer than MIN_PAPER. Absent is not refused (older rounds). */
  const paper = Number(r.result.turns);
  if (Number.isFinite(paper) && paper > 0 && paper < MIN_PAPER) {
    return { error: `its paper held only ${paper} turn(s) — ${MIN_PAPER} are needed before a score means anything` };
  }
  r.promoted = true;
  writeJson(ROUNDS(), rows);
  /*
   * THE PROMOTION MAP. One entry per scope (platforms.js): base, each platform, each role. The
   * base entry is also written at the top level, the shape everything read before the map
   * existed, so nothing that asks "what serves" has to learn a new answer.
   */
  const scope = normScope(r.scope || 'base');
  const entry = {
    roundId: r.id,
    adapter: r.adapter || '',
    base: r.base,
    agreement: r.result.agreement_pct,
    beat: r.baseline.agreement_pct,
    paper: Number.isFinite(paper) ? paper : null,
    promotedAt: new Date().toISOString(),
    device: r.device,
    scope,
  };
  const cur = readJson(CURRENT(), null) || {};
  const scopes = { ...(cur.scopes || {}), [scope.key]: entry };
  writeJson(CURRENT(), scope.key === 'base' ? { ...cur, ...entry, scopes } : { ...cur, scopes });
  return { promoted: r.id, scope: scope.key };
}

const MIN_PAPER = 30;

const current = () => readJson(CURRENT(), null);

/**
 * THE ADAPTER A SCOPE CHAINS FROM: its own, else its parent's, else base's, else nothing. A role
 * round starts from the platform adapter when there is one, so it learns the job on top of the
 * platform's habits instead of relearning the platform.
 */
function adapterFor(scope) {
  const cur = current();
  const map = (cur && cur.scopes) || {};
  let s = normScope(scope || 'base');
  for (let guard = 0; s && guard < 4; guard++) {
    const e = map[s.key] || (s.key === 'base' && cur && cur.adapter ? cur : null);
    if (e && e.adapter) return { adapter: e.adapter, from: s.key, roundId: e.roundId || '' };
    s = platforms.parentOf(s);
  }
  return { adapter: '', from: '', roundId: '' };
}

/* ── the owner's switch ──────────────────────────────────────────────────────────────────────── */

const AUTO = () => path.join(DIR(), 'auto.json');

/**
 * Whether rounds may start on their own.
 *
 * Defaults to ON, because a loop that has to be switched on after every restart is not a loop. It
 * is stored rather than held in memory for the same reason: a pod restart must not silently turn
 * the training off and leave the machines idle with nothing saying why.
 */
const autoOn = () => {
  const v = readJson(AUTO(), null);
  return v === null ? true : !!v.on;
};

const setAuto = (on) => { writeJson(AUTO(), { on: !!on, at: new Date().toISOString() }); return !!on; };

/* ── which machines the owner allows to train ────────────────────────────────────────────────── */

const TRAINERS = () => path.join(DIR(), 'trainers.json');

/**
 * ABLE AND ALLOWED ARE DIFFERENT QUESTIONS, AND ONLY ONE OF THEM LIVES HERE.
 *
 * Whether a machine CAN train — a drive with room, a virtual environment, the model cached — is
 * known only to the machine, and it reports that in its capabilities. Whether it MAY train is the
 * owner's decision, and it is stored here.
 *
 * Conflating them gives one of two bad outcomes: a laptop that starts grinding all night because it
 * happened to have disk space, or a laptop that is fully set up and never chosen because nothing
 * ever recorded that it was wanted. Default OFF for exactly the first reason — a machine joining
 * the ring must not quietly enlist itself.
 */
const trainerOn = (deviceId) => {
  const all = readJson(TRAINERS(), {}) || {};
  return !!(all[String(deviceId)] && all[String(deviceId)].on);
};

function setTrainer(deviceId, on) {
  const all = readJson(TRAINERS(), {}) || {};
  all[String(deviceId)] = { on: !!on, at: new Date().toISOString() };
  writeJson(TRAINERS(), all);
  return !!on;
}

const trainerList = () => readJson(TRAINERS(), {}) || {};

/* ── the view ───────────────────────────────────────────────────────────────────────────────── */

/**
 * WHAT EACH DEVICE IS DOING, KEYED BY THE NAME THE DEVICE HUB ALREADY USES.
 *
 * A training round is work, and work belongs on the row of the device doing it — the same place a
 * goal run shows up. Without this the hub would say a laptop is "online, idle" while it is four
 * hours into a round, which is worse than saying nothing: it invites somebody to close the lid.
 *
 * Returned as a map so a screen can look a device up by name instead of scanning the round list and
 * re-deriving the answer, which is how two screens end up disagreeing about the same fact.
 */
const SILENT_MS = 75 * 60 * 1000;   // the same figure the planner uses, so the row and the decision agree

function byDevice(now = Date.now()) {
  const out = {};
  for (const r of allRounds()) {
    /* Rounds are stored newest-first, so the first one seen for a device is simply its latest.
     *
     * The tempting rule — let a `running` round outrank a finished one — is a trap. A round only
     * becomes `done` because the device called endRound, so a round killed by a closed lid, a lost
     * connection or a crash stays `running` for ever. Under that rule one dead round from weeks ago
     * would permanently mask every real round after it on this device's row. Newest wins, and
     * staleness is reported rather than ranked on. */
    if (out[r.device]) continue;
    const lines = r.lines || [];
    const last = lines.length ? lines[lines.length - 1] : null;

    /* A round that claims to be running and has said nothing for half an hour is the honest
     * definition of a round nobody should still be waiting for. Saying "training" next to a device
     * that died overnight is worse than saying nothing: it is the one thing this screen exists to
     * prevent. The thirty minutes is generous on purpose — a slow CPU deep in an epoch is normal. */
    const heard = Date.parse((last && last.at) || r.startedAt) || 0;
    const stale = r.status === 'running' && heard > 0 && (now - heard) > SILENT_MS;

    out[r.device] = {
      roundId: r.id,
      scope: r.scope || null,
      status: r.status,
      stale,
      silentForMin: r.status === 'running' && heard ? Math.floor((now - heard) / 60000) : null,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      turns: r.turns,
      promoted: r.promoted,
      /* The most recent thing the device said about itself, which is the whole point of the row. */
      last,
      baseline: r.baseline ? r.baseline.agreement_pct : null,
      result: r.result ? r.result.agreement_pct : null,
      /* The two numbers beside the headline that say whether it means anything: the tool AND its
         arguments, and how far the loudest answer is from how often it is right. */
      args: r.result && r.result.args_agreement_pct != null ? r.result.args_agreement_pct : null,
      baselineArgs: r.baseline && r.baseline.args_agreement_pct != null ? r.baseline.args_agreement_pct : null,
      collapseTool: r.result && r.result.collapse ? String(r.result.collapse.tool || '') : '',
      unusable: r.result && r.result.unusable_pct != null ? r.result.unusable_pct : null,
      perTool: r.result && r.result.per_tool ? Object.entries(r.result.per_tool).slice(0, 24).map(([tool, v]) => ({ tool, right: v.right, seen: v.seen, pct: v.pct })) : [],
      /* How lopsided its answers were. A round can beat its baseline and still be a model that
         says one tool to everything, and that has to be readable without opening a table. */
      collapse: (r.result && r.result.collapse) || null,
    };
  }
  return out;
}

/**
 * Everything the settings screen shows, in one answer.
 *
 * `newSinceLastRound` is the number that decides whether tonight is worth running at all: a round
 * over the same data produces the same adapter and costs a night of somebody's laptop.
 */
function state({ corpus, manifest, preflight, trainers } = {}) {
  const rounds = allRounds();
  const work = byDevice();
  /*
   * "Since the last round" means since the last round STARTED, not since it finished. A round trains
   * on the data as it stood when it began, so work recorded while it ran has not been learnt from
   * yet and must still count towards the next one.
   */
  const last = rounds.find((r) => r.status === 'done') || rounds[0] || null;

  const c = corpus || {};
  const tiers = c.tiers || { gold: 0, silver: 0, bronze: 0, void: 0 };
  const fresh = last ? corpusLib.usableSince(c.ids, last.startedAt) : 0;

  return {
    corpus: {
      jobsWithVerdict: Object.values(tiers).reduce((a, b) => a + b, 0),
      tiers,
      unjudged: c.unjudged || 0,
      jobs: c.jobs || 0,
      /* The history is read in slices, so early on this number is still climbing. Saying so is the
         difference between a screen that is filling in and a screen that is simply wrong. */
      scanning: !!c.scanning,
      pending: c.pending || 0,
      usableSinceLastRound: fresh,
      /* Below this a round is not worth a night of somebody's machine — the adapter would barely
         move and the measurement could not tell the difference from noise. */
      enoughForARound: fresh >= 200 || !last,
    },
    dataset: manifest ? {
      builtAt: manifest.builtAt,
      turns: manifest.turns,
      tiers: manifest.tiers,
      dropped: manifest.droppedTurns || {},
      /* The counts the planner gates on (turnsWithContent, indexTurns...). Null on a manifest
         built before anyone counted - the screen must not read that as zero. */
      marks: manifest.marks || null,
    } : null,
    preflight: preflight || null,
    serving: current(),
    rounds: rounds.slice(0, 20).map((r) => ({
      id: r.id, startedAt: r.startedAt, endedAt: r.endedAt, device: r.device, status: r.status,
      scope: r.scope || null,
      turns: r.turns, promoted: r.promoted, why: r.why,
      /* What it trained, and when it last spoke — the two things the planner decides on. */
      trained: r.trained || 0,
      lastAt: (r.lines && r.lines.length) ? r.lines[r.lines.length - 1].at : r.startedAt,
      baseline: r.baseline ? r.baseline.agreement_pct : null,
      result: r.result ? r.result.agreement_pct : null,
      /*
       * ALL of them for the round that is RUNNING, six for the ones that are over.
       *
       * This sent six for every round, and the screen could therefore never show more than six -
       * so the shape of a round, a loss falling or wandering, an adapter checkpointed every half
       * hour, was invisible on the one surface built to show it. Forty lines were being kept and
       * thirty-four thrown away on the way out.
       *
       * Only the live round gets the full set, because that is the only one anybody watches line by
       * line, and twenty finished rounds at forty lines each is a payload nobody reads.
       */
      /* The recipe and the validation curve: what it trained with, and whether it was still
         learning when it stopped. The curve is sent whole - its shape is the point. */
      recipe: r.recipe || null,
      validation: r.validation || [],
      bestValLoss: r.bestValLoss == null ? null : r.bestValLoss,
      bestAtTurns: r.bestAtTurns || 0,
      lines: (r.lines || []).slice(r.status === 'running' ? -60 : -6),
    })),
    /*
     * The trainers carry their own round with them, so the device hub renders a row straight from
     * this without joining two lists itself. Same numbers as the pipeline screen, by construction.
     */
    /*
     * Each machine carries BOTH answers plus, when it cannot train, what it is missing. A row that
     * merely fails to appear teaches nobody anything; "could train, needs 4 GB free on D:" is a
     * thing somebody can act on.
     */
    trainers: (trainers || []).map((t) => ({
      ...t,
      allowed: trainerOn(t.deviceId),
      training: work[t.name] || null,
    })),
    byDevice: work,
    /* The switch, and how much of the set has been learned from so far — the two numbers that say
       whether this loop is running itself or waiting for somebody. */
    auto: autoOn(),
    covered: rounds.reduce((n, r) => n + (Number(r.trained) || 0), 0),
  };
}

module.exports = { MAX_COLLAPSE, MIN_PAPER, startRound, noteRound, checkRound, setAdapter, endRound, promote, current, adapterFor, allRounds, state, byDevice, autoOn, setAuto, trainerOn, setTrainer, trainerList, setPending, peekPending, takePending, scopeOfRound, DIR };
