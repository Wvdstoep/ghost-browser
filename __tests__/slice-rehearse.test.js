import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * Tonight's round lifted the three tools it was aimed at and lost `dig` from 82.5% to 2.5%. The
 * weighting was not wrong, it was unopposed. These hold the floor that opposes it.
 */
describe('a tool the model is good at is still rehearsed', () => {
  let dir, file, slice;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-rehearse-'));
    process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/slice')];
    slice = require('../src/slice');
    file = path.join(dir, 'train.jsonl');
    const line = (tool, n) => JSON.stringify({
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: `u${n}` }, { role: 'assistant', content: JSON.stringify({ tool, args: {} }) }],
      meta: { jobId: `j-${tool}-${Math.floor(n / 4)}`, at: n, tier: 'gold', role: 'general', platform: 'web', sighted: true },
    });
    const rows = [];
    let n = 0;
    /* The shape that broke: two very common tools the model is weak at, one middling tool it is good at. */
    for (let i = 0; i < 600; i++) rows.push(line('look', n++));
    for (let i = 0; i < 600; i++) rows.push(line('open', n++));
    for (let i = 0; i < 200; i++) rows.push(line('dig', n++));
    fs.writeFileSync(file, rows.join('\n'));
  });
  afterEach(() => { delete process.env.PROFILE_DIR; delete require.cache[require.resolve('../src/slice')]; fs.rmSync(dir, { recursive: true, force: true }); });

  const share = (out, tool) => (out.tools[tool] || 0) / out.count;

  it('keeps most of its natural share even when its neighbours are weighted three times up', () => {
    const weights = { look: 3, open: 3, dig: 1 };
    const out = slice.draw({ file, builtAt: 'b1', want: 400, roundId: 'r-1', weights });
    const natural = 200 / 1400;
    /* Without the floor the skewed share would be about 200 / (1800 + 1800 + 200) = 5.3%. */
    expect(share(out, 'dig')).toBeGreaterThan(natural * slice.REHEARSE * 0.9);
    expect(share(out, 'dig')).toBeGreaterThan(0.07);
  });

  it('and the weighting still does its job — the weak tools take the larger part', () => {
    const weights = { look: 3, open: 3, dig: 1 };
    const out = slice.draw({ file, builtAt: 'b2', want: 400, roundId: 'r-2', weights });
    /* Not their natural 86%: no tool may exceed CAP_SHARE of a draw, which is the older rule. */
    expect(share(out, 'look') + share(out, 'open')).toBeGreaterThan(0.6);
    expect(share(out, 'dig')).toBeLessThan(share(out, 'look') + share(out, 'open'));
  });

  it('the floor raises it without undoing the skew', () => {
    const weights = { look: 3, open: 3, dig: 1 };
    const weighted = slice.draw({ file, builtAt: 'b3', want: 400, roundId: 'r-3', weights });
    const flat = slice.draw({ file, builtAt: 'b4', want: 400, roundId: 'r-4' });
    /* Weighting its neighbours up still moves turns away from it - the floor only limits how far. */
    expect(share(weighted, 'dig')).toBeLessThan(share(flat, 'dig'));
    expect(share(weighted, 'dig')).toBeGreaterThan(share(flat, 'dig') * 0.2);
  });
});
