/*
 * ROWS A TOOL WROTE, AND WHETHER THE RUN TOLD THE TRUTH ABOUT THEM.
 *
 * This verifier had two holes, and both were silent:
 *
 *   IT LOOKED IN SIX NAMED BUCKETS, kept by hand, and the tools had moved on. A run that saved five
 *     businesses with `collect` wrote them to `results`, which was not on the list, so the answer
 *     was "nothing was written" and the run was filed as silver with its evidence sitting right
 *     there. Every new tool would repeat it.
 *   IT COULD NOT FAIL. A run claiming five leads that wrote none passed through as an ordinary
 *     success. A contradiction between what a run says and what it did is the scarcest and most
 *     useful thing in the corpus, and this one was invisible.
 *
 * The third danger is the opposite: inventing failures. A false catch teaches the model that
 * correct behaviour is wrong, which is worse than missing one, so the claim has to be narrow.
 */
import { describe, it, expect } from 'vitest';
import { outcomeOf } from '../src/verify.js';

const tierOf = (job) => outcomeOf(job, {}).tier;
const whyOf = (job) => (outcomeOf(job, {}).why || []).join('; ');
/* The verifier own answer, which differs from the tier reason: an UNKNOWN check does not appear in
   the outcome why at all, so asserting on the outcome would be asserting on the wrong sentence. */
const checkOf = (job) => (outcomeOf(job, {}).checks || {}).resultsWereWritten || {};

describe('finding the rows, wherever a tool put them', () => {
  it('SEES A BUCKET NOBODY REMEMBERED TO LIST', () => {
    /* `results` is where `collect` writes, and it was not among the six hand-kept names. This is
       the Maps-style run: open five businesses, save each one. */
    expect(checkOf({ report: 'Saved the ones I opened.', results: [1, 2, 3] }).why).toMatch(/rows were written/);
  });

  it('sees buckets that do not exist yet', () => {
    /* Derived from the job, so a tool shipped next month counts on the day it ships. */
    expect(checkOf({ report: 'Done.', somethingNewNextMonth: [1, 2] }).why).toMatch(/rows were written/);
  });

  it('does not count the job own machinery as results', () => {
    /* Steps and proposals are how a job works, not things a tool produced. Counting them would make
       every run that took a single step look like it had written data. */
    expect(checkOf({ report: 'Done.', steps: [1, 2, 3], proposals: [1] }).why).toMatch(/nothing was written/);
  });
});

describe('checking the claim', () => {
  it('CONFIRMS A CLAIM THE ROWS AGREE WITH, and that is external truth', () => {
    /* The agent cannot produce rows by writing prose, so a count that matches is something outside
       its own account agreeing with it — the whole definition of gold. */
    const j = { report: 'I saved five plumbers with their websites.', results: [1, 2, 3, 4, 5] };
    expect(tierOf(j)).toBe('gold');
    expect(whyOf(j)).toMatch(/5 row\(s\) claimed and 5 written/);
  });

  it('accepts the claim when one bucket carries it, even if the total is larger', () => {
    /* "I saved 5 leads" against leads:5 and places:1 is confirmed — the five it named are there. */
    expect(tierOf({ report: 'I saved 5 leads.', leads: [1, 2, 3, 4, 5], results: [9] })).toBe('gold');
  });

  it('CATCHES A CLAIM THAT WROTE NOTHING', () => {
    const j = { report: 'I saved 4 leads for you.' };
    expect(tierOf(j)).toBe('bronze');
    expect(whyOf(j)).toMatch(/claims 4 row\(s\) and none were written/);
  });

  it('catches a claim that wrote fewer', () => {
    expect(tierOf({ report: 'I saved five plumbers.', results: [1, 2] })).toBe('bronze');
  });

  it('DOES NOT CALL "MORE THAN CLAIMED" A CONFIRMATION', () => {
    /* The first rule promoted anything with at least as many rows as claimed and produced
       "79 row(s) written, matching the 50 the report claims" — which is not a match, it is a report
       that understates. Harmless, but evidence of nothing, and calling it gold fills the top tier
       with runs nobody checked. */
    const j = { report: 'I saved 50 rows.', results: new Array(79).fill(1) };
    expect(tierOf(j)).toBe('silver');
    expect(whyOf(j)).not.toMatch(/claimed and/);
  });
});

describe('the failures it must NOT invent', () => {
  it('does not treat FINDING things as claiming to have stored them', () => {
    /* "found three suppliers but none matched" is a correct outcome, not a lie. A false catch
       teaches the model that right behaviour is wrong, which costs more than a missed catch. */
    expect(tierOf({ report: 'I found three suppliers but none of them matched.' })).toBe('silver');
  });

  it('does not invent a claim from a number that is not a count of rows', () => {
    expect(tierOf({ report: 'The page took 5 seconds to load and I read 3 sections.' })).toBe('silver');
  });

  it('leaves a report with no number alone', () => {
    expect(tierOf({ report: 'Saved the businesses I opened.', results: [1, 2, 3] })).toBe('silver');
    expect(tierOf({ report: 'Read the page and summarised it.' })).toBe('silver');
  });

  it('rows on their own prove the agent ACTED, not that it was right', () => {
    /* Five saved leads may be five bad leads. Promoting every written row to gold would have moved
       a thousand unchecked runs into the tier that is supposed to mean verified. */
    expect(tierOf({ report: 'Looked around and reported back.', results: [1, 2] })).toBe('silver');
  });
});
