import { describe, it, expect } from 'vitest';
const readiness = require('../src/readiness');

/*
 * Once a model serves, a catalogue full of tools with almost no examples is a reason to go and
 * collect rather than to train again - but only when the set has nothing else to teach. Thirty-three
 * rare tools once held back a round that had 1,680 unlearned turns in front of it.
 */
describe('thin tools stop a round only when there is nothing else to teach', () => {
  const base = {
    coverage: {
      sighted: 4110,
      perTool: { read: { sighted: 900 }, open: { sighted: 700 }, look: { sighted: 800 }, dig: { sighted: 600 }, click: { sighted: 500 }, scroll: { sighted: 400 }, finish: { sighted: 120 }, note: { sighted: 90 } },
      tiers: { gold: 3000, silver: 800, bronze: 200 },
    },
    exam: { overlap: 0 },
    catalogue: ['read', 'open', 'look', 'dig', 'click', 'scroll', 'finish', 'note', 'save_totp_secret', 'totp_code', 'sweep'],
    sliceTurns: 100,
    corpus: { usableSinceLastRound: 0, scanning: false },
    serving: { adapter: 'hub:r-1' },
  };
  const coverage = (r) => r.checks.find((c) => c.name === 'coverage');

  it('is a warning while turns are still unlearned', () => {
    const c = coverage(readiness.scoreOf({ ...base, workLeft: 1680 }));
    expect(c.ok).toBe(false);
    expect(c.gate).toBe(false);
    expect(String(c.text)).toContain('1680 turn(s) are still unlearned');
  });

  it('and a stop once every turn has been learned', () => {
    const c = coverage(readiness.scoreOf({ ...base, workLeft: 0 }));
    expect(c.ok).toBe(false);
    expect(c.gate).toBe(true);
    expect(String(c.text)).not.toContain('still unlearned');
  });

  it('and nothing at all before anything serves', () => {
    const c = coverage(readiness.scoreOf({ ...base, serving: null, workLeft: 0 }));
    expect(c.gate).toBe(false);
  });

  it('a full catalogue passes whatever is left to learn', () => {
    const full = { ...base, catalogue: ['read', 'open', 'look', 'dig', 'click', 'scroll', 'finish', 'note'] };
    expect(coverage(readiness.scoreOf({ ...full, workLeft: 0 })).ok).toBe(true);
    expect(coverage(readiness.scoreOf({ ...full, workLeft: 1680 })).ok).toBe(true);
  });
});
