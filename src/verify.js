/*
 * verify.js — TURNING WHAT THE AGENT SAID INTO WHAT ACTUALLY HAPPENED.
 *
 * Every finished job carries a report the agent wrote about itself. Out of 2,222 recorded jobs, 1,429
 * have one, and they read like success: "Notification sweep complete. Collected 2 qualified…". That
 * sentence is testimony, not evidence, and the difference decides everything downstream.
 *
 * It matters twice:
 *
 *   1. AS A PRODUCT FIX, TODAY. An agent that reports an export it never produced is worse than one
 *      that admits it failed, because the failure is invisible until somebody looks for the file.
 *   2. AS THE REWARD SIGNAL. A model trained on self-declared success learns to declare success.
 *      That failure looks identical to competence in every metric derived from the same reports, and
 *      it is the reason training on this corpus needs an external check rather than a bigger corpus.
 *
 * So each verifier below answers one question that the model cannot answer for itself — is the file
 * there, is the text on the page, did the recording end with bytes in it, did a person approve the
 * act. Anything a verifier cannot settle comes back `unknown`, never `true`: a verifier that guesses
 * is worse than no verifier, because it mints false gold.
 */
'use strict';

/** A verifier's answer. `unknown` is a first-class result and must never be read as a pass. */
const UNKNOWN = (why) => ({ ok: null, why });
const PASS = (why, evidence) => ({ ok: true, why, evidence });
const FAIL = (why, evidence) => ({ ok: false, why, evidence });

const steps = (job) => (Array.isArray(job && job.steps) ? job.steps : []);
const toolSteps = (job) => steps(job).filter((s) => s && s.kind === 'tool' && s.tool);
const textOf = (s) => String((s && (s.text || s.detail)) || '');
const ms = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };

/**
 * IT SAID IT TYPED SOMETHING — DID IT LAND?
 *
 * REWRITTEN AFTER READING FIFTY OF ITS OWN FAILURES BY HAND, and 47 of the 50 were this verifier
 * being blind rather than the agent lying. The first version looked for the typed text in a later
 * `read`, `open` or `look` step, and concluded 1,320 times that nothing had landed.
 *
 * The receipt was sitting one step away the whole time. After a type call the platform writes a
 * `type`-KIND step that echoes what went in:
 *
 *     [tool:type] type([5] "I build and deploy custom web applications…")
 *     [type]      typed into [5] "about_me_en": I build and deploy custom web applications…
 *
 * That second line is the confirmation, and it was never read. A pasted field says
 * `pasted 317 chars into [30]` instead, which carries no text but is still the platform saying it
 * went in. An `acted` step does the same for a message that was sent rather than typed.
 *
 * So there are now three outcomes instead of two, and the third is the one that was missing:
 *
 *   PASS      a receipt, or the text visible on the page afterwards.
 *   FAIL      an `error` step on the type itself — "Element [9] not found in last analysis",
 *             "keyboard.type: Target page, context or browser has been closed". Two of the fifty.
 *   UNKNOWN   the run was stopped before anything could confirm it. One of the fifty, and calling
 *             that a failure is how an owner pressing Stop becomes training signal.
 *
 * The needle is 30 characters because the receipt itself is truncated in the record; matching more
 * than the receipt holds would fail on every long message, which is most of them.
 */
function typedTextLanded(job) {
  const all = steps(job);
  const typed = toolSteps(job).filter((s) => /type|paste/i.test(s.tool) && s.args
    && typeof s.args.text === 'string' && s.args.text.trim().length >= 8);
  if (!typed.length) return UNKNOWN('this job never typed anything worth checking');

  const interrupted = all.some((s) => s.kind === 'end' && /stopped by you/i.test(textOf(s)));
  let confirmed = 0;
  const unconfirmed = [];

  for (const t of typed) {
    const needle = t.args.text.trim().slice(0, 30).toLowerCase();
    const later = all.filter((s) => (s.n || 0) > (t.n || 0));

    /* An error on the type itself, right after it: the keystroke never happened. */
    const err = later.slice(0, 3).find((s) => s.kind === 'error' && /type|keyboard/i.test(textOf(s)));
    if (err) return FAIL('the type itself errored', textOf(err).slice(0, 120));

    /* The platform's own receipt, within a few steps. */
    const receipt = later.slice(0, 4).find((s) => {
      if (!['type', 'acted', 'act'].includes(s.kind)) return false;
      const tx = textOf(s).toLowerCase();
      return tx.includes(needle) || /pasted\s+\d+\s+chars/i.test(tx);
    });
    if (receipt) { confirmed++; continue; }

    /* Or the text simply visible on a later read. */
    if (later.some((s) => ['read', 'open', 'look'].includes(s.kind) && textOf(s).toLowerCase().includes(needle))) {
      confirmed++; continue;
    }
    unconfirmed.push(needle.slice(0, 40));
  }

  if (!unconfirmed.length) return PASS(`all ${confirmed} typed value(s) confirmed by the record`, `${confirmed} typed`);
  /* Interrupted runs are inconclusive, not failures — the owner pressing Stop is not the agent
     lying, and treating it as one turns every cancelled job into a negative example. */
  if (interrupted) return UNKNOWN(`${unconfirmed.length} typed value(s) unconfirmed, but the run was stopped`);
  return FAIL(`${unconfirmed.length} typed value(s) never confirmed by any receipt or later read`, unconfirmed.slice(0, 2).join(' | '));
}

/**
 * IT SAID IT DOWNLOADED OR EXPORTED SOMETHING — IS THERE A FILE?
 *
 * Checked against the file store rather than the report, and bounded to the job's own window so a
 * file somebody else produced cannot be claimed. A size of zero counts as a failure, because a
 * zero-byte export is exactly what a half-finished download leaves behind.
 */
function fileWasProduced(job, { files } = {}) {
  const claimed = toolSteps(job).some((s) => /download|upload_file|export/i.test(s.tool))
    || /download(ed)?|export(ed)?|saved the (file|video|mp4)/i.test(String(job.report || ''));
  if (!claimed) return UNKNOWN('this job never claimed a file');
  if (typeof files !== 'function') return UNKNOWN('no file store to check against');
  const from = ms(job.createdAt);
  const to = ms(job.endedAt) || Date.now();
  let rows = [];
  try { rows = files() || []; } catch (e) { return UNKNOWN(`could not read the file store: ${e.message}`); }
  const within = rows.filter((f) => { const at = ms(f.at); return at >= from - 60000 && at <= to + 300000; });
  const real = within.filter((f) => Number(f.size) > 0);
  if (!real.length) return FAIL('a file was claimed and none appeared in the store in that window', `${within.length} in window, 0 with bytes`);
  return PASS('a file with bytes appeared while this job ran', real.map((f) => `${f.name} ${f.size}B`).slice(0, 3).join(', '));
}

/**
 * IT STARTED A RECORDING — DID THAT RECORDING END WITH SOMETHING IN IT?
 *
 * A recording is the one artefact that cannot be faked by a confident sentence: either the file is
 * there with seconds and bytes, or the claim is empty.
 */
function recordingCompleted(job, { recordings } = {}) {
  const ids = new Set();
  for (const s of steps(job)) {
    if (s && s.recording) ids.add(String(s.recording));
    const m = textOf(s).match(/rec-[a-z0-9-]+/gi);
    if (m) m.forEach((x) => ids.add(x));
  }
  if (!ids.size) return UNKNOWN('this job started no recording');
  if (typeof recordings !== 'function') return UNKNOWN('no recorder to check against');
  let rows = [];
  try { rows = recordings() || []; } catch (e) { return UNKNOWN(`could not read recordings: ${e.message}`); }
  const mine = rows.filter((r) => ids.has(String(r.id)));
  if (!mine.length) return FAIL('a recording was started and none of those ids exist any more', [...ids].join(','));
  const good = mine.filter((r) => (r.state === 'done' || r.state === 'partial') && Number(r.bytes) > 0 && Number(r.seconds) > 1);
  if (!good.length) return FAIL('the recording never finished with anything in it', mine.map((r) => `${r.id}:${r.state}:${r.bytes}B`).join(', '));
  return PASS('a recording finished with bytes and duration', good.map((r) => `${r.id} ${r.seconds}s ${r.bytes}B`).join(', '));
}

/**
 * DID A PERSON APPROVE WHAT IT WANTED TO DO?
 *
 * The strongest signal in the whole store, and the scarcest: only 72 of 2,222 jobs have a proposal
 * at all. An approval is a human saying the draft was good enough to send under their own name,
 * which no automatic check can equal — so when it is present it outweighs everything else.
 */
function actWasApproved(job) {
  const props = Array.isArray(job && job.proposals) ? job.proposals : [];
  if (!props.length) return UNKNOWN('this job proposed nothing');
  const state = (p) => String((p && (p.state || p.status || '')) || '').toLowerCase();
  const approved = props.filter((p) => /approv|posted|sent|accepted/.test(state(p)));
  const denied = props.filter((p) => /den|reject|skip/.test(state(p)));
  if (approved.length) return PASS('an act was approved by the owner', `${approved.length} of ${props.length}`);
  if (denied.length && denied.length === props.length) return FAIL('every proposed act was denied', `${denied.length} denied`);
  return UNKNOWN(`${props.length} proposal(s) still undecided`);
}

/** Did it actually write anything down? Findings are an artefact; a summary is not. */
function resultsWereWritten(job) {
  const buckets = ['leads', 'opportunities', 'gigs', 'replies', 'reach', 'keywords'];
  const counts = buckets.map((k) => [k, Array.isArray(job && job[k]) ? job[k].length : 0]).filter(([, n]) => n > 0);
  if (!counts.length) return UNKNOWN('nothing was written to a results bucket');
  return PASS('rows were written', counts.map(([k, n]) => `${k}:${n}`).join(' '));
}

const VERIFIERS = {
  actWasApproved,
  recordingCompleted,
  fileWasProduced,
  typedTextLanded,
  resultsWereWritten,
};

/** Which verifiers, when they pass, are external truth rather than a good sign. */
const EXTERNAL = new Set(['actWasApproved', 'recordingCompleted', 'fileWasProduced', 'typedTextLanded']);

/**
 * THE LABEL, AND ITS REASONS.
 *
 *   gold    an external check passed. Train on these without hesitation.
 *   silver  nothing external could be checked, but it wrote a report, wrote rows and did not error.
 *           Usable with weight, never as the bulk of a training set.
 *   bronze  it errored, was cut short, or a verifier actively FAILED. Useful as a negative, and as a
 *           positive never — the corpus is 71% stopped jobs, so this is most of it.
 *
 * A FAILED verifier is decisive: a job that claimed a file and produced none is bronze no matter how
 * good its report reads. That asymmetry is the whole point of checking.
 */
function outcomeOf(job, deps = {}) {
  const checks = {};
  for (const [name, fn] of Object.entries(VERIFIERS)) {
    try { checks[name] = fn(job, deps); } catch (e) { checks[name] = UNKNOWN(`verifier threw: ${e.message}`); }
  }
  const failed = Object.entries(checks).filter(([, r]) => r.ok === false);
  const passedExternal = Object.entries(checks).filter(([n, r]) => r.ok === true && EXTERNAL.has(n));

  const errored = !!(job && job.error);
  const report = String((job && job.report) || '').trim();
  const cutShort = /step (limit|budget)|model stopped answering|could not be reopened/i.test(report);

  let tier = 'bronze';
  const why = [];
  if (failed.length) {
    why.push(...failed.map(([n, r]) => `${n}: ${r.why}`));
  } else if (passedExternal.length) {
    tier = 'gold';
    why.push(...passedExternal.map(([n, r]) => `${n}: ${r.why}`));
  } else if (!errored && !cutShort && report && checks.resultsWereWritten.ok === true) {
    tier = 'silver';
    why.push('a report, rows written, and nothing external to check');
  } else if (!errored && !cutShort && report) {
    tier = 'silver';
    why.push('a report and no error, but nothing external to check');
  } else {
    why.push(errored ? `errored: ${String(job.error).slice(0, 120)}` : cutShort ? 'cut short' : 'no report and nothing verified');
  }

  return { tier, why, checks, external: passedExternal.map(([n]) => n), failures: failed.map(([n]) => n) };
}

module.exports = { outcomeOf, VERIFIERS, EXTERNAL, UNKNOWN, PASS, FAIL };
