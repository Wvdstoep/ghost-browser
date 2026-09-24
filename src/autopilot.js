/*
 * autopilot.js — WHICH MODEL ANSWERS A STEP, AND WHETHER IT HAS EARNED THE RIGHT TO.
 *
 * Four things can answer a step: the role's own adapter, its platform's adapter, the base adapter,
 * and the teacher. The rule is the most SPECIFIC model that has EARNED its stage, with everything
 * less specific as the fallback, and the teacher at the end of the line always.
 *
 * A model earns its stage on measurements, never on a person's confidence:
 *
 *   shadow    every promoted model starts here. It is asked beside whoever drives, its answers are
 *             written down and nothing it says is applied. Costs nothing on the outcome.
 *   canary    after SHADOW_STEPS shadowed steps with tool agreement at or above SHADOW_AGREE, it
 *             drives a share of the jobs. The verifiers judge those jobs like any other.
 *   primary   after CANARY_JOBS judged jobs with a gold-or-silver rate at or above CANARY_GOOD and
 *             fewer than CANARY_FALLBACK of its steps handed back, it drives every job on its
 *             scope; the teacher is the fallback.
 *
 * Stages are COMPUTED from the ledger every time, never stored, so a model that starts failing
 * falls back the moment the numbers say so: a primary whose judged rate drops under DEMOTE_GOOD
 * is a canary again; a canary under it is a shadow again. There is no flag to forget to reset.
 *
 * Pure. The ledgers come from shadow.js, the model map from settings; both are handed in.
 */
'use strict';

const platforms = require('./trainScopes');

const RULES = Object.freeze({
  shadowSteps: 200,     // shadowed steps before a model may drive at all
  shadowAgree: 55,      // tool agreement with the teacher, in percent, over those steps
  canaryJobs: 30,       // judged jobs it drove before it may drive them all
  canaryGood: 60,       // gold-or-silver rate, in percent, over those jobs
  canaryFallback: 25,   // percent of its driven steps handed back to the teacher, at most
  demoteGood: 40,       // under this judged rate a model falls one stage, whatever it had
});

const pct = (a, b) => (b > 0 ? Math.round((1000 * a) / b) / 10 : 0);

/** The stage a ledger has earned, with the reason and the next thing it needs. */
function stageOf(ledger, rules = RULES) {
  const l = ledger || {};
  const seen = Number(l.seen) || 0;
  const agree = pct(Number(l.agree) || 0, seen);
  const driven = l.driven || {};
  const steps = Number(driven.steps) || 0;
  const fallback = pct(Number(driven.fallbacks) || 0, steps);
  const o = l.outcomes || {};
  const judged = Number(o.jobs) || 0;
  const good = pct((Number(o.gold) || 0) + (Number(o.silver) || 0), judged);

  if (seen < rules.shadowSteps) {
    return { stage: 'shadow', why: `${seen} of ${rules.shadowSteps} shadowed steps`, agree, good, judged, fallback };
  }
  if (agree < rules.shadowAgree) {
    return { stage: 'shadow', why: `agrees with the teacher on ${agree}% — needs ${rules.shadowAgree}%`, agree, good, judged, fallback };
  }
  if (judged >= rules.canaryJobs && good < rules.demoteGood) {
    return { stage: 'shadow', why: `only ${good}% of the ${judged} jobs it drove were good — back to the shadow`, agree, good, judged, fallback };
  }
  if (judged < rules.canaryJobs) {
    return { stage: 'canary', why: `${judged} of ${rules.canaryJobs} driven jobs judged`, agree, good, judged, fallback };
  }
  if (good < rules.canaryGood) {
    return { stage: 'canary', why: `${good}% of its driven jobs were good — needs ${rules.canaryGood}%`, agree, good, judged, fallback };
  }
  if (fallback > rules.canaryFallback) {
    return { stage: 'canary', why: `handed ${fallback}% of its steps back — at most ${rules.canaryFallback}%`, agree, good, judged, fallback };
  }
  return { stage: 'primary', why: `${good}% good over ${judged} jobs, ${agree}% agreement, ${fallback}% handed back`, agree, good, judged, fallback };
}

/** Every model in the map with its stage — for the screen. */
function stages({ models = {}, ledgers = {}, rules = RULES } = {}) {
  const out = [];
  for (const [key, tag] of Object.entries(models || {})) {
    if (!tag) continue;
    out.push({ key, model: tag, ...stageOf(ledgers[tag], rules) });
  }
  return out;
}

/**
 * Who answers this role's steps.
 *
 * @returns {{ model, mode, key, shadowModel, why, chain }}
 *   model        the tag that drives (or is shadowed) — '' when nothing is configured
 *   mode         off | shadow | canary | primary — what router.decide is told
 *   shadowModel  the most specific tag still in the shadow, to be asked beside the driver
 */
function pick({ role = 'general', models = {}, ledgers = {}, settings = {}, rules = RULES } = {}) {
  const chain = platforms.chainOf(role);
  const candidates = chain
    .map((s) => ({ key: s.key, model: (models || {})[s.key] || '' }))
    .filter((c) => c.model);
  /* Nothing in the map: the single-model setting, the way it worked before the map existed. */
  if (!candidates.length && settings.studentModel) candidates.push({ key: 'base', model: settings.studentModel });
  if (!candidates.length) return { model: '', mode: 'off', key: '', shadowModel: '', why: 'no model is configured for this role or its platform', chain: chain.map((s) => s.key) };

  /* A person's hand on the wheel: the mode is the setting, the model the most specific there is. */
  if (!settings.autopilot) {
    const c = candidates[0];
    return { model: c.model, mode: settings.studentMode || 'off', key: c.key, shadowModel: c.model, why: `autopilot is off — serving ${settings.studentMode || 'off'} with the most specific model`, chain: chain.map((s) => s.key) };
  }

  const staged = candidates.map((c) => ({ ...c, ...stageOf(ledgers[c.model], rules) }));
  const driver = staged.find((c) => c.stage === 'canary' || c.stage === 'primary');
  const shadowed = staged.find((c) => c.stage === 'shadow');
  if (driver) {
    return {
      model: driver.model, mode: driver.stage, key: driver.key,
      shadowModel: shadowed && shadowed.key !== driver.key ? shadowed.model : driver.model,
      why: `${driver.key}: ${driver.stage} — ${driver.why}`, chain: chain.map((s) => s.key),
    };
  }
  const s = staged[0];
  return { model: s.model, mode: 'shadow', key: s.key, shadowModel: s.model, why: `${s.key}: shadow — ${s.why}`, chain: chain.map((s2) => s2.key) };
}

module.exports = { RULES, stageOf, stages, pick };
