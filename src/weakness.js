'use strict';
/*
 * WHAT THE STUDENT GETS WRONG, per tool - the one thing worth training more of.
 *
 * Two witnesses, both already written down. The EXAM of the model that serves a scope: 495 held-out
 * turns, right or wrong per tool, measured the moment it was promoted. And the SHADOW: the same
 * model answering beside the teacher on real jobs, tool by tool. The exam speaks first because it
 * exists from the first promotion; the shadow refines it as it fills.
 *
 * The number returned is a WEIGHT, not a verdict: 1 for a tool that is right every time, up to
 * WORST for one that is never right. The draw multiplies a tool's natural share by it. A tool
 * nobody has measured weighs 1 - no guessing.
 */
const WORST = 3;        // the largest share a failing tool may be given, as a multiple of its own
const ENOUGH = 5;       // fewer measured turns than this says nothing

/** {tool: weight} from one exam result (round.result.per_tool: {tool: {seen, right, pct}}). */
function fromExam(result) {
  const per = (result && (result.per_tool || result.perTool)) || null;
  const out = {};
  if (!per || typeof per !== 'object') return out;
  for (const [tool, v] of Object.entries(per)) {
    const seen = Number(v && v.seen) || 0;
    if (seen < ENOUGH) continue;
    const right = Number(v && v.right) || 0;
    const miss = Math.max(0, Math.min(1, 1 - right / seen));
    out[tool] = 1 + (WORST - 1) * miss;
  }
  return out;
}

/** {tool: weight} from the shadow's books (shadow.all(): {tag: {perTool: {tool: {seen, agree}}}}). */
function fromShadow(books, model = '') {
  const out = {};
  const pick = model && books && books[model] ? { [model]: books[model] } : (books || {});
  const tally = {};
  for (const b of Object.values(pick)) {
    for (const [tool, v] of Object.entries((b && b.perTool) || {})) {
      const t = tally[tool] || (tally[tool] = { seen: 0, agree: 0 });
      t.seen += Number(v.seen) || 0;
      t.agree += Number(v.agree) || 0;
    }
  }
  for (const [tool, t] of Object.entries(tally)) {
    if (t.seen < ENOUGH) continue;
    const miss = Math.max(0, Math.min(1, 1 - t.agree / t.seen));
    out[tool] = 1 + (WORST - 1) * miss;
  }
  return out;
}

/**
 * The weights for a scope: the newest promoted round of that scope speaks, and the shadow of the
 * model serving it speaks; where both have something to say, the worse of the two is taken - a
 * tool that fails on either is a tool to train.
 */
function forScope({ rounds = [], shadow = {}, model = '', key = 'base' } = {}) {
  const mine = (rounds || []).filter((r) => ((r.scope && r.scope.key) || 'base') === key && r.promoted && r.result && !r.discarded);
  const newest = mine[0] || null;
  const exam = fromExam(newest && newest.result);
  const live = fromShadow(shadow, model);
  const out = { ...exam };
  for (const [tool, w] of Object.entries(live)) out[tool] = Math.max(out[tool] || 1, w);
  return out;
}

module.exports = { WORST, ENOUGH, fromExam, fromShadow, forScope };
