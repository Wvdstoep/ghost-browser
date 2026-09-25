import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const weakness = require('../src/weakness');

describe('the round trains what the model gets wrong', () => {
  const result = { agreement_pct: 34.55, per_tool: {
    read: { seen: 75, right: 46, pct: 61.3 },
    open: { seen: 75, right: 7, pct: 9.3 },
    finish: { seen: 22, right: 0, pct: 0 },
    dig: { seen: 42, right: 33, pct: 78.6 },
    rare: { seen: 2, right: 0, pct: 0 },
  } };

  it('weighs a failing tool up and a good one down, and says nothing about a tool it barely saw', () => {
    const w = weakness.fromExam(result);
    expect(w.finish).toBeCloseTo(3, 5);
    expect(w.open).toBeGreaterThan(2.7);
    expect(w.dig).toBeLessThan(1.5);
    expect(w.read).toBeGreaterThan(1);
    expect(w.rare).toBeUndefined();
    expect(weakness.fromExam(null)).toEqual({});
  });

  it('the shadow says the same about live jobs, and the worse of the two wins', () => {
    const shadow = { 'gb-base-1': { perTool: { read: { seen: 40, agree: 4 }, dig: { seen: 20, agree: 19 } } } };
    const live = weakness.fromShadow(shadow, 'gb-base-1');
    expect(live.read).toBeGreaterThan(2.7);
    const rounds = [{ id: 'r1', scope: { key: 'base' }, promoted: true, result }];
    const both = weakness.forScope({ rounds, shadow, model: 'gb-base-1', key: 'base' });
    expect(both.read).toBeGreaterThan(2.7);      // the shadow's worse verdict wins
    expect(both.finish).toBeCloseTo(3, 5);        // the exam's, where the shadow is silent
    expect(both.dig).toBeLessThan(1.5);
  });

  it('a scope with no promoted round and no shadow weighs everything the same', () => {
    expect(weakness.forScope({ rounds: [], shadow: {}, key: 'platform:google' })).toEqual({});
  });

  it('a failing tool is handed over again when the round can hold more than the set has', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-weight-'));
    const prev = process.env.PROFILE_DIR; process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/slice')];
    delete require.cache[require.resolve('../src/learned')];
    const slice = require('../src/slice');
    try {
      const file = path.join(dir, 'train.jsonl');
      const rows = [];
      const line = (tool, n) => JSON.stringify({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' + n }, { role: 'assistant', content: JSON.stringify({ tool, args: {} }) }], meta: { jobId: `j-${n}`, at: n % 5, tier: 'gold', role: 'general', platform: 'web', sighted: true } });
      let n = 0;
      for (let i = 0; i < 120; i++) rows.push(line('read', n++));
      for (let i = 0; i < 40; i++) rows.push(line('open', n++));
      fs.writeFileSync(file, rows.join('\n'));
      /* A round that can hold far more than the set has: everything is taken either way. */
      const plain = slice.draw({ file, builtAt: 'b1', want: 400, roundId: 'r-plain', scope: 'base' });
      expect(plain.count).toBe(160);
      expect(plain.tools.open).toBe(40);
      expect(plain.repeated).toBe(0);
      slice.release({ scope: 'base', marks: ['r-plain'] });
      const skewed = slice.draw({ file, builtAt: 'b1', want: 400, roundId: 'r-skew', scope: 'base', weights: { open: 3, read: 1 } });
      expect(skewed.fresh).toBe(160);
      expect(skewed.repeated).toBe(80);          // `open` twice more, `read` not at all
      expect(skewed.tools.open).toBe(120);
      expect(skewed.tools.read).toBe(120);
      expect(skewed.count).toBe(240);
      /* The lines are the same turns, so nothing unlearned was spent twice. */
      const ids = new Set(skewed.jsonl.split('\n').map((l) => JSON.parse(l).meta.jobId));
      expect(ids.size).toBe(160);
    } finally {
      if (prev === undefined) delete process.env.PROFILE_DIR; else process.env.PROFILE_DIR = prev;
      delete require.cache[require.resolve('../src/slice')];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
