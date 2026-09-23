/*
 * quality.js — HOW THE WORK WAS DONE, WHICH IS A DIFFERENT QUESTION FROM WHETHER IT WORKED.
 *
 * The tiers answer one thing: did something outside the agent's own account confirm the outcome.
 * They are silent on method, so a job done in eight clean steps and the same job done in sixty
 * confused ones are both gold and both weigh the same.
 *
 * They do not weigh the same, and not in the direction anyone would want. Measured across 1,230
 * usable runs: 693 were clean and supplied 10,468 turns; 537 were messy and supplied 29,627. Clean
 * runs are 56% of the runs and 26% of the training data, because flailing produces more examples
 * per run. A model trained on that learns the flail — which is exactly what round one did, ending
 * at 0/15 on `read` and 0/11 on `look` while collapsing onto one tool.
 *
 * WHAT COUNTS AS CLEAN, AND WHY EACH ONE IS EVIDENCE RATHER THAN TASTE:
 *
 *   IT STOPPED ON PURPOSE.   A run that called `finish` decided it was done. One that hit the step
 *                            limit was cut off mid-thought, and its last turns are a model running
 *                            out of road rather than concluding.
 *   NOTHING WAS REFUSED.     A refused tool means the run was given the wrong brief. What follows
 *                            is the agent working around a wall, which is a habit worth not
 *                            teaching — 306 runs in this corpus contain one.
 *   IT NEVER STALLED.        The loop itself records "looks/reads in a row with no action" when an
 *                            agent observes repeatedly without deciding. 347 runs hit it. Those
 *                            turns are the model visibly stuck.
 *   IT DID NOT REPEAT ITSELF. The same call with the same arguments twice in a row is a model that
 *                            did not read the answer to the first one.
 *
 * Deliberately NOT here: step count on its own. Short is not good — a two-step run that downloaded
 * the right file and a two-step run that gave up look identical by length, and the tier already
 * separates those. What is measured here is behaviour the record can prove.
 */
'use strict';

/** The loop's own words when an agent observes without deciding. Matched loosely: it has been reworded. */
const STALL = /in a row with no action/i;
const REFUSED = /refused/i;

const stepsOf = (job) => (job && Array.isArray(job.steps) ? job.steps : []);
const textOf = (s) => String((s && s.text) || '');

/**
 * What the record says about how this run was conducted.
 *
 * Returns the marks as well as the verdict, because "messy" on its own tells nobody what to fix,
 * and these four have very different remedies — a refusal is a role problem, a stall is a model
 * problem, and no-finish is usually a budget problem.
 */
function qualityOf(job) {
  const steps = stepsOf(job);
  const calls = steps.filter((s) => s && s.kind === 'tool');

  /*
   * ONE NUDGE IS THE GUARD WORKING, NOT THE RUN FAILING.
   *
   * This counted a single `looks/reads in a row with no action` line as a stall. That line is the
   * loop's own nudge: it fires once per streak of four observe-only calls and pushes the agent to
   * commit. Usually it works and the run carries straight on.
   *
   * It also fires on look -> scroll -> look -> scroll, which is simply how anyone reads a long
   * listing page — `scroll` counts as observe-only, so two pairs trip it. Measured on the run that
   * first exercised choose_option: 17 run_script calls, 3 looks, a correct answer in 31 calls, and
   * it was graded untidy for scrolling a Marktplaats page twice. That is the most efficient shape
   * we have, and the grader was demoting it.
   *
   * Measured over 2,313 runs: 599 carry the line, and 320 of those carry exactly ONE — of which
   * 152 are otherwise spotless. Counting one nudge as a stall cost 37 runs their `best` grade and
   * 77 their `clean`, against a `best` population of 82. The tail is where the real thing lives:
   * runs with two, three, eleven nudges are circling and should be marked.
   *
   * So the threshold is TWO. The runtime guard is untouched — it is doing its job.
   */
  const nudges = steps.filter((s) => STALL.test(textOf(s))).length;
  const stalled = nudges >= 2;
  const refused = steps.some((s) => REFUSED.test(textOf(s)));
  const finished = calls.some((s) => s.tool === 'finish');

  /* The same call twice in a row: the answer to the first one was not read. One repeat is a retry
     and ordinary; a handful is a loop. */
  let repeats = 0;
  for (let i = 1; i < calls.length; i++) {
    if (calls[i].tool === calls[i - 1].tool
      && JSON.stringify(calls[i].args || {}) === JSON.stringify(calls[i - 1].args || {})) repeats++;
  }

  const marks = [];
  if (!finished) marks.push('never finished on its own');
  if (refused) marks.push('asked for a tool its role does not carry');
  if (stalled) marks.push(`looked or read without deciding ${nudges} times`);
  if (repeats > 2) marks.push(`repeated the same call ${repeats} times`);

  return {
    clean: marks.length === 0,
    finished,
    refused,
    stalled,
    nudges,
    repeats,
    calls: calls.length,
    marks,
  };
}

/**
 * One word for a slice to sort on: how much this run deserves to be copied.
 *
 * `best` is a clean run with outside confirmation — the work was done well AND something other than
 * the agent's own word says it worked. That is the only combination worth ranking above gold, and
 * it is what a first training should be made mostly of.
 */
function gradeOf(job, tier) {
  const q = qualityOf(job);
  if (tier === 'gold' && q.clean) return 'best';
  if (tier === 'gold') return 'gold';
  if (tier === 'silver' && q.clean) return 'clean';
  if (tier === 'silver') return 'silver';
  return tier;
}

/** Ranking for a sampler: lower sorts first. Kept here so two callers cannot disagree about it. */
const RANK = { best: 0, gold: 1, clean: 2, silver: 3, bronze: 4, void: 5 };
const rankOf = (grade) => (RANK[grade] === undefined ? 9 : RANK[grade]);

module.exports = { qualityOf, gradeOf, rankOf, RANK };
