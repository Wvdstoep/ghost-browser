/*
 * readiness.js — IS THE DATA READY TO TRAIN ON? SIX NUMBERS, EACH WITH ITS THRESHOLD.
 *
 * "Ready" used to be a switch somebody flipped plus one gate on sighted turns. This is the measured
 * version: six checks, each a value against a threshold with the sentence a person would say about
 * it, and one score that is the weakest of them. The planner reads the same object the screen
 * shows, and the collector reads the same object to decide what to aim at - so the three can never
 * disagree about whether tonight is worth a machine, or why not.
 *
 * TWO KINDS OF CHECK. A GATING check stops a round: training on blind turns collapses the model
 * (measured twice), an exam that overlaps the train set measures nothing, and a corpus with nothing
 * new since the serving adapter reproduces it. An ADVISORY check does not stop the first round -
 * a set with no `hover` examples still teaches `open` - but it names the tools the collector should
 * go after, and it will stop a round once a model is serving, because from then on the point of a
 * round is to widen what the model can do rather than to have one at all.
 *
 * Pure. Everything it reads is handed in.
 */
'use strict';

/** A rare tool needs this many sighted examples to be learnable at all; a common one this many. */
const FLOOR = 4;
const TOP_FLOOR = 50;
/** No single tool may be more than this share of the sighted turns. */
const MAX_SHARE = 0.25;
/** Gold (externally verified) share of the sighted turns, and the bronze ceiling. */
const MIN_GOLD = 0.4;
const MAX_BRONZE = 0.15;
/** New usable runs a round wants once the set has been covered. */
const ENOUGH_NEW = 200;

const pct = (a, b) => (b > 0 ? Math.min(100, Math.round((100 * a) / b)) : 0);

/**
 * @param coverage  the scan of the train set: { total, sighted, perTool: {tool: {all, sighted, gold}}, sightedTiers }
 * @param exam      { overlap } - exam jobs also in the train set
 * @param catalogue tool names the role may use; empty means "the tools the set has seen"
 * @param sliceTurns what one round draws
 * @param corpus    { usableSinceLastRound }
 * @param serving   the adapter in service, or null before the first promotion
 */
function scoreOf({
  /* Turns the model has not learned yet. While there are any, a thin catalogue is a warning:
     the round in front of us still has something to teach, and rare tools are the collector's job. */
  workLeft = 0, coverage = null, exam = null, catalogue = [], sliceTurns = 440, corpus = {}, serving = null } = {}) {
  const cov = coverage || { total: 0, sighted: 0, perTool: {}, sightedTiers: {} };
  const perTool = cov.perTool || {};
  const sighted = Number(cov.sighted) || 0;
  const checks = [];
  const push = (c) => { checks.push(c); return c; };

  /* 1. SIGHT — the gate that two collapsed rounds earned. */
  push({
    name: 'sight', gate: true, value: sighted, threshold: sliceTurns, ok: sighted >= sliceTurns,
    score: pct(sighted, sliceTurns),
    text: sighted >= sliceTurns
      ? `${sighted} turns can see the page they decide on — a round draws ${sliceTurns}`
      : `only ${sighted} turn(s) can see the page they decide on, and a round draws ${sliceTurns} — collecting`,
  });

  /* 2. COVERAGE — every tool learnable, the common ten well covered. Advisory until something serves. */
  const names = (catalogue && catalogue.length ? catalogue : Object.keys(perTool)).filter((n) => n && n !== '?');
  const thin = names.filter((n) => ((perTool[n] || {}).sighted || 0) < FLOOR)
    .sort((a, b) => ((perTool[a] || {}).sighted || 0) - ((perTool[b] || {}).sighted || 0));
  const top = Object.entries(perTool).sort((a, b) => b[1].all - a[1].all).slice(0, 10).map(([n]) => n);
  const topThin = top.filter((n) => (perTool[n].sighted || 0) < TOP_FLOOR);
  const covered = names.length - thin.length;
  push({
    name: 'coverage', gate: !!serving && !workLeft, value: covered, threshold: names.length, ok: thin.length === 0 && topThin.length === 0,
    score: names.length ? Math.round((100 * covered) / names.length) : 0,
    aim: [...new Set([...thin, ...topThin])].slice(0, 12),
    text: thin.length === 0 && topThin.length === 0
      ? `every tool has at least ${FLOOR} sighted examples and the common ten at least ${TOP_FLOOR}`
      : `${thin.length} tool(s) have fewer than ${FLOOR} sighted examples${topThin.length ? `, and ${topThin.length} of the common ten fewer than ${TOP_FLOOR}` : ''} — aiming the collector at ${[...thin, ...topThin].slice(0, 4).join(', ') || 'them'}${workLeft ? ` (a warning, not a stop: ${workLeft} turn(s) are still unlearned)` : ''}`,
  });

  /* 3. BALANCE — the loudest tool must not own the slice. Advisory for the same reason. */
  let loud = null;
  for (const [n, v] of Object.entries(perTool)) if (!loud || v.sighted > loud.sighted) loud = { tool: n, sighted: v.sighted };
  const share = loud && sighted ? loud.sighted / sighted : 0;
  push({
    name: 'balance', gate: !!serving, value: Math.round(100 * share), threshold: Math.round(100 * MAX_SHARE), ok: share <= MAX_SHARE,
    score: share <= MAX_SHARE ? 100 : Math.round((100 * MAX_SHARE) / share),
    text: !loud ? 'nothing sighted yet'
      : share <= MAX_SHARE ? `the loudest tool (${loud.tool}) is ${Math.round(100 * share)}% of the sighted turns`
      : `${loud.tool} is ${Math.round(100 * share)}% of the sighted turns — over ${Math.round(100 * MAX_SHARE)}%, the sampler will cap it`,
  });

  /* 4. LABELS — most of what is sighted must be externally verified. Gating: silver is the model's
     own word, and a set that is mostly its own word trains a model to believe itself. */
  const st = cov.sightedTiers || {};
  const gold = Number(st.gold) || 0;
  const bronze = Number(st.bronze) || 0;
  const goldShare = sighted ? gold / sighted : 0;
  const bronzeShare = sighted ? bronze / sighted : 0;
  const labelsOk = sighted === 0 ? false : goldShare >= MIN_GOLD && bronzeShare <= MAX_BRONZE;
  push({
    name: 'labels', gate: true, value: Math.round(100 * goldShare), threshold: Math.round(100 * MIN_GOLD), ok: labelsOk,
    score: sighted === 0 ? 0 : Math.min(pct(goldShare, MIN_GOLD), bronzeShare <= MAX_BRONZE ? 100 : Math.round((100 * MAX_BRONZE) / bronzeShare)),
    text: sighted === 0 ? 'nothing sighted to judge'
      : labelsOk ? `${Math.round(100 * goldShare)}% of the sighted turns are externally verified (gold)`
      : goldShare < MIN_GOLD ? `only ${Math.round(100 * goldShare)}% of the sighted turns are gold — a round wants ${Math.round(100 * MIN_GOLD)}%`
      : `${Math.round(100 * bronzeShare)}% of the sighted turns are bronze — over the ${Math.round(100 * MAX_BRONZE)}% ceiling`,
  });

  /* 5. FRESHNESS — once something serves, a round needs new work or uncovered turns. */
  const fresh = Number((corpus || {}).usableSinceLastRound) || 0;
  const coverageCheck = checks.find((c) => c.name === 'coverage');
  const freshOk = !serving || fresh >= ENOUGH_NEW || !coverageCheck.ok;
  push({
    name: 'freshness', gate: true, value: fresh, threshold: ENOUGH_NEW, ok: freshOk,
    score: !serving ? 100 : freshOk ? 100 : pct(fresh, ENOUGH_NEW),
    text: !serving ? 'nothing is serving yet — the first round needs no new runs'
      : freshOk ? `${fresh} new usable run(s) since the serving round`
      : `only ${fresh} new usable run(s) since the serving round — a round wants ${ENOUGH_NEW}`,
  });

  /* 6. EXAM INTEGRITY — an exam that overlaps the train set measures memory, not skill. */
  const ov = exam ? Number(exam.overlap) || 0 : null;
  push({
    name: 'exam', gate: true, value: ov == null ? 0 : ov, threshold: 0, ok: ov === 0 || ov == null,
    score: ov ? 0 : 100,
    text: ov == null ? 'no exam split to check' : ov === 0 ? 'no exam job appears in the train set' : `${ov} exam job(s) also appear in the train set — the score would be memory, not skill`,
  });

  const gates = checks.filter((c) => c.gate);
  const failing = gates.find((c) => !c.ok);
  const score = Math.min(...checks.map((c) => c.score));
  return {
    ok: !failing,
    score: Number.isFinite(score) ? score : 0,
    why: failing ? failing.text : 'the set is ready to train on',
    aim: coverageCheck.aim || [],
    checks,
  };
}

module.exports = { scoreOf, FLOOR, TOP_FLOOR, MAX_SHARE, MIN_GOLD, MAX_BRONZE, ENOUGH_NEW };
