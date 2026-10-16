'use strict';
/**
 * cardshadow.js — keep a read card honest BEFORE it fails, by checking it against the UI.
 *
 * Self-healing on failure is common: the card errors, the job walks the UI, the card is re-learned.
 * The expensive error is the one that never errors. An API is versioned, a field changes meaning, a
 * cache serves stale rows, and the card keeps answering 200 with the right SHAPE and the wrong
 * DATA. Nothing fails, so nothing heals, and every job that trusts it is quietly wrong.
 *
 * So a trusted card is periodically SHADOWED: the UI walk (the ground truth the card is measured
 * against) and the card replay are run for the same input, read-only, and compared. Agreement keeps
 * the card trusted and is recorded. Disagreement is not acted on at once, because live data really
 * does change between two reads: the pair is run again, and only a disagreement that REPEATS is
 * drift. Confirmed drift quarantines the card, with the diff kept as the evidence.
 *
 * The cost is one UI walk per check, so checks are SPARSE and ADAPTIVE: a card that has agreed many
 * times is checked rarely; one that has just been suspected is checked on every use.
 *
 * Pure of Playwright: `uiWalk(values)` and `runInPage` are injected.
 */

const { attemptRead } = require('./replay');
const { compareRows } = require('./readcards');

const HOUR = 3600 * 1000;

/** The ledger a card carries. Counters only: no row data beyond the last diff's sizes. */
const blank = () => ({ checks: 0, agree: 0, flaky: 0, drift: 0, lastAt: 0, suspect: false, lastDiff: null });

/** Is a shadow check due? Trust earns longer gaps; suspicion removes the gap. */
function due(card, now = Date.now(), { baseMs = 12 * HOUR, maxMs = 7 * 24 * HOUR } = {}) {
  if (!card || card.kind !== 'read' || card.quarantined) return { due: false, why: 'not a live read card' };
  const sh = card.shadow || blank();
  if (!sh.lastAt) return { due: true, why: 'never shadowed' };
  if (sh.suspect) return { due: true, why: 'a disagreement was seen last time — checking on every use' };
  const gap = Math.min(maxMs, baseMs * Math.pow(2, Math.min(sh.agree, 4)));   // 12h, 24h, 2d, 4d, 7d
  const age = now - sh.lastAt;
  return age >= gap ? { due: true, why: `last agreed ${Math.round(age / HOUR)}h ago (gap ${Math.round(gap / HOUR)}h)` }
                    : { due: false, why: `agreed ${Math.round(age / HOUR)}h ago, next check in ${Math.round((gap - age) / HOUR)}h` };
}

/**
 * Run one shadow check. Returns { verdict: 'agree'|'flaky'|'drift'|'unreachable', card, rows, diff, reason }.
 * `card` is the card to store back: ledger updated, and quarantined on confirmed drift only.
 */
async function shadowCheck({ card, values = {}, uiWalk, runInPage, ensureOrigin = null, now = Date.now() }) {
  const sh = { ...blank(), ...(card.shadow || {}) };
  const once = async () => {
    const ui = await uiWalk(values);
    const r = await attemptRead({ card, values, runInPage, ensureOrigin, baseline: ui, now });
    return { ui, r };
  };

  const first = await once();
  if (first.r.status == null && !first.r.rows) {                       // could not even reach the origin
    return { verdict: 'unreachable', card, reason: first.r.reason };
  }
  sh.checks += 1; sh.lastAt = now;
  if (first.r.done) {
    sh.agree += 1; sh.suspect = false;
    return { verdict: 'agree', card: { ...first.r.card, shadow: sh }, rows: first.r.rows, reason: 'the card equals the UI' };
  }

  // a disagreement: run the pair once more before believing it
  const second = await once();
  if (second.r.done) {
    sh.flaky += 1; sh.suspect = true;                                  // data moved between reads, not drift; watch it closely
    return { verdict: 'flaky', card: { ...card, shadow: sh }, rows: second.r.rows, reason: 'the first pair disagreed and the repeat agreed: live data moved between the reads' };
  }
  const diff = second.r.rows && second.ui
    ? compareRows(second.ui, second.r.rows, card.columns)
    : { reason: second.r.reason };
  sh.drift += 1; sh.suspect = true;
  sh.lastDiff = { at: now, baselineRows: second.ui.length, replayRows: second.r.rows ? second.r.rows.length : 0, missing: diff.missing, extra: diff.extra, why: second.r.reason };
  return {
    verdict: 'drift',
    card: { ...second.r.card, shadow: sh },                            // attemptRead already quarantined it
    rows: second.r.rows, diff: sh.lastDiff,
    reason: `the card and the UI disagree twice in a row (${second.r.reason})`,
  };
}

module.exports = { due, shadowCheck, blank };
