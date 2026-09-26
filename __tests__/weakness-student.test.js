import { describe, it, expect } from 'vitest';
const weakness = require('../src/weakness');

/*
 * The draw gives a bigger share to the tools the model gets wrong. With one student those were
 * always its own. With two, reading them off the scope's promoted round would send a challenger
 * to drill whatever the INCUMBENT is bad at - training it for someone else's failures and calling
 * the result a comparison.
 */
describe('a student is weighted by its own exam', () => {
  const round = (id, model, perTool, extra = {}) => ({
    id, status: 'done', scope: { level: 'base', name: '', key: 'base' },
    recipe: { base: model },
    result: { agreement_pct: 30, per_tool: perTool },
    ...extra,
  });

  /* The incumbent is hopeless at `open` and excellent at `dig`; the challenger is the reverse. */
  const incumbent = round('r-inc', 'Qwen/Qwen2.5-0.5B-Instruct', {
    open: { seen: 75, right: 7, pct: 9.3 },
    dig: { seen: 40, right: 34, pct: 85.0 },
  }, { promoted: true });
  const challenger = round('r-new', 'Qwen/Qwen3-0.6B', {
    open: { seen: 75, right: 68, pct: 90.7 },
    dig: { seen: 40, right: 2, pct: 5.0 },
  });

  it('reads the incumbent s own exam for the incumbent', () => {
    const w = weakness.forScope({ rounds: [challenger, incumbent], key: 'base', student: 'Qwen/Qwen2.5-0.5B-Instruct' });
    expect(w.open).toBeGreaterThan(w.dig);
  });

  it('and the challenger s own exam for the challenger, not the incumbent s', () => {
    const w = weakness.forScope({ rounds: [challenger, incumbent], key: 'base', student: 'Qwen/Qwen3-0.6B' });
    /* Its own weakness is `dig`; reading the incumbent's would have said `open`. */
    expect(w.dig).toBeGreaterThan(w.open);
  });

  it('a refused round still measured something true about the model that ran it', () => {
    const refused = round('r-ref', 'Qwen/Qwen3-0.6B', { dig: { seen: 40, right: 2, pct: 5.0 } }, { discarded: true });
    const w = weakness.forScope({ rounds: [refused, incumbent], key: 'base', student: 'Qwen/Qwen3-0.6B' });
    expect(w.dig).toBeGreaterThan(1);
  });

  it('a student nobody has measured borrows the scope s promoted round, which is the best guess there is', () => {
    const w = weakness.forScope({ rounds: [incumbent], key: 'base', student: 'google/gemma-4-E2B-it' });
    expect(w.open).toBeGreaterThan(w.dig);
  });

  it('and with no student named nothing changes for the rounds already run', () => {
    const w = weakness.forScope({ rounds: [challenger, incumbent], key: 'base' });
    expect(w.open).toBeGreaterThan(w.dig);
  });
});
