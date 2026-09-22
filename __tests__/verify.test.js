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

const { typedTextLanded, fileWasProduced, actWasApproved, recordingCompleted } = VERIFIERS;

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

  it('an errored job is bronze whatever it wrote', () => {
    const j = job([{ n: 1, kind: 'tool', tool: 'look', args: {} }], { report: 'All good!', error: 'context destroyed' });
    expect(outcomeOf(j, {}).tier).toBe('bronze');
  });

  it('a verifier that throws does not take the label down with it', () => {
    const j = job([{ n: 1, kind: 'tool', tool: 'download_url', args: {} }]);
    const out = outcomeOf(j, { files: () => { throw new Error('store offline'); } });
    expect(['bronze', 'silver']).toContain(out.tier);
  });
});
