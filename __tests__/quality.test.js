/*
 * HOW THE WORK WAS DONE — the axis the tiers never measured.
 *
 * A tier says whether something outside the agent's own account confirmed the outcome. It is silent
 * on method, so a job done in eight clean steps and the same job done in sixty confused ones are
 * both gold and both weigh the same.
 *
 * Measured across 1,230 usable runs: 693 clean ones supplied 10,468 turns and 537 messy ones
 * supplied 29,627. Clean runs are 56% of the runs and 26% of the data, because flailing produces
 * more examples per run — so the set has been teaching the flail, which is what round one learnt.
 */
import { describe, it, expect } from 'vitest';
import { qualityOf, gradeOf, rankOf } from '../src/quality.js';

const call = (n, tool, args = {}) => ({ n, kind: 'tool', tool, args });
const said = (n, kind, text) => ({ n, kind, text });

const goodRun = {
  steps: [
    said(1, 'you', 'find the CSV'),
    call(2, 'open', { url: 'https://example.com' }),
    said(3, 'open', 'https://example.com'),
    call(4, 'look'),
    said(5, 'look', 'example — 3 things to click'),
    call(6, 'download_link', { index: 2 }),
    said(7, 'read', 'saved rates.csv'),
    call(8, 'finish', { summary: 'done' }),
  ],
};

describe('a run done well', () => {
  it('is clean when it decided to stop and nothing got in its way', () => {
    const q = qualityOf(goodRun);
    expect(q.clean).toBe(true);
    expect(q.marks).toEqual([]);
    expect(q.finished).toBe(true);
  });
});

describe('the four things that make a run worth less', () => {
  it('NEVER FINISHING — it was cut off, not concluded', () => {
    /* A run that hit the step limit ran out of road. Its last turns are a model with nowhere left
       to go, not a model deciding it is done. 112 runs in the corpus end this way. */
    const q = qualityOf({ steps: goodRun.steps.slice(0, 7) });
    expect(q.clean).toBe(false);
    expect(q.marks.join(' ')).toMatch(/never finished/);
  });

  it('A REFUSED TOOL — the run was given the wrong brief', () => {
    /* What follows a refusal is the agent working around a wall. 306 runs contain one, and that is
       a habit worth not teaching. */
    const q = qualityOf({
      steps: [...goodRun.steps.slice(0, 5),
        call(6, 'save_place', {}),
        said(7, 'blocked', 'refused save_place — this walk\'s role (google.research) does not have it'),
        call(8, 'finish', {})],
    });
    expect(q.clean).toBe(false);
    expect(q.refused).toBe(true);
  });

  it('does NOT punish a single nudge, because that is the guard working', () => {
    /*
     * The loop nudges after four observe-only calls in a row and journals one line per streak.
     * `scroll` counts as observe-only, so look -> scroll -> look -> scroll trips it - which is
     * simply how anyone reads a long listing page.
     *
     * Measured on the run that first exercised choose_option: 17 run_script calls, 3 looks, a
     * correct answer in 31 calls, graded untidy for scrolling a Marktplaats page twice. Over 2,313
     * runs, 599 carry the line and 320 carry exactly one; treating one as a stall cost 37 runs
     * their `best` grade and 77 their `clean`, against a `best` population of 82.
     */
    const q = qualityOf({
      steps: [...goodRun.steps.slice(0, 5),
        said(6, 'blocked', '4 looks/reads in a row with no action — forcing an action'),
        call(7, 'finish', {})],
    });
    expect(q.nudges).toBe(1);
    expect(q.stalled).toBe(false);
    expect(q.clean).toBe(true);
  });

  it('STALLING — nudged again and again, which is a run going in circles', () => {
    const q = qualityOf({
      steps: [...goodRun.steps.slice(0, 5),
        said(6, 'blocked', '4 looks/reads in a row with no action — forcing an action'),
        call(7, 'look'),
        said(8, 'blocked', '4 looks/reads in a row with no action — forcing an action'),
        call(9, 'finish', {})],
    });
    expect(q.nudges).toBe(2);
    expect(q.stalled).toBe(true);
    expect(q.clean).toBe(false);
  });


  it('REPEATING ITSELF — it did not read the answer to the first call', () => {
    const steps = [said(1, 'you', 'g')];
    for (let i = 0; i < 5; i++) steps.push(call(i + 2, 'read', {}));
    steps.push(call(9, 'finish', {}));
    const q = qualityOf({ steps });
    expect(q.clean).toBe(false);
    expect(q.repeats).toBeGreaterThan(2);
  });

  it('tolerates a single retry, because one is ordinary', () => {
    const q = qualityOf({
      steps: [said(1, 'you', 'g'), call(2, 'read', {}), call(3, 'read', {}), call(4, 'finish', {})],
    });
    expect(q.clean).toBe(true);
  });

  it('says WHAT was wrong, because "messy" tells nobody what to fix', () => {
    /* A refusal is a role problem, a stall is a model problem, never finishing is usually a budget
       problem. One word for all three would send every one of them to the wrong place. */
    const q = qualityOf({ steps: [said(1, 'blocked', 'refused act — this walk\'s role does not have it')] });
    expect(q.marks.length).toBeGreaterThan(0);
    expect(q.marks.some((m) => /does not carry/.test(m))).toBe(true);
  });
});

describe('ranking a run for a sampler', () => {
  it('PUTS A CLEAN VERIFIED RUN ABOVE AN UNTIDY VERIFIED ONE', () => {
    /* The point of the whole file. Both are gold — something outside the agent confirmed both — and
       only one of them is worth copying. */
    expect(gradeOf(goodRun, 'gold')).toBe('best');
    expect(gradeOf({ steps: goodRun.steps.slice(0, 7) }, 'gold')).toBe('gold');
    expect(rankOf('best')).toBeLessThan(rankOf('gold'));
  });

  it('keeps a clean unverified run above an untidy unverified one', () => {
    expect(gradeOf(goodRun, 'silver')).toBe('clean');
    expect(rankOf('clean')).toBeLessThan(rankOf('silver'));
  });

  it('never lifts an unverified run above a verified one', () => {
    /* Method does not replace evidence. A tidy run that nothing confirmed is still worth less than
       a scruffy one that produced a file with bytes in it. */
    expect(rankOf('clean')).toBeGreaterThan(rankOf('gold'));
  });

  it('leaves bronze and void where they are', () => {
    expect(gradeOf(goodRun, 'bronze')).toBe('bronze');
    expect(gradeOf(goodRun, 'void')).toBe('void');
  });
});
