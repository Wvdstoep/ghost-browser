/*
 * THE GATE IN FRONT OF AN UNATTENDED TRAINING ROUND.
 *
 * The loop is meant to improve by itself, so nobody will be reading the numbers. Two of the filters
 * written today were quietly too aggressive and both were caught only because someone was looking:
 * one condemned 319 good jobs, the other discarded every job's opening move. A nightly round has
 * nobody looking.
 *
 * So every case below is a real failure from today, turned into something that halts the round
 * instead of training on it.
 */
import { describe, it, expect } from 'vitest';
import { preflight, explain, MUST_SURVIVE } from '../src/preflight.js';

const turn = (over = {}) => ({
  jobId: 'j-1', role: 'research.web', goal: 'find three suppliers',
  observed: [{ kind: 'read', text: 'a page' }],
  action: { tool: 'look', args: {} }, at: 2, tier: 'gold', ...over,
});

/* A healthy set: every must-survive tool present, distinct jobs, a real eval split. */
const healthy = () => {
  const train = [];
  MUST_SURVIVE.forEach((tool, i) => {
    for (let k = 0; k < 20; k++) train.push(turn({ jobId: `j-${i}-${k}`, action: { tool, args: {} } }));
  });
  const ev = [];
  for (let k = 0; k < 20; k++) ev.push(turn({ jobId: `e-${k}`, action: { tool: 'look', args: {} } }));
  return { train, eval: ev, reject: [] };
};

const manifest = (over = {}) => ({
  tiers: { gold: 1147, silver: 96, bronze: 152, void: 829 },
  turns: { train: 100, eval: 20, reject: 30 },
  kept: { train: 100, eval: 20, reject: 30 },
  droppedTurns: {},
  ...over,
});

describe('a healthy set passes and says so', () => {
  it('passes', () => {
    const sets = healthy();
    const r = preflight(manifest({ kept: { train: sets.train.length, eval: sets.eval.length } }), null, sets);
    expect(r.ok, r.halts.join('; ')).toBe(true);
    expect(explain(r)).toMatch(/PASSED/);
  });

  it('notes the absence of a previous round rather than treating it as a shrink', () => {
    const r = preflight(manifest(), null, healthy());
    expect(r.notes.join(' ')).toMatch(/no previous round/);
  });
});

describe('it halts on the two filter bugs from today', () => {
  it('halts when one exclusion reason ate the data — the opening-move bug', () => {
    /* `nothing had been observed yet` keyed on the step number instead of the turn, so it discarded
       every job's first decision. Nothing legitimate removes a quarter of the turns. */
    const sets = healthy();
    const m = manifest({ droppedTurns: { 'nothing had been observed yet': 4000 }, kept: { train: sets.train.length, eval: sets.eval.length } });
    const r = preflight(m, null, sets);
    expect(r.ok).toBe(false);
    expect(r.halts.join(' ')).toMatch(/nothing had been observed yet.*removed/);
  });

  it('halts when gold collapses — the verifier-regression bug', () => {
    /* typedTextLanded once condemned 319 good jobs, and gold falling was the only visible symptom. */
    const sets = healthy();
    const last = manifest({ tiers: { gold: 1147, silver: 96, bronze: 152, void: 829 } });
    const now = manifest({ tiers: { gold: 59, silver: 1138, bronze: 1026, void: 0 }, kept: { train: sets.train.length, eval: sets.eval.length } });
    const r = preflight(now, last, sets);
    expect(r.ok).toBe(false);
    expect(r.halts.join(' ')).toMatch(/gold fell/);
  });
});

describe('it halts on the things that would make a measurement a lie', () => {
  it('halts when a job is in both the training and evaluation sets', () => {
    const sets = healthy();
    sets.eval.push(turn({ jobId: sets.train[0].jobId }));
    const r = preflight(manifest({ kept: { train: sets.train.length, eval: sets.eval.length } }), null, sets);
    expect(r.ok).toBe(false);
    expect(r.halts.join(' ')).toMatch(/both the training and evaluation/);
  });

  it('halts on an empty training or evaluation set', () => {
    expect(preflight(manifest(), null, { train: [], eval: [turn()] }).halts.join(' ')).toMatch(/training set is empty/);
    expect(preflight(manifest(), null, { train: [turn()], eval: [] }).halts.join(' ')).toMatch(/evaluation set is empty/);
  });
});

describe('it halts when the set collapses against last night', () => {
  it('halts on a large shrink, because that should be somebody deciding', () => {
    const sets = healthy();
    const last = manifest({ turns: { train: 27704, eval: 5015, reject: 8712 } });
    const r = preflight(manifest({ kept: { train: sets.train.length, eval: sets.eval.length } }), last, sets);
    expect(r.ok).toBe(false);
    expect(r.halts.join(' ')).toMatch(/shrank \d+%/);
  });

  it('only warns on a small shrink', () => {
    const sets = healthy();
    const last = manifest({ turns: { train: sets.train.length + 8, eval: 20, reject: 0 } });
    const r = preflight(manifest({ kept: { train: sets.train.length, eval: sets.eval.length } }), last, sets);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/smaller than last round/);
  });

  it('reports growth as a note, not a problem', () => {
    const sets = healthy();
    const last = manifest({ turns: { train: 10, eval: 5, reject: 0 } });
    const r = preflight(manifest({ kept: { train: sets.train.length, eval: sets.eval.length } }), last, sets);
    expect(r.ok).toBe(true);
    expect(r.notes.join(' ')).toMatch(/grew/);
  });
});

describe('it halts when a tool would vanish from the lesson', () => {
  it('halts when finish is gone — a model cannot learn to stop from nothing', () => {
    const sets = healthy();
    sets.train = sets.train.filter((t) => t.action.tool !== 'finish');
    const r = preflight(manifest({ kept: { train: sets.train.length, eval: sets.eval.length } }), null, sets);
    expect(r.ok).toBe(false);
    expect(r.halts.join(' ')).toMatch(/no examples left of: finish/);
  });
});

describe('it halts when a kept job produced nothing', () => {
  it('catches jobs emptied by a turn-level filter', () => {
    /* The exact shape of both of today's bugs, seen from the other side. */
    const sets = healthy();
    const m = manifest({ kept: { train: 500, eval: 100 } });
    const r = preflight(m, null, sets);
    expect(r.ok).toBe(false);
    expect(r.halts.join(' ')).toMatch(/produced no turns at all/);
  });
});

describe('it halts on a secret that survived the scrub', () => {
  it('catches an email, a key, a token', () => {
    /* "we scrubbed it" is a claim; this is a check. The phone pattern once began with \\b, which
       cannot match before a "+", so every international number would have shipped. */
    for (const leak of ['write to sales@example.com', 'key gb_42c3f0aabbccdd', 'ya29.aVeryLongTokenValue', 'Authorization: Bearer abcdefghijklmnop']) {
      const sets = healthy();
      sets.train[0] = turn({ jobId: 'j-leak', goal: leak, action: { tool: 'look', args: {} } });
      const r = preflight(manifest({ kept: { train: sets.train.length, eval: sets.eval.length } }), null, sets);
      expect(r.ok, `did not catch: ${leak}`).toBe(false);
      expect(r.halts.join(' ')).toMatch(/did not hold/);
    }
  });
});

describe('the report reads without anyone watching it live', () => {
  it('leads with the verdict and lists halts before warnings', () => {
    const sets = healthy();
    sets.train = sets.train.filter((t) => t.action.tool !== 'click');
    const out = explain(preflight(manifest({ kept: { train: sets.train.length, eval: sets.eval.length } }), null, sets));
    expect(out.split('\n')[0]).toMatch(/^PRE-FLIGHT FAILED/);
    expect(out).toMatch(/^ {2}HALT {2}/m);
  });
});

describe('a deliberate filter, confirmed by naming it', () => {
  /* The comment always said a halt is lifted once somebody confirms it; the accept option is
     that somebody. It lifts only the halts the named reason explains. */
  const built = { train: Array.from({ length: 117 }, (_, i) => ({ jobId: `t${i}` })), eval: [{ jobId: 'e1' }] };
  const now = { droppedTurns: { 'a decision with no page to read it from': 130 }, tiers: { gold: 100, silver: 20 }, turns: { train: 117 } };
  const last = { turns: { train: 213 }, tiers: { gold: 100, silver: 20 } };

  it('halts on the shrink and the dominating filter when nobody confirmed', () => {
    const c = preflight(now, last, built, {});
    expect(c.halts.join(' ')).toMatch(/shrank/);
    expect(c.halts.join(' ')).toMatch(/alone removed/);
  });

  it('lifts exactly those two once the reason is named, and records it as a note', () => {
    const c = preflight(now, last, built, { accept: ['a decision with no page to read it from'] });
    expect(c.halts.filter((h) => /shrank|alone removed/.test(h))).toEqual([]);
    expect(c.notes.join(' ')).toMatch(/accepted/);
  });

  it('does not lift a halt the named reason does not explain', () => {
    const other = { ...now, droppedTurns: { 'a decision with no page to read it from': 10, 'something else': 120 } };
    const c = preflight(other, last, built, { accept: ['a decision with no page to read it from'] });
    expect(c.halts.join(' ')).toMatch(/shrank/);
  });
});

describe('a reason carried from the last manifest', () => {
  /* Confirmed once, confirmed until somebody changes the filter: the next build reads it off
     the manifest the confirming build wrote, and needs no flag. */
  const built = { train: Array.from({ length: 117 }, (_, i) => ({ jobId: `t${i}` })), eval: [{ jobId: 'e1' }] };
  const now = { droppedTurns: { 'a decision with no page to read it from': 130 }, tiers: { gold: 100, silver: 20 }, turns: { train: 117 } };
  const last = { turns: { train: 120 }, tiers: { gold: 100, silver: 20 }, accepted: [{ reason: 'a decision with no page to read it from', at: 'x' }] };

  it('lifts the share halt without a flag', () => {
    const c = preflight(now, last, built, {});
    expect(c.halts.filter((h) => /alone removed/.test(h))).toEqual([]);
    expect(c.notes.join(' ')).toMatch(/accepted/);
  });
});
