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

/**
 * THE AUTOMATION THIS JOB BELONGED TO — DID IT FINISH?
 *
 * The profiles volume has two stores and the labeller only knew about one. /profiles/jobs holds
 * 2,223 agent walks; /profiles/workflow-runs holds 1,837 automation runs, and THAT is the better
 * corpus: 1,570 of them completed `done`, because an automation runs a route somebody already
 * proved rather than exploring.
 *
 * 964 jobs carry a runId and every one of them matches a run record. 885 belong to a run that
 * finished — and 666 of those jobs were sitting in silver while the confirmation lay in the other
 * drawer. Joining the two is the single biggest label improvement available, and it costs a lookup.
 *
 * HOW STRONG IS THIS SIGNAL, HONESTLY? Weaker than a person approving an act, stronger than the
 * agent's own report. A run reaching `done` means every later node — a filter, a condition, a
 * follow-up — consumed this job's output and did not break on it. A second system depended on the
 * work and carried on. That is corroboration from outside the model, which is the bar for gold.
 *
 * With one refusal: a job the OWNER stopped stays out of it. A flow that carried on regardless does
 * not turn an interruption into a judgement, and owner-stopped is the one state that is neither
 * rewarded nor punished anywhere in this file.
 */
function automationRunCompleted(job, { runs } = {}) {
  const runId = job && job.runId;
  if (!runId) return UNKNOWN('this job did not come from an automation');
  if (typeof runs !== 'function') return UNKNOWN('no workflow-run store to check against');
  if (steps(job).some((s) => s.kind === 'end' && /stopped by you/i.test(textOf(s)))) {
    return UNKNOWN('the owner stopped this one — the flow carrying on is not a verdict on it');
  }
  let run = null;
  try { run = runs(String(runId)); } catch (e) { return UNKNOWN(`could not read the run: ${e.message}`); }
  if (!run) return UNKNOWN(`no run record for ${runId}`);
  const st = String(run.status || '').toLowerCase();
  if (st === 'done') return PASS(`the automation "${run.name || runId}" completed with this job in it`, `run ${runId} done`);
  if (st === 'error') return FAIL(`the automation "${run.name || runId}" ended in error`, String(run.error || '').slice(0, 120));
  return UNKNOWN(`the automation is ${st || 'in an unknown state'}`);
}

/** Did it actually write anything down? Findings are an artefact; a summary is not. */
/*
 * EVERY LIST A TOOL CAN FILL, READ OFF THE JOB ITSELF.
 *
 * This used to be six names kept by hand, and it had fallen behind the tools: `results`,
 * `searchQueries` and `gscHealth` were missing, so a run that saved five businesses with `collect`
 * reported "nothing was written" and was filed as silver. The rows were right there.
 *
 * Deriving it means a tool added next month counts on the day it ships, with nobody remembering to
 * edit a list — which is the same failure that lost six audit findings when `gscHealth` was missing
 * from the persisted shape.
 *
 * `steps`, `proposals` and `inbox` are the job's own machinery, not things a tool produced, so they
 * are named out. Everything else that is an array of rows is evidence.
 */
const NOT_RESULTS = new Set(['steps', 'proposals', 'inbox', 'lines']);

function bucketsOf(job) {
  const out = [];
  for (const [k, v] of Object.entries(job || {})) {
    if (NOT_RESULTS.has(k) || !Array.isArray(v) || !v.length) continue;
    out.push([k, v.length]);
  }
  return out;
}

/**
 * How many rows the REPORT says it produced, when it says so at all.
 *
 * Only a claim with a number attached can be checked, which is the point: "I saved five plumbers"
 * is checkable and "I saved some plumbers" is not, and pretending otherwise would invent failures.
 */
function claimedCount(report) {
  const r = String(report || '');
  /*
   * ANCHORED ON THE VERB, NOT THE NOUN.
   *
   * The first attempt listed nouns — leads, places, rows — and missed "saved five plumbers" because
   * reports use whatever word the task was about. The noun is unbounded; the verb is not, and only
   * a handful of verbs actually mean "I wrote this down".
   *
   * Deliberately narrow: "found three suppliers" is NOT a claim to have stored three, and treating
   * it as one would mark good runs as liars and poison the reject pile with them. A missed catch
   * costs one signal; a false catch teaches the model that correct behaviour is wrong.
   */
  /*
   * WRITTEN AS REGEX LITERALS ON PURPOSE.
   *
   * The first version built these with `new RegExp` inside a template literal, where \b is a
   * backspace character and \s and \d are just the letters s and d. It compiled, it ran, it matched
   * nothing, and every claim sailed through unchecked. A literal cannot be mis-escaped.
   */
  const DIGITS = /\b(?:saved|stored|recorded|logged|added|kept|wrote down)\s+(?:a\s+total\s+of\s+)?(\d{1,3})\b/gi;
  const WORDS = /\b(?:saved|stored|recorded|logged|added|kept|wrote down)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi;
  const spelled = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  let best = 0;
  let m;
  while ((m = DIGITS.exec(r))) best = Math.max(best, Number(m[1]) || 0);
  while ((m = WORDS.exec(r))) best = Math.max(best, spelled[m[1].toLowerCase()] || 0);

  /* A run that says it saved NOTHING is not claiming rows; zero is not a claim to check. */
  return best;
}


/**
 * ROWS A TOOL WROTE — and whether they match what the run said it did.
 *
 * Two different strengths, deliberately kept apart:
 *
 *   A CHECKED CLAIM is external truth. The report said five and five rows exist: the agent could not
 *     have produced those rows by writing prose, so something outside its own account agrees.
 *   ROWS WITH NO CLAIM are a good sign and nothing more. They prove the agent ACTED, not that the
 *     action was right — five saved leads may be five bad leads, and calling that gold would fill
 *     the top tier with work nobody checked.
 *
 * And it can now FAIL, which is the half that was missing entirely. A run claiming five leads that
 * wrote none used to pass through as an ordinary silver success. That contradiction is the scarcest
 * and most useful thing in the whole corpus.
 */
function resultsWereWritten(job) {
  const counts = bucketsOf(job);
  const total = counts.reduce((n, [, c]) => n + c, 0);
  const claimed = claimedCount(job && job.report);
  const detail = counts.map(([k, n]) => `${k}:${n}`).join(' ');

  if (claimed > 0 && total === 0) {
    return FAIL(`the report claims ${claimed} row(s) and none were written`, String(job && job.report || '').slice(0, 140));
  }
  if (!counts.length) return UNKNOWN('nothing was written to a results bucket');
  if (claimed > 0 && total < claimed) {
    return FAIL(`the report claims ${claimed} row(s) and ${total} were written`, detail);
  }

  /*
   * CONFIRMED MEANS THE NUMBERS AGREE, NOT THAT ONE EXCEEDS THE OTHER.
   *
   * The first rule promoted anything with at least as many rows as claimed, and produced lines like
   * "79 row(s) written, matching the 50 the report claims" — which is not a match, it is a report
   * that understates what happened. Harmless, but not evidence of anything, and treating it as
   * confirmation quietly fills the top tier with runs nobody checked.
   *
   * Either bucket may carry it: "I saved five leads" against leads:5 and places:1 is a confirmed
   * claim even though the total is six, because the five it named are there.
   */
  const exact = total === claimed || counts.some(([, n]) => n === claimed);
  if (claimed > 0 && exact) {
    return PASS(`${claimed} row(s) claimed and ${claimed} written`, detail);
  }
  if (claimed > 0) {
    return PASS(`${total} row(s) written, more than the ${claimed} claimed`, detail);
  }
  return PASS('rows were written', detail);
}

const VERIFIERS = {
  actWasApproved,
  automationRunCompleted,
  recordingCompleted,
  fileWasProduced,
  typedTextLanded,
  resultsWereWritten,
};

/** Which verifiers, when they pass, are external truth rather than a good sign. */
const EXTERNAL = new Set(['actWasApproved', 'automationRunCompleted', 'recordingCompleted', 'fileWasProduced', 'typedTextLanded']);

/**
 * `resultsWereWritten` is external ONLY when it checked a number against the report.
 *
 * Rows existing proves the agent acted. Rows matching a count the report gave proves something
 * outside the agent's own prose agrees with it, which is the whole definition of gold. Treating
 * every written row as external would have promoted a thousand unchecked runs overnight.
 *
 * The phrase matched here is "claimed and", which only the confirmed branch produces. An earlier
 * version tested for "written" — which also matches the plain "rows were written" of an unclaimed
 * run, and quietly promoted exactly the thousand runs this is meant to keep out. The wording is
 * load-bearing; change the sentence and this stops working, which is why the tests assert it.
 */
const externalWhen = (name, res) =>
  EXTERNAL.has(name) || (name === 'resultsWereWritten' && res && res.ok === true && /claimed and /.test(res.why || ''));

/**
 * WAS THIS THE AGENT'S DOING AT ALL?
 *
 * MEASURED BEFORE BEING BUILT, and the measurement is the whole argument. Of 707 jobs that the
 * tiering called bronze, exactly 22 were the agent's own decisions:
 *
 *     267  the owner pressed Stop
 *     165  no report at all, nothing to judge either way
 *     118  stale running — a pod roll cut it off mid-flight
 *      69  "every model key is out of allowance" — it ran out of credit
 *      42  the model or its API died
 *      20  the browser closed under it
 *       3  other infrastructure deaths
 *     ───
 *      22  a verifier actually FAILED, or it wandered into the step budget
 *
 * So punishing "bronze" would be ninety-seven percent punishing cancellations, deploys and an empty
 * account. A model trained that way learns the one lesson available: attempt less, finish sooner,
 * never take on anything long. That is worse than no training at all, and it would be invisible —
 * the loss would fall and the agent would quietly become useless.
 *
 * Hence a fourth outcome. `void` is neither reward nor punishment: excluded from the set entirely,
 * because it is evidence about the infrastructure and about the owner's attention, not about the
 * policy. The asymmetry is deliberate and it runs both ways — reward needs evidence, punishment
 * needs evidence, and the ABSENCE of evidence is void rather than blame.
 */
/*
 * A REPORT THAT ADMITS THE JOB WAS NOT DONE.
 *
 * Deliberately narrow, and the narrowness is the whole point. "I could not find any leads" is a
 * perfectly good OUTCOME - there were none. "I was unable to complete the query" is a statement
 * that the work did not happen. Only the second kind belongs here, so this matches admissions about
 * COMPLETING the task and never about what was found.
 */
const ADMITS_FAILURE = /(?:unable|not able) to (?:complete|finish|carry out|perform|do) |could not (?:complete|finish|carry out|perform) |failed to (?:complete|finish|carry out) |did not manage to /i;
function voidOf(job) {
  const all = steps(job);
  const txt = all.map((s) => textOf(s)).join(' \n ');
  const report = String((job && job.report) || '');
  const err = String((job && job.error) || '');
  const both = `${report} ${err} ${txt}`;

  /*
   * A STOP THAT ARRIVES AFTER THE ANSWER IS NOT AN INTERRUPTION.
   *
   * This used to test the whole transcript for `stopped by you` and void on sight. But the
   * console writes that line whenever the session ends, including when the owner reads the
   * finished report and closes the window - so a run that concluded on its own, wrote its
   * summary and stopped calling tools was thrown out of the set as though it had been cut off.
   *
   * Measured across all 2,292 jobs: 471 carry the line AND called finish, and in 469 of them
   * there is not one tool call between the finish and the stop. There is no run anywhere in the
   * corpus where a stop interrupted work that later finished - the ordering is always the other
   * way round. So the rule has never once fired on what it was written for, and it voided 23,635
   * turns doing it. The 189 runs that were stopped without ever finishing are the real
   * interruptions, and they still void below.
   *
   * The test is the ORDER, not the presence: only a stop that came before the run concluded says
   * anything about whether the work was worth learning from.
   */
  const stopAt = all.findIndex((s) => /stopped by you/i.test(textOf(s)));
  const finishedBeforeTheStop = stopAt >= 0
    && all.some((s, i) => i < stopAt && s && s.kind === 'tool' && s.tool === 'finish');
  if (stopAt >= 0 && !finishedBeforeTheStop) return { isVoid: true, reason: 'the owner stopped it' };
  if (job && job.status === 'running') return { isVoid: true, reason: 'still marked running — cut off by a deploy' };
  if (/out of allowance|no model key|every model key/i.test(both)) return { isVoid: true, reason: 'it ran out of model credit' };
  if (/model stopped answering|returned 5\d\d|rate limit|(?:^|[^0-9])429(?:[^0-9]|$)|was rejected \(401\)|Unauthorized/i.test(both)) {
    return { isVoid: true, reason: 'the model or its API failed' };
  }
  if (/Target page, context or browser has been closed|browser has been closed|context destroyed|session it was waiting for/i.test(both)) {
    return { isVoid: true, reason: 'the browser died under it' };
  }
  /* No report, no error, nothing verified: there is nothing here to learn from in either
     direction. Counting it as a failure is guessing, and guessing about blame is the expensive
     kind — 165 of the 707 sat in exactly this state. */
  if (!report && !err) return { isVoid: true, reason: 'it ended without a report and without an error — nothing to judge' };

  return { isVoid: false, reason: '' };
}

/**
 * THE LABEL, AND ITS REASONS.
 *
 *   gold    an external check passed. Train on these without hesitation.
 *   silver  nothing external could be checked, but it wrote a report and did not error. Usable with
 *           weight, never as the bulk of a training set.
 *   bronze  IT DID SOMETHING WRONG, and there is evidence: a verifier failed, or it wandered into
 *           the step budget without concluding. Only these are worth punishing — 22 of 2,222.
 *   void    an interruption, a deploy, an empty account, a dead browser. Neither rewarded nor
 *           punished, and kept out of the set entirely. See voidOf.
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
  const passedExternal = Object.entries(checks).filter(([n, r]) => r.ok === true && externalWhen(n, r));

  const report = String((job && job.report) || '').trim();
  const wandered = /step (limit|budget)/i.test(report);
  const voided = voidOf(job);

  /*
   * Order matters, and this is the one ordering decision in the file. A FAILED verifier outranks a
   * void reason: a job that claimed a file, produced none, and was then cancelled still told us
   * something true about its policy. Everything else that is void stays void.
   */
  if (failed.length) {
    return {
      tier: 'bronze', why: failed.map(([n, r]) => `${n}: ${r.why}`), checks,
      external: [], failures: failed.map(([n]) => n),
    };
  }
  /*
   * GOLD OUTRANKS VOID, and getting this the wrong way round cost 295 gold jobs on the first try.
   *
   * An owner stopping a run does not un-happen the verified thing the agent did before they
   * pressed it: the message landed, the file appeared. Those turns are good examples and the
   * interruption says nothing about them. Void is for a job with NOTHING verified and no fault
   * of its own.
   */
  /*
   * IT SAID SO ITSELF: NO GOLD FOR A RUN THAT REPORTS IT DID NOT DO THE JOB.
   *
   * The verifiers ask whether something outside the agent confirmed an ACTION, and typedTextLanded
   * confirms a keystroke. Measured on a live chain: a run reported "I was unable to complete the NS
   * journey planner query" after 60 calls, a refused tool and a stall - and graded GOLD, because
   * six things it typed had landed on the page. The run beside it that actually produced the answer
   * in 11 clean calls graded `clean`, which the sampler draws AFTER gold. The order was: failed and
   * flailing first, succeeded cleanly third.
   *
   * A confirmed keystroke is evidence about the keyboard, not about the goal. When the agent's own
   * account says the job was not done, there is no success to tier - and no lie to punish either,
   * because it told the truth. That is void: excluded from the set, blamed for nothing. The same
   * asymmetry as everywhere else in this file - reward needs evidence, punishment needs evidence,
   * and an absence is neither.
   */
  if (passedExternal.length && ADMITS_FAILURE.test(report)) {
    return {
      tier: 'void', why: ['it reported that it could not complete the job'], checks,
      external: passedExternal.map(([n]) => n), failures: [],
      voidReason: 'it reported that it could not complete the job',
    };
  }
  if (passedExternal.length) {
    return {
      tier: 'gold', why: passedExternal.map(([n, r]) => `${n}: ${r.why}`), checks,
      external: passedExternal.map(([n]) => n), failures: [],
      /* Gold, and still says how it ended: a verified job that was cut off afterwards is worth
         learning from AND worth knowing was cut off. */
      ...(voided.isVoid ? { endedBy: voided.reason } : {}),
    };
  }
  if (voided.isVoid) {
    return { tier: 'void', why: [voided.reason], checks, external: [], failures: [], voidReason: voided.reason };
  }
  if (wandered) {
    /* It was asked to conclude and did not. That IS a policy failure, and one of the few worth
       punishing: the lesson "stop and report" is exactly what a small model needs taught. */
    return { tier: 'bronze', why: ['it ran into the step budget without concluding'], checks, external: [], failures: ['wandered'] };
  }
  if (report) {
    return { tier: 'silver', why: ['a report and no error, but nothing external to check'], checks, external: [], failures: [] };
  }
  return { tier: 'void', why: ['nothing to judge'], checks, external: [], failures: [], voidReason: 'nothing to judge' };
}

module.exports = { outcomeOf, voidOf, VERIFIERS, EXTERNAL, UNKNOWN, PASS, FAIL };
