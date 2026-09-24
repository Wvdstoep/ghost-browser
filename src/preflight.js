/*
 * preflight.js — THE SET IS CHECKED BEFORE A ROUND TRAINS ON IT.
 *
 * The loop is meant to improve by itself, which means nobody will be reading the numbers. Today two
 * of my own filters were quietly too aggressive and both were caught only because I happened to be
 * looking: one condemned 319 good jobs, the other discarded every job's opening move. A nightly
 * round has no one looking. So the numbers have to read themselves, and a round that cannot trust
 * its set must refuse to train rather than train on it anyway.
 *
 * Every check here exists because something real would have tripped it. None of them are hypothetical.
 *
 * TWO JUDGEMENT CALLS, stated so they can be argued with:
 *
 *   - A LARGE SHRINK HALTS RATHER THAN WARNS. A legitimate drop that big should be deliberate — a
 *     new filter, a changed cap — and deliberate means somebody confirms it once. Halting costs one
 *     night; not halting costs a model quietly trained on a thinned set, discovered weeks later.
 *   - IT COMPARES AGAINST THE PREVIOUS ROUND, NOT A FIXED FLOOR. A fixed number goes stale the
 *     moment the corpus grows, and this corpus grows every day. Last night's manifest is the only
 *     baseline that keeps working.
 */
'use strict';

const SECRETS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'an email address'],
  [/\bgb_[A-Za-z0-9]{8,}/, 'a GB api key'],
  [/\bya29\.[A-Za-z0-9_-]{10,}/, 'a Google token'],
  [/\b(?:Bearer|bearer)\s+[A-Za-z0-9._-]{12,}/, 'a bearer token'],
  [/"(?:fb_dtsg|lsd)"\s*:\s*"[^"]{4,}"/, 'a Facebook CSRF token'],
];

/** Tools whose disappearance means a filter went wrong, not that the work changed. */
const MUST_SURVIVE = ['finish', 'look', 'click', 'read', 'open'];

const pct = (a, b) => (b > 0 ? (100 * a) / b : 0);

/**
 * @param {object} now       the manifest just built
 * @param {object|null} last the previous round's manifest, or null on the first ever round
 * @param {object} sets      { train, eval, reject } arrays of turns
 * @param {object} opts      { maxShrinkPct, maxOneReasonPct, minGoldPct }
 * @returns {{ok: boolean, halts: string[], warnings: string[], notes: string[] }}
 */
function preflight(now, last, sets = {}, opts = {}) {
  const maxShrink = opts.maxShrinkPct == null ? 30 : opts.maxShrinkPct;
  const maxOneReason = opts.maxOneReasonPct == null ? 25 : opts.maxOneReasonPct;
  const minGoldPct = opts.minGoldPct == null ? 50 : opts.minGoldPct;
  /*
   * A deliberate filter, confirmed by naming it. The comment above has always said a halt is
   * lifted once somebody confirms it; this is the somebody. Naming the reason lifts the two
   * halts that reason explains - its own share, and the shrink it caused - and nothing else:
   * gold collapsing or the exam leaking into the lesson still halt. The acceptance is written
   * into the manifest, so the next build compares against the new size and needs no flag.
   */
  /* Named now, or named on an earlier build and written into its manifest. The comment above
     promised the next build would need no flag; without this line it needed one every time,
     and the automatic rebuild after re-sighting refused the set on a filter confirmed that
     morning. */
  const carried = ((last && last.accepted) || []).map((a) => (a && a.reason) || a).map(String).filter(Boolean);
  const accepted = new Set([].concat(opts.accept || [], carried).map(String).filter(Boolean));

  const halts = [];
  const warnings = [];
  const notes = [];

  const train = sets.train || [];
  const evalSet = sets.eval || [];

  /* 1. There has to be something to train on. */
  if (!train.length) halts.push('the training set is empty');
  if (!evalSet.length) halts.push('the evaluation set is empty — nothing could be measured afterwards');

  /* 2. The exam must not be in the lesson. Split by job, so compare job ids. */
  const trainJobs = new Set(train.map((t) => t.jobId));
  const overlap = [...new Set(evalSet.map((t) => t.jobId))].filter((id) => trainJobs.has(id));
  if (overlap.length) halts.push(`${overlap.length} job(s) are in both the training and evaluation sets — every later measurement would flatter the model`);

  /* 3. Did the set collapse? Measured against last night, because a fixed floor goes stale. */
  if (last && last.turns && last.turns.train) {
    const before = last.turns.train;
    const drop = pct(before - train.length, before);
    const explained = accepted.size > 0 && [...accepted].some((r) => (now.droppedTurns || {})[r] >= (before - train.length) * 0.5);
    if (drop > maxShrink && explained) {
      notes.push(`the training set shrank ${drop.toFixed(0)}% (${before} → ${train.length}) — accepted, the named filter accounts for it`);
    } else if (drop > maxShrink) {
      halts.push(`the training set shrank ${drop.toFixed(0)}% (${before} → ${train.length}) — more than the ${maxShrink}% a round may lose without somebody confirming it`);
    } else if (drop > 5) {
      warnings.push(`the training set is ${drop.toFixed(0)}% smaller than last round (${before} → ${train.length})`);
    } else if (drop < -5) {
      notes.push(`the training set grew ${(-drop).toFixed(0)}% (${before} → ${train.length})`);
    }
  } else {
    notes.push('no previous round to compare against — nothing to shrink from yet');
  }

  /* 4. NO ONE EXCLUSION MAY DOMINATE. This is the check that would have caught both of today's
        filter bugs: "nothing had been observed yet" eating every opening move would sit at a share
        nothing legitimate reaches. */
  const droppedTotal = Object.values(now.droppedTurns || {}).reduce((a, b) => a + b, 0);
  const consideredTotal = train.length + evalSet.length + droppedTotal;
  for (const [reason, n] of Object.entries(now.droppedTurns || {})) {
    const share = pct(n, consideredTotal);
    if (share > maxOneReason && accepted.has(reason)) {
      notes.push(`"${reason}" removed ${share.toFixed(0)}% of the turns (${n}) — accepted`);
    } else if (share > maxOneReason) {
      halts.push(`"${reason}" alone removed ${share.toFixed(0)}% of the turns (${n}) — a filter that takes a quarter of the data is a bug until proven otherwise`);
    } else if (share > 10) {
      warnings.push(`"${reason}" removed ${share.toFixed(0)}% of the turns (${n})`);
    }
  }

  /* 5. Gold must not collapse. typedTextLanded once condemned 319 good jobs, and the only visible
        symptom was gold dropping. */
  if (last && last.tiers && last.tiers.gold) {
    const was = last.tiers.gold;
    const is = (now.tiers || {}).gold || 0;
    const drop = pct(was - is, was);
    if (drop > maxShrink) halts.push(`gold fell ${drop.toFixed(0)}% (${was} → ${is}) — a verifier has probably regressed`);
    else if (drop > 10) warnings.push(`gold fell ${drop.toFixed(0)}% (${was} → ${is})`);
  }
  const tierTotal = Object.values(now.tiers || {}).reduce((a, b) => a + b, 0);
  const keptGold = pct(((now.tiers || {}).gold || 0), Math.max(1, ((now.tiers || {}).gold || 0) + ((now.tiers || {}).silver || 0)));
  if (tierTotal && keptGold < minGoldPct) {
    warnings.push(`only ${keptGold.toFixed(0)}% of the kept jobs are gold — the set leans on unverified reports`);
  }

  /* 6. Every job that was kept has to have contributed something. A job kept and then emptied by a
        turn-level filter is the exact shape of both of today's bugs. */
  const kept = (now.kept && (now.kept.train + now.kept.eval)) || 0;
  const contributing = new Set([...train, ...evalSet].map((t) => t.jobId)).size;
  if (kept && contributing < kept) {
    const empty = kept - contributing;
    const share = pct(empty, kept);
    if (share > 25) halts.push(`${empty} of ${kept} kept jobs produced no turns at all (${share.toFixed(0)}%) — a turn-level filter is eating them`);
    else if (empty) warnings.push(`${empty} kept job(s) produced no turns`);
  }

  /* 7. The tools that matter must still be there. A cap or a filter erasing `finish` would teach a
        model never to stop, and nothing else would look wrong. */
  const present = new Set(train.map((t) => t.action && t.action.tool).filter(Boolean));
  const missing = MUST_SURVIVE.filter((n) => !present.has(n));
  if (missing.length) halts.push(`no examples left of: ${missing.join(', ')} — a model cannot learn a tool it never sees`);

  /* 8. Nothing secret may be in what gets written. Automatic, because "we scrubbed it" is a claim
        and this is a check. The phone pattern once began with \\b, which cannot match before a "+",
        so every international number would have shipped. */
  const sample = JSON.stringify([...train.slice(0, 4000), ...evalSet.slice(0, 1000)]);
  for (const [re, what] of SECRETS) {
    if (re.test(sample)) halts.push(`${what} is present in the written set — the scrub did not hold`);
  }

  return { ok: halts.length === 0, halts, warnings, notes };
}

/** One readable block, for a log nobody will be watching live. */
function explain(r) {
  const lines = [];
  lines.push(r.ok ? 'PRE-FLIGHT PASSED — this set may be trained on' : 'PRE-FLIGHT FAILED — not training on this set');
  for (const h of r.halts) lines.push(`  HALT  ${h}`);
  for (const w of r.warnings) lines.push(`  warn  ${w}`);
  for (const n of r.notes) lines.push(`  note  ${n}`);
  return lines.join('\n');
}

module.exports = { preflight, explain, SECRETS, MUST_SURVIVE };
