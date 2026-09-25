/*
 * trainingPlan.js — WHETHER TO START A ROUND RIGHT NOW, AND ON WHICH MACHINE.
 *
 * Every round so far was started by hand. That was fine while the pipeline was being built and is
 * useless as a system: the whole point was a loop that improves the model without anybody driving
 * it, and a loop that needs a person to type the command is a person, not a loop.
 *
 * So this is the decision, written once, as a pure function of what is known. It is deliberately
 * not a scheduler: nothing here knows the time of day, because "train at 2am" is the wrong rule
 * for a ring of machines in unknown places. The rule is "train when there is something to learn and
 * a machine free to learn it", which is true at any hour.
 *
 * THERE ARE TWO REASONS TO RUN A ROUND, AND ONLY ONE OF THEM IS OBVIOUS.
 *
 *   NEW DATA ARRIVED.  The nightly-learning case: enough runs have been recorded since the last
 *                      round that the model would learn something it has not seen.
 *   THE CORPUS IS NOT COVERED YET.  The catch-up case, and the one that actually matters today. The
 *                      set holds 23,233 turns and the first round reached 685 of them. Waiting for
 *                      "200 new runs" before running the second round would leave 98% of what we
 *                      already have unlearned, for ever, while the gate reported everything fine.
 *
 * Missing the second reason is how a pipeline ends up technically working and practically idle.
 */
'use strict';

/** Below this, a round is not worth a machine: the adapter barely moves and the measurement cannot
 *  tell the difference from noise. Only applies once the corpus has been covered. */
const ENOUGH_NEW = 200;

/** A round that has said nothing for this long is not holding the slot any more. Matches the
 *  staleness rule the device rows use, so the screen and the scheduler never disagree. */
/*
 * Seventy-five minutes, not thirty. A CPU round spends its first hour in the exam, and the exam
 * reported every 25 turns at ~25 s a turn - ten minutes apart when the machine is free and half an
 * hour when it is not. Thirty minutes read a live round as dead and started a second one on the
 * same laptop, and the two halved each other. The exam now reports every ten turns as well.
 */
const SILENT_MS = 75 * 60 * 1000;

/* A machine whose rounds failed this many times within REST_WINDOW_MS rests for REST_MS. */
const CRASHES_TO_REST = 2;
const REST_WINDOW_MS = 60 * 60 * 1000;
const REST_MS = 60 * 60 * 1000;

/* How many machines may train one scope at once, each on its own half of the slice. */
const PAIR = 2;

/** Devices (lower-case names) that should not be handed a round right now, with why. */
function restingDevices(rounds, now = Date.now()) {
  const byDevice = new Map();
  for (const r of rounds || []) {
    if (r.status !== 'failed') continue;
    const at = Date.parse(r.endedAt || r.startedAt || '') || 0;
    if (!at || now - at > REST_WINDOW_MS) continue;
    const k = String(r.device || '').toLowerCase();
    if (!k) continue;
    const row = byDevice.get(k) || { n: 0, last: 0 };
    row.n++; row.last = Math.max(row.last, at);
    byDevice.set(k, row);
  }
  const out = new Map();
  for (const [k, row] of byDevice) {
    if (row.n >= CRASHES_TO_REST && now - row.last < REST_MS) {
      out.set(k, `${row.n} rounds failed on it in the last hour — resting until ${new Date(row.last + REST_MS).toISOString().slice(11, 16)} UTC`);
    }
  }
  return out;
}

/**
 * How much of the set has actually been trained on, across every round that reported it.
 *
 * Summed from what each round SAYS IT TRAINED, not from what was available to it. Those are wildly
 * different numbers — a round with 23,233 turns available reached 685 — and confusing them would
 * report the corpus as covered after the first night.
 */
function covered(rounds) {
  let n = 0;
  for (const r of rounds || []) n += Number(r.trained) || 0;
  return n;
}

/**
 * Decide.
 *
 * @param corpus    the tally: usableSinceLastRound, scanning, pending
 * @param dataset   the built set's manifest turns, or null when no set exists yet
 * @param rounds    every round, newest first
 * @param trainers  devices advertising that they can train
 * @param auto      the owner's switch. Off means off — no rule below overrides it.
 * @param serving   the adapter currently in service, to carry on from
 */
/** How many merge rounds may die on one batch before its scope is opened again. */
const MERGE_TRIES = 3;

function decide({ corpus = {}, dataset = null, rounds = [], trainers = [], auto = true, serving = null, sighted = null, sliceTurns = 0, readiness = null, scopes = null, share = PAIR, pending = [], learned = null, now = Date.now() } = {}) {
  const no = (why) => ({ run: false, why });

  /* The owner's switch comes first and is absolute. A machine that decides to train anyway because
     it judged the reasons good is a machine nobody leaves running. */
  if (!auto) return no('automatic rounds are switched off');

  /*
   * A round that is already going holds the slot — unless it has gone silent, in which case it is
   * almost certainly a closed lid or a crash and its slot should not be held for ever. Three rounds
   * died with SIGSEGV while this was being built; without this clause the first one would have
   * blocked every round after it, permanently, and the screen would have read "training".
   */
  /*
   * A RUNNING ROUND HOLDS ITS MACHINE AND ITS SCOPE, NOT THE LOOP. With the scopes measured, a
   * second laptop takes the next scope in the map while the first trains base - two machines, two
   * adapters, never the same scope twice at once and never two rounds on one machine. Without
   * scopes (the older callers) one round at a time is still the rule.
   */
  const alive = (rounds || []).filter((r) => {
    if (r.status !== 'running') return false;
    const heard = Date.parse((r.lastAt || r.startedAt) || '') || 0;
    return heard && (now - heard) < SILENT_MS;
  });
  /*
   * A DISPATCH NOBODY HAS REGISTERED YET IS A LIVE ROUND TOO. The laptop fetches scripts and a
   * slice before it registers - a minute or two - and in that minute the planner saw the machine
   * as free and handed it a second round. The pending dispatches (one per machine) hold their
   * machine and their scope exactly like a running round, batch id and all.
   */
  const started = new Set(alive.map((r) => String(r.device || '').toLowerCase()));
  for (const p of pending || []) {
    if (!p || !p.device || started.has(String(p.device).toLowerCase())) continue;
    alive.push({ id: p.batch || `pending:${p.device}`, device: p.device, scope: p.scope, batch: p.batch || '', merge: !!p.merge, pending: true });
  }
  const busyDevices = new Set(alive.map((r) => String(r.device || '').toLowerCase()));
  /*
   * TWO MACHINES, ONE SCOPE. A scope with one live round is not busy: a second free machine
   * takes the other half of its slice (the ledger keeps the halves disjoint) and the two adapters
   * are merged when both are in. Only a scope already worked by PAIR machines is closed.
   */
  const liveOn = {};
  for (const r of alive) { const k = (r.scope && r.scope.key) || 'base'; liveOn[k] = (liveOn[k] || 0) + 1; }
  const busyScopes = new Set(Object.keys(liveOn).filter((k) => liveOn[k] >= Math.max(1, Number(share) || 1)));
  /*
   * A BATCH IS CLOSED ONCE IT HAS ITS MACHINES. A share that finishes early frees its machine,
   * and with one live round left on the scope the count above would call the scope open and hand
   * the free machine a THIRD share of the same batch - another round before the merge could
   * start. A batch made for N machines is full at N members, running, done or pending; its scope
   * stays busy until the merge has run. A merge round, running or pending, holds its scope too:
   * the next batch on that scope starts from the merged adapter, not beside it.
   */
  const membersOf = (batch) => {
    const ids = new Set((rounds || []).filter((x) => (x.batch === batch || x.id === batch) && !x.merge).map((x) => x.id));
    for (const p of pending || []) if (p && p.batch === batch && !p.merge && !ids.has(`pending:${p.device}`)) ids.add(`pending:${String(p.device || '').toLowerCase()}`);
    return ids.size;
  };
  const shareOf = (batch) => {
    const got = Math.max(0, ...(rounds || []).filter((x) => (x.batch === batch || x.id === batch) && !x.merge).map((x) => Number(x.share) || 0), ...(pending || []).filter((p) => p && p.batch === batch).map((p) => Number(p.share) || 0));
    return got > 0 ? got : Math.max(1, Number(share) || 1);
  };
  for (const r of alive) {
    const k = (r.scope && r.scope.key) || 'base';
    if (r.merge) { busyScopes.add(k); continue; }
    if (r.batch && membersOf(r.batch) >= shareOf(r.batch)) busyScopes.add(k);
  }
  /* A batch whose shares are all in and not merged yet: its scope waits for the merge. */
  for (const r of rounds || []) {
    if (!r.batch || r.merge || r.status !== 'done' || !r.adapterHub || r.mergedInto === 'abandoned') continue;
    const merges = (rounds || []).filter((x) => x.merge && x.batch === r.batch);
    const merged = merges.some((x) => x.status === 'done');
    /* Three merges that died free the scope: better a fresh batch than a scope held for ever. */
    const givenUp = merges.filter((x) => x.status === 'failed' || x.status === 'stopped').length >= MERGE_TRIES;
    if (!merged && !givenUp) busyScopes.add((r.scope && r.scope.key) || 'base');
  }
  /* The batch a new round on this scope joins: the live round's batch, which is its own id when it started one. */
  const batchFor = (key) => { const r = alive.find((x) => ((x.scope && x.scope.key) || 'base') === key); return r ? (r.batch || r.id) : ''; };
  const withScopes = Array.isArray(scopes) && scopes.length > 0;
  if (alive.length && !withScopes) return no(`a round is already running on ${alive[0].device || 'a device'}`);

  const resting = restingDevices(rounds, now);
  const free = (trainers || []).filter((t) => t.online && !busyDevices.has(String(t.name || '').toLowerCase()) && !resting.has(String(t.name || '').toLowerCase()));
  if (!(trainers || []).some((t) => t.online)) return no('no machine is connected that can train');
  if (!free.length) {
    const why = [
      ...alive.map((r) => `${(r.scope && r.scope.key) || 'base'} on ${r.device}`),
      ...[...resting].filter(([k]) => (trainers || []).some((t) => t.online && String(t.name || '').toLowerCase() === k)).map(([k, w]) => `${k}: ${w}`),
    ];
    return no(`every machine that can train is busy or resting: ${why.join('; ')}`);
  }

  if (!dataset || !dataset.train) return no('no training set has been built yet');

  /* Never decide on a partial count. The corpus is read in slices, so early on the numbers are
     still climbing and "not enough new data" would be a statement about the scan, not the data. */
  if (corpus.scanning) return no(`still reading the history — ${corpus.pending || 0} job(s) to go`);

  /*
   * NO ROUND UNTIL THE SET CAN SEE ITS OWN PAGES.
   *
   * Two rounds trained on a set where 58% of the turns followed a read whose content was never
   * recorded, and both collapsed onto `look`. The turns are not bad; they are blind, and a
   * model cannot learn open(url) from "read the page (14592 characters)". The builder now
   * counts the turns whose latest observation carries the page, and a round waits until there
   * are at least a slice's worth of them - otherwise the draw fills up with the blind ones and
   * twelve hours of CPU produce the same collapse a third time.
   *
   * A manifest built before this was counted reports nothing, and nothing is not zero: an old
   * manifest must not lock the loop shut on a number nobody took.
   */
  if (typeof sighted === 'number' && sliceTurns > 0 && sighted < sliceTurns) {
    return no(`only ${sighted} turn(s) in the set can see the page they decide on, and a round draws ${sliceTurns} — collecting`);
  }

  /*
   * THE SIX CHECKS, when the caller took them (readiness.js). The sighted gate above is one of
   * them and stays as the older callers know it; the others - labels, an exam that leaked into
   * the train set, freshness once something serves - refuse here in their own words.
   */
  if (readiness && readiness.ok === false) return no(readiness.why || 'the set is not ready');

  /* Learned turns when the caller counted them (learned.js); the old sum of what rounds trained on otherwise. */
  const seen = typeof learned === 'number' ? learned : covered(rounds);
  const total = Number(dataset.train) || 0;
  const fresh = Number(corpus.usableSinceLastRound) || 0;

  const device = free[0];
  const go = (why, scope = null) => ({
    run: true,
    why,
    device: device.name,
    deviceId: device.deviceId,
    /* Carry on from what is SERVING, not from the last round that finished. A round that made the
       model worse is not promoted, and chaining from it anyway would push that damage into every
       round after it. Starting from the serving adapter costs a bad round exactly one round. */
    base: scope ? (scope.adapter || scope.warmStart || scope.parentAdapter || '') : ((serving && serving.adapter) || ''),
    coverage: scope ? { seen: scope.seen || 0, total: scope.sighted || 0 } : { seen, total },
    scope: scope ? { level: scope.level, name: scope.name || '', key: scope.key } : null,
    /* The live round this one pairs with on the same scope, when there is one. */
    batch: scope ? batchFor(scope.key) : '',
    /* How many machines share this scope's batch, counting this one. */
    share: Math.max(1, Number(share) || 1),
  });

  /*
   * WHICH SCOPE, when the caller measured them (platforms.js): base until base has an adapter,
   * then a platform or a role that holds a slice of sighted turns and has no adapter of its own,
   * then whichever has the most untrained turns. A scope is chained from its own serving adapter,
   * else its parent's, so a bad platform round costs the platform one round and base nothing.
   */
  if (withScopes) {
    /*
     * BASE FIRST, ALWAYS. Nothing else is trained until base has an adapter: a platform or a
     * role adapter chains from base, and one trained before base exists chains from nothing. When
     * every machine allowed on base is already on it, a further machine waits for it rather than
     * starting a platform on the bare model.
     */
    const baseRow = scopes.find((s) => s.key === 'base');
    if (baseRow && !baseRow.adapter && ((Number(baseRow.sighted) || 0) - (Number(baseRow.seen) || 0)) > 0 && busyScopes.has('base')) {
      return no('base is being trained — a platform or a role round waits until base has an adapter');
    }
    const p = pickScope(scopes.filter((s) => !busyScopes.has(s.key)), sliceTurns);
    if (p.pick) return go(p.why, p.pick);
    if (alive.length) return no(`${alive.map((r) => `${(r.scope && r.scope.key) || 'base'} on ${r.device}`).join(', ')} running — nothing else holds a slice of its own yet`);
    if (fresh >= ENOUGH_NEW) return go(`${fresh} new usable run(s) since the last round`, scopes.find((s) => s.key === 'base') || null);
    return no(`every scope is covered and only ${fresh} new usable run(s) have arrived — a round wants ${ENOUGH_NEW}`);
  }

  if (total > 0 && seen < total) {
    return go(`${total - seen} of ${total} turns in the set have not been trained on yet`);
  }
  if (fresh >= ENOUGH_NEW) {
    return go(`${fresh} new usable run(s) since the last round`);
  }
  return no(`the set is covered and only ${fresh} new usable run(s) have arrived — a round wants ${ENOUGH_NEW}`);
}

/** Turns trained on within one scope, summed from what each round of it said it trained. */
function coveredFor(rounds, key = 'base') {
  let n = 0;
  for (const r of rounds || []) {
    const k = (r.scope && r.scope.key) || 'base';
    if (k === key) n += Number(r.trained) || 0;
  }
  return n;
}

const label = (s) => (s.key === 'base' ? 'base' : `${s.name} (${s.level})`);

/**
 * The scope the next round trains. Pure; `scopes` rows carry sighted, seen, adapter, parentAdapter.
 * @returns {{ pick: object|null, why: string }}
 */
function pickScope(scopes, sliceTurns = 0) {
  const rows = (scopes || []).map((s) => ({ ...s, untrained: Math.max(0, (Number(s.sighted) || 0) - (Number(s.seen) || 0)) }));
  const base = rows.find((s) => s.key === 'base');
  /*
   * BASE FIRST, ALWAYS. Nothing else is trained until base has an adapter: a platform or a role
   * adapter chains from base, and one trained before base exists chains from nothing. When base
   * is being trained on every machine allowed to share it, a further machine waits for it rather
   * than starting a platform on the bare model.
   */
  if (base && !base.adapter && base.untrained > 0) {
    return { pick: base, why: `base: ${base.untrained} of ${base.sighted} sighted turns not trained on yet, and nothing serves yet` };
  }
  const stand = rows.filter((s) => s.key !== 'base' && (Number(s.sighted) || 0) >= Math.max(1, sliceTurns));
  const rank = (s) => (s.level === 'platform' ? 0 : 1);
  const fresh = stand.filter((s) => !s.adapter && s.untrained > 0).sort((a, b) => rank(a) - rank(b) || b.sighted - a.sighted);
  if (fresh.length) return { pick: fresh[0], why: `${label(fresh[0])}: ${fresh[0].sighted} sighted turns and no adapter of its own yet` };
  const any = [base, ...stand].filter(Boolean).filter((s) => s.untrained > 0).sort((a, b) => b.untrained - a.untrained);
  if (any.length) return { pick: any[0], why: `${label(any[0])}: ${any[0].untrained} of ${any[0].sighted} sighted turns not trained on yet` };
  return { pick: null, why: 'every scope is covered' };
}

module.exports = { MERGE_TRIES, decide, covered, coveredFor, pickScope, restingDevices, ENOUGH_NEW, SILENT_MS, CRASHES_TO_REST, REST_MS, PAIR };
