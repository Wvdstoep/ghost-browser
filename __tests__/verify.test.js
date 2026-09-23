/*
 * THE REWARD SIGNAL, AND THE FIFTY CASES THAT CORRECTED IT.
 *
 * The first version of typedTextLanded looked for the typed text in a later `read`, `open` or `look`
 * step and concluded 1,320 times that nothing had landed. Fifty of those were then read by hand:
 * 47 were this verifier being blind, 2 were real errors, 1 was the owner pressing Stop.
 *
 * Relabelling the corpus with the fix moved gold from 59 to 379 and the caught-claim count from 352
 * to 14. Every case below is taken from those fifty, so a future change that reintroduces the blind
 * spot fails here instead of quietly condemning three hundred good jobs again.
 */
import { describe, it, expect } from 'vitest';
import { outcomeOf, VERIFIERS } from '../src/verify.js';

const { typedTextLanded, fileWasProduced, actWasApproved, recordingCompleted, automationRunCompleted } = VERIFIERS;

const job = (steps, over = {}) => ({
  id: 'j-1', role: 'useme.proposal', goal: 'write a proposal', report: 'done',
  createdAt: '2026-09-01T10:00:00.000Z', endedAt: '2026-09-01T10:05:00.000Z',
  status: 'idle', error: '', proposals: [], steps, ...over,
});

describe('a typed value is confirmed by the platform\'s own receipt', () => {
  it('accepts the `type`-kind echo that follows the call — the 47 of 50 case', () => {
    /* [tool:type] type([5] "I build and deploy…")
       [type]      typed into [5] "about_me_en": I build and deploy…       <- this is the receipt */
    const r = typedTextLanded(job([
      { n: 1, kind: 'tool', tool: 'type', args: { text: 'I build and deploy custom web applications — CRM systems' } },
      { n: 2, kind: 'type', text: 'typed into [5] "about_me_en": I build and deploy custom web applications — CRM sys' },
      { n: 3, kind: 'tool', tool: 'scroll', args: {} },
    ]));
    expect(r.ok).toBe(true);
  });

  it('accepts a paste receipt, which carries a count and no text', () => {
    /* [type] pasted 317 chars into [30] — no text to match, but the platform says it went in. */
    const r = typedTextLanded(job([
      { n: 1, kind: 'tool', tool: 'paste_text', args: { text: 'Step-by-step walkthroughs showing you exactly how' } },
      { n: 2, kind: 'type', text: 'pasted 317 chars into [30]' },
    ]));
    expect(r.ok).toBe(true);
  });

  it('accepts an `acted` receipt for a message that was sent rather than typed', () => {
    const r = typedTextLanded(job([
      { n: 1, kind: 'tool', tool: 'type', args: { text: 'Też cię bardzo kocham, morgen samen iets doen' } },
      { n: 2, kind: 'acted', text: 'message: "Też cię bardzo kocham, morgen samen iets doen"' },
    ]));
    expect(r.ok).toBe(true);
  });

  it('still accepts the text simply appearing on a later read', () => {
    const r = typedTextLanded(job([
      { n: 1, kind: 'tool', tool: 'type', args: { text: 'inventory management ecommerce' } },
      { n: 2, kind: 'tool', tool: 'look', args: {} },
      { n: 3, kind: 'read', text: 'results for inventory management ecommerce — 12 items' },
    ]));
    expect(r.ok).toBe(true);
  });

  it('matches on the first 30 characters, because the receipt itself is truncated', () => {
    /* Matching more than the receipt holds would fail every long message, which is most of them. */
    const long = 'Projektuję i wdrażam działające aplikacje webowe i systemy SaaS — nie makiety, lecz gotowe';
    const r = typedTextLanded(job([
      { n: 1, kind: 'tool', tool: 'type', args: { text: long } },
      { n: 2, kind: 'type', text: 'typed into [25] "about_me_en": ' + long.slice(0, 60) },
    ]));
    expect(r.ok).toBe(true);
  });
});

describe('and the three real outcomes the fifty actually contained', () => {
  it('FAILS when the type itself errored — "Element [9] not found in last analysis"', () => {
    const r = typedTextLanded(job([
      { n: 1, kind: 'tool', tool: 'type', args: { text: 'strony internetowe' } },
      { n: 2, kind: 'error', text: 'type: Element [9] not found in last analysis. Call analyze_page first.' },
    ]));
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/errored/);
  });

  it('FAILS when the browser died under it', () => {
    const r = typedTextLanded(job([
      { n: 1, kind: 'tool', tool: 'type', args: { text: 'Cinematic ambient instrumental, warm analog pads' } },
      { n: 2, kind: 'error', text: 'type: keyboard.type: Target page, context or browser has been closed' },
    ]));
    expect(r.ok).toBe(false);
  });

  it('is UNKNOWN, never a failure, when the owner pressed Stop', () => {
    /*
     * The one that matters most for training: an owner cancelling a run is not the agent lying, and
     * scoring it as a failure turns every interruption into a negative example.
     */
    const r = typedTextLanded(job([
      { n: 1, kind: 'tool', tool: 'type', args: { text: 'Projektuję i wdrażam działające aplikacje' } },
      { n: 2, kind: 'end', text: 'stopped by you' },
    ]));
    expect(r.ok).toBeNull();
    expect(r.why).toMatch(/stopped/);
  });

  it('FAILS a genuinely unconfirmed type in a run that finished normally', () => {
    const r = typedTextLanded(job([
      { n: 1, kind: 'tool', tool: 'type', args: { text: 'a sentence with no receipt anywhere after it' } },
      { n: 2, kind: 'tool', tool: 'look', args: {} },
      { n: 3, kind: 'look', text: 'a completely unrelated page — 4 things to click' },
      { n: 4, kind: 'done', text: 'finished' },
    ]));
    expect(r.ok).toBe(false);
  });

  it('is UNKNOWN when the job never typed anything, not a pass', () => {
    expect(typedTextLanded(job([{ n: 1, kind: 'tool', tool: 'look', args: {} }])).ok).toBeNull();
  });
});

describe('a verifier never guesses, because a guess mints false gold', () => {
  it('cannot check a file without a file store, so it says so', () => {
    const j = job([{ n: 1, kind: 'tool', tool: 'download_url', args: { url: 'https://x/v.mp4' } }]);
    expect(fileWasProduced(j, {}).ok).toBeNull();
  });

  it('fails a claimed file that never appeared', () => {
    const j = job([{ n: 1, kind: 'tool', tool: 'download_url', args: { url: 'https://x/v.mp4' } }]);
    expect(fileWasProduced(j, { files: () => [] }).ok).toBe(false);
  });

  it('will not count a zero-byte file as a file', () => {
    const j = job([{ n: 1, kind: 'tool', tool: 'download_url', args: {} }]);
    const at = '2026-09-01T10:02:00.000Z';
    expect(fileWasProduced(j, { files: () => [{ name: 'v.mp4', size: 0, at }] }).ok).toBe(false);
    expect(fileWasProduced(j, { files: () => [{ name: 'v.mp4', size: 1024, at }] }).ok).toBe(true);
  });

  it('will not let a job claim a file produced outside its own window', () => {
    const j = job([{ n: 1, kind: 'tool', tool: 'download_url', args: {} }]);
    const old = { name: 'other.mp4', size: 99, at: '2026-08-01T10:00:00.000Z' };
    expect(fileWasProduced(j, { files: () => [old] }).ok).toBe(false);
  });

  it('treats an undecided proposal as undecided', () => {
    expect(actWasApproved(job([], { proposals: [{ pid: 'p1' }] })).ok).toBeNull();
    expect(actWasApproved(job([], { proposals: [{ pid: 'p1', state: 'approved' }] })).ok).toBe(true);
    expect(actWasApproved(job([], { proposals: [{ pid: 'p1', state: 'denied' }] })).ok).toBe(false);
  });

  it('fails a recording that never finished with anything in it', () => {
    const j = job([{ n: 1, kind: 'tool', tool: 'record_start', args: {}, recording: 'rec-1' }]);
    expect(recordingCompleted(j, { recordings: () => [{ id: 'rec-1', state: 'failed', bytes: 0, seconds: 0 }] }).ok).toBe(false);
    expect(recordingCompleted(j, { recordings: () => [{ id: 'rec-1', state: 'done', bytes: 900000, seconds: 42 }] }).ok).toBe(true);
  });
});

describe('the tier, and the asymmetry that makes checking worth anything', () => {
  it('a failed check outranks a glowing report', () => {
    const j = job([{ n: 1, kind: 'tool', tool: 'download_url', args: {} }], { report: 'Exported the video successfully.' });
    expect(outcomeOf(j, { files: () => [] }).tier).toBe('bronze');
  });

  it('an external pass is gold', () => {
    const j = job([
      { n: 1, kind: 'tool', tool: 'type', args: { text: 'a confirmed sentence of some length' } },
      { n: 2, kind: 'type', text: 'typed into [3] "field": a confirmed sentence of some length' },
    ]);
    expect(outcomeOf(j, {}).tier).toBe('gold');
  });

  it('a report with nothing external to check is silver, never gold', () => {
    const j = job([{ n: 1, kind: 'tool', tool: 'look', args: {} }], { report: 'Had a look around.' });
    expect(outcomeOf(j, {}).tier).toBe('silver');
  });

  it('an INFRASTRUCTURE error is void, not bronze — it is no policy of the agent', () => {
    /* "context destroyed" is the browser dying under the agent. Punishing that teaches it to fear
       long tasks. Of 2,223 jobs, 950 are void for reasons like this one. */
    const j = job([{ n: 1, kind: 'tool', tool: 'look', args: {} }], { report: 'All good!', error: 'context destroyed' });
    const out = outcomeOf(j, {});
    expect(out.tier).toBe('void');
    expect(out.voidReason).toMatch(/browser died/);
  });

  it('running out of model credit is void, and stops existing once the model runs on the ring', () => {
    const j = job([{ n: 1, kind: 'tool', tool: 'look', args: {} }], { error: 'every model key is out of allowance for today' });
    expect(outcomeOf(j, {}).tier).toBe('void');
  });

  it('the owner pressing Stop is void, never a negative example', () => {
    const j = job([
      { n: 1, kind: 'tool', tool: 'look', args: {} },
      { n: 2, kind: 'end', text: 'stopped by you' },
    ], { report: '' });
    expect(outcomeOf(j, {}).tier).toBe('void');
  });

  it('a run that FINISHED and was then closed is not an interruption', () => {
    /*
     * The console writes `stopped by you` whenever the session ends, so the owner reading a
     * finished report and closing the window looked exactly like a cancellation. Measured across
     * all 2,292 jobs: 471 carried the line and had already called finish, 469 of them with no tool
     * call in between, and not one run anywhere was stopped and then finished. The rule had never
     * fired on a real interruption and had voided 23,635 turns.
     */
    const j = job([
      { n: 1, kind: 'tool', tool: 'look', args: {} },
      { n: 2, kind: 'tool', tool: 'finish', args: { summary: 'three listings, recorded' } },
      { n: 3, kind: 'done', text: 'three listings, recorded' },
      { n: 4, kind: 'end', text: 'stopped by you' },
    ], { report: 'Recorded 3 leads.' });
    expect(outcomeOf(j, {}).tier).not.toBe('void');
  });

  it('still voids a stop that came before the run ever concluded', () => {
    /* The 189 runs with no finish at all are the real cancellations and must stay out of the set. */
    const j = job([
      { n: 1, kind: 'tool', tool: 'look', args: {} },
      { n: 2, kind: 'end', text: 'stopped by you' },
    ], { report: 'Got partway.' });
    expect(outcomeOf(j, {}).tier).toBe('void');
  });
  it('credits a document the browser printed, not only one it downloaded', () => {
    /*
     * The claim was read off the TOOL NAME and matched download/upload_file/export, so a run that
     * composed a real PDF with make_document could never be confirmed. Measured on the first walk
     * the collector ever dispatched: it wrote amsterdam-rotterdam-the-hague-comparison.pdf at
     * 49,694 bytes, eleven clean calls, and graded silver with the file sitting in the store.
     *
     * craft.js writes a download-kind step only AFTER the bytes exist, so that step is the
     * browser's own receipt and is what this keys on.
     */
    const j = job([
      { n: 1, kind: 'tool', tool: 'make_document', args: {} },
      { n: 2, kind: 'download', text: 'made cities.pdf (49694 bytes) as asset a1' },
    ], { report: 'I compared the three cities and produced a document.' });
    /* Inside the job's own window, which is what fileWasProduced checks - a file from a week later
       proves nothing about this run. */
    const files = () => [{ at: '2026-09-01T10:03:00.000Z', name: 'cities.pdf', size: 49694 }];
    const out = outcomeOf(j, { files });
    expect(out.tier).toBe('gold');
    expect(out.external).toContain('fileWasProduced');
  });

  it('does NOT accuse a run whose document failed to print', () => {
    /*
     * The asymmetry is the point. A make_document that could not print observes an error and writes
     * no receipt, so there is no claim to check and the run stays silver. A tool that broke is not a
     * run that lied, and inventing that accusation is worse than missing the catch.
     */
    const j = job([
      { n: 1, kind: 'tool', tool: 'make_document', args: {} },
      { n: 2, kind: 'read', text: 'The document could not be printed. Check the HTML is valid.' },
    ], { report: 'I could not produce the document, so here are the figures instead.' });
    const out = outcomeOf(j, { files: () => [] });
    expect(out.tier).not.toBe('bronze');
    expect(out.checks.fileWasProduced.ok).not.toBe(false);
  });
  it('a run that said so itself is not gold, however many keystrokes landed', () => {
    /*
     * A confirmed keystroke is evidence about the keyboard, not about the goal. Measured on a live
     * chain: a run reported "I was unable to complete the NS journey planner query" after 60 calls,
     * a refused tool and a stall - and graded GOLD, because six things it typed had landed. The run
     * beside it that produced the actual answer in 11 clean calls graded `clean`, which the sampler
     * draws AFTER gold. Failed-and-flailing first, succeeded-cleanly third.
     *
     * Void, not bronze: it told the truth, so there is nothing to punish, and no success to reward.
     */
    const j = job([
      { n: 1, kind: 'tool', tool: 'type', args: { text: 'Amsterdam Centraal' } },
      { n: 2, kind: 'type', text: 'typed into [11] "station": Amsterdam Centraal' },
    ], { report: 'I was unable to complete the journey planner query. Here is what happened.' });
    const out = outcomeOf(j, {});
    expect(out.tier).toBe('void');
    expect(out.why.join(' ')).toMatch(/could not complete/);
  });

  it('but "I could not find any" is a RESULT, not a failure to work', () => {
    /* There were none. That is an answer, and a run that reports it honestly keeps its tier. */
    const j = job([
      { n: 1, kind: 'tool', tool: 'type', args: { text: 'handmade webshop' } },
      { n: 2, kind: 'type', text: 'typed into [3] "search": handmade webshop' },
    ], { report: 'I could not find any companies matching that in the first three pages.' });
    expect(outcomeOf(j, {}).tier).toBe('gold');
  });

  it('but a verified success that was THEN stopped stays gold', () => {
    /* Getting this the wrong way round cost 295 gold jobs on the first attempt: an interruption does
       not un-happen what the agent verifiably did before it. */
    const j = job([
      { n: 1, kind: 'tool', tool: 'type', args: { text: 'a confirmed sentence of some length' } },
      { n: 2, kind: 'type', text: 'typed into [3] "field": a confirmed sentence of some length' },
      { n: 3, kind: 'end', text: 'stopped by you' },
    ], { report: '' });
    const out = outcomeOf(j, {});
    expect(out.tier).toBe('gold');
    expect(out.endedBy).toMatch(/stopped/);
  });

  it('wandering into the step budget IS punished — that is a policy failure', () => {
    const j = job([{ n: 1, kind: 'tool', tool: 'look', args: {} }], { report: 'Paused at the 40-step limit — 0 leads so far.' });
    const out = outcomeOf(j, {});
    expect(out.tier).toBe('bronze');
    expect(out.failures).toContain('wandered');
  });

  it('a failed verifier outranks even a void reason, because it still says something true', () => {
    const j = job([
      { n: 1, kind: 'tool', tool: 'download_url', args: {} },
      { n: 2, kind: 'end', text: 'stopped by you' },
    ], { report: 'Exported it.' });
    expect(outcomeOf(j, { files: () => [] }).tier).toBe('bronze');
  });

  it('a verifier that throws does not take the label down with it', () => {
    const j = job([{ n: 1, kind: 'tool', tool: 'download_url', args: {} }]);
    const out = outcomeOf(j, { files: () => { throw new Error('store offline'); } });
    expect(['bronze', 'silver']).toContain(out.tier);
  });
});

/*
 * THE OTHER DRAWER.
 *
 * /profiles/jobs held 2,223 agent walks and the labeller knew about it. /profiles/workflow-runs held
 * 1,837 automation runs and it did not — and that is the better corpus, because an automation runs a
 * route somebody already proved: 1,570 of the 1,837 completed.
 *
 * 964 jobs carry a runId, every one matches a run record, and 885 belong to a run that finished.
 * Joining the two moved gold from 379 to 1,147. One lookup.
 */
describe('the automation a job belonged to', () => {
  const withRun = (runId, run, extraSteps = []) => job(
    [{ n: 1, kind: 'tool', tool: 'look', args: {} }, ...extraSteps],
    { runId, report: 'had a look' },
  );
  const store = (run) => ({ runs: () => run });

  it('a completed automation is external corroboration, so it mints gold', () => {
    /* Weaker than a person approving, stronger than the agent reporting: a later node consumed
       this job's output and the run carried on. */
    const r = automationRunCompleted(withRun('r-1', null), store({ id: 'r-1', status: 'done', name: 'facebook notify' }));
    expect(r.ok).toBe(true);
    expect(outcomeOf(withRun('r-1', null), store({ id: 'r-1', status: 'done' })).tier).toBe('gold');
  });

  it('an automation that ended in error is punished', () => {
    const r = automationRunCompleted(withRun('r-2', null), store({ id: 'r-2', status: 'error', error: 'node 3 threw' }));
    expect(r.ok).toBe(false);
    expect(outcomeOf(withRun('r-2', null), store({ id: 'r-2', status: 'error' })).tier).toBe('bronze');
  });

  it('an interrupted automation says nothing either way', () => {
    expect(automationRunCompleted(withRun('r-3', null), store({ id: 'r-3', status: 'interrupted' })).ok).toBeNull();
  });

  it('REFUSES to read a completed flow as a verdict on a job the owner stopped', () => {
    /* A flow carrying on regardless does not turn an interruption into a judgement, and
       owner-stopped is the one state that is neither rewarded nor punished anywhere here. */
    const j = withRun('r-4', null, [{ n: 2, kind: 'end', text: 'stopped by you' }]);
    expect(automationRunCompleted(j, store({ id: 'r-4', status: 'done' })).ok).toBeNull();
    expect(outcomeOf(j, store({ id: 'r-4', status: 'done' })).tier).toBe('void');
  });

  it('is unknown for a walk that never came from an automation', () => {
    expect(automationRunCompleted(job([]), store({ status: 'done' })).ok).toBeNull();
  });

  it('is unknown when the run store is missing or has no record', () => {
    expect(automationRunCompleted(withRun('r-5', null), {}).ok).toBeNull();
    expect(automationRunCompleted(withRun('r-5', null), { runs: () => null }).ok).toBeNull();
  });

  it('does not take the label down when the run store throws', () => {
    const j = withRun('r-6', null);
    expect(automationRunCompleted(j, { runs: () => { throw new Error('volume gone'); } }).ok).toBeNull();
    expect(['silver', 'void']).toContain(outcomeOf(j, { runs: () => { throw new Error('volume gone'); } }).tier);
  });
});
