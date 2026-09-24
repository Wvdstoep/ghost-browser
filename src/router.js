/*
 * router.js — WHO DRIVES THIS STEP: THE TEACHER, OR THE MODEL WE TRAINED?
 *
 * Four modes, in the order a model earns them:
 *
 *   off      the student is never asked.
 *   shadow   the teacher drives; the student is asked the same question at every step and its
 *            answer is written down beside the teacher's, never applied. Costs nothing on the
 *            outcome and produces the one number that matters before anyone trusts the model:
 *            live agreement, per tool, on real jobs.
 *   canary   the student drives a share of the jobs - a tenth to start - with the teacher taking
 *            over the moment it looks lost. The verifiers score those jobs like any other.
 *   primary  the student drives every job; the teacher is the fallback.
 *
 * WHEN THE STUDENT LOOKS LOST. Three strikes on one job and the teacher drives the rest of it: an
 * answer that is not a tool call, a tool this role does not have, a click on a number the last
 * list did not offer, or the same call three times in a row. A strike is a fact about this job,
 * not a verdict on the model; the model's verdict is the exam and the canary's gold rate.
 *
 * Pure. The job's strikes are kept by the caller and handed back in.
 */
'use strict';

const MODES = ['off', 'shadow', 'canary', 'primary'];
const STRIKES = 3;

function hashOf(s) {
  let h = 2166136261;
  for (const c of String(s || '')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

/** Is this job one of the canary's? Decided once per job by its id, so a job never changes hands mid-way for that reason. */
function canaryJob(jobId, share = 0.1) {
  const s = Math.max(0, Math.min(1, Number(share) || 0));
  return (hashOf(jobId) % 1000) < Math.round(s * 1000);
}

/**
 * Who answers this step.
 * @returns {'teacher'|'student'} plus whether the student should be asked in the shadow.
 */
function decide({ mode = 'off', share = 0.1, jobId = '', strikes = 0, model = '' } = {}) {
  const m = MODES.includes(mode) ? mode : 'off';
  if (m === 'off' || !model) return { drive: 'teacher', shadow: false, why: m === 'off' ? 'serving is off' : 'no student model is configured' };
  if (strikes >= STRIKES) return { drive: 'teacher', shadow: false, why: `the student struck out on this job (${strikes})` };
  if (m === 'shadow') return { drive: 'teacher', shadow: true, why: 'shadow: the teacher drives, the student is asked beside it' };
  if (m === 'canary') {
    return canaryJob(jobId, share)
      ? { drive: 'student', shadow: false, why: `canary: this job is the student's (${Math.round(share * 100)}% share)` }
      : { drive: 'teacher', shadow: true, why: 'canary: not this job - the student is asked beside the teacher' };
  }
  return { drive: 'student', shadow: false, why: 'primary: the student drives, the teacher is the fallback' };
}

/**
 * Does this answer look like a model that has lost the page? A reason, or null.
 * @param call        {name, args} or null
 * @param allowed     Set of tool names this role has
 * @param marksCount  how many numbered marks the latest look offered (null = unknown)
 * @param recent      the last few calls this job made, oldest first
 */
function looksWrong({ call, allowed = null, marksCount = null, recent = [] } = {}) {
  if (!call || !call.name) return 'it did not answer with a tool call';
  if (allowed && !allowed.has(call.name)) return `${call.name} is not one of this role's tools`;
  const idx = call.args && call.args.index;
  if (idx != null && marksCount != null && (Number(idx) < 1 || Number(idx) > marksCount)) return `it chose [${idx}] and the last list offered ${marksCount}`;
  const same = (a, b) => a && b && a.name === b.name && JSON.stringify(a.args || {}) === JSON.stringify(b.args || {});
  const last = recent.slice(-2);
  if (last.length === 2 && same(last[0], call) && same(last[1], call)) return `it repeated ${call.name} a third time`;
  return null;
}

/** The synthetic reply the agent loop expects, so the student's answer travels the teacher's road. */
function asReply(call) {
  const fn = { name: call.name, arguments: call.args || {} };
  return { content: '', toolCalls: [{ name: call.name, args: call.args || {} }], raw: { message: { tool_calls: [{ function: fn }] } }, student: true };
}

module.exports = { MODES, STRIKES, decide, canaryJob, looksWrong, asReply, hashOf };
