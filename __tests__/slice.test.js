/*
 * HANDING OUT THE WORK, AND THE WAYS TWO MACHINES END UP DOING ONE MACHINE'S WORK.
 *
 * Every test here is a failure with no symptom. Both rounds report turns trained, both losses fall,
 * and the corpus is covered far more slowly than the arithmetic says:
 *
 *   - two devices draw overlapping slices, so the second laptop adds almost nothing;
 *   - a rebuilt set keeps the old marks, so line numbers now point at different rows and turns are
 *     skipped while being counted as covered;
 *   - one loud tool takes the whole slice, and the model never learns to stop working;
 *   - the set runs out and the loop starts over on turns the model has already seen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { draw, progress, reset, toolOf } from '../src/slice.js';

let dir, file;

/* A set shaped like the real one: `open` and `read` dominate, `finish` is rare. */
const line = (tool, tier, n) => JSON.stringify({
  messages: [
    { role: 'system', content: 'You are Ghost Browser working as general.' },
    { role: 'user', content: `GOAL: thing ${n}` },
    { role: 'assistant', content: JSON.stringify({ tool, args: {} }) },
  ],
  meta: { jobId: `j-${n}`, tier, role: 'general' },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-slice-'));
  process.env.PROFILE_DIR = dir;
  file = path.join(dir, 'train.jsonl');
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push(line('open', i < 100 ? 'gold' : 'silver', i));
  for (let i = 0; i < 150; i++) rows.push(line('read', 'gold', 1000 + i));
  for (let i = 0; i < 20; i++) rows.push(line('click', 'gold', 2000 + i));
  for (let i = 0; i < 4; i++) rows.push(line('finish', 'gold', 3000 + i));
  fs.writeFileSync(file, rows.join('\n'));
});
afterEach(() => {
  delete process.env.PROFILE_DIR;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
});

describe('drawing a slice', () => {
  it('reads the tool off the raw line without parsing the whole set', () => {
    expect(toolOf(line('finish', 'gold', 1))).toBe('finish');
    expect(toolOf('not json')).toBe(null);
  });

  it('GIVES TWO ROUNDS DISJOINT WORK', () => {
    /* The failure with no symptom: two laptops sampling independently overlap, so the second one
       adds almost nothing while both report a full round. */
    const a = draw({ file, builtAt: 't1', want: 50, roundId: 'r-a' });
    const b = draw({ file, builtAt: 't1', want: 50, roundId: 'r-b' });
    expect(a.count).toBe(50);
    expect(b.count).toBe(50);
    const setA = new Set(a.jsonl.split('\n'));
    const overlap = b.jsonl.split('\n').filter((l) => setA.has(l));
    expect(overlap).toEqual([]);
  });

  it('does not let the loud tools take the whole slice', () => {
    /* `open` is 200 of 374 rows here, as in the real set. A slice that mirrors the raw distribution
       teaches a model that is excellent at opening pages and has seen `finish` almost never. */
    const s = draw({ file, builtAt: 't1', want: 40 });
    expect(s.tools.finish).toBe(4);
    expect(s.tools.click).toBeGreaterThan(5);
    /* No single tool may dominate a round-robin draw. */
    expect(s.tools.open).toBeLessThan(20);
  });

  it('prefers gold within a tool', () => {
    /* Gold means something outside the run's own report confirmed it. A budget should be spent on
       the best evidence available, not on whatever sat at the top of the file. */
    const s = draw({ file, builtAt: 't1', want: 30 });
    const golds = s.jsonl.split('\n').filter((l) => l.includes('"tier":"gold"')).length;
    expect(golds).toBe(30);
  });

  it('tracks what is left, so coverage is counted rather than estimated', () => {
    draw({ file, builtAt: 't1', want: 100 });
    const p = progress('t1', 374);
    expect(p.handed).toBe(100);
    expect(draw({ file, builtAt: 't1', want: 100 }).remaining).toBe(174);
  });

  it('runs out rather than starting over on turns already seen', () => {
    let guard = 0;
    while (draw({ file, builtAt: 't1', want: 100 }).count > 0 && guard < 20) guard++;
    const s = draw({ file, builtAt: 't1', want: 100 });
    expect(s.count).toBe(0);
    expect(s.exhausted).toBe(true);
  });
});

describe('the shape of the slice — what cost round one', () => {
  it('KEEPS THE REAL DISTRIBUTION instead of flattening it', () => {
    /*
     * The first draw round-robinned: every tool got its first example before any got its second.
     * Across 66 tools and 685 turns that is ten each, so the model was taught that all 66 tools are
     * equally likely — and it collapsed onto `diagnostics`, scoring 0/15 on `read`, 0/11 on `look`,
     * 0/9 on `click` and 0/7 on `type` while overall agreement rose from 5% to 20% and looked like
     * a win. The prior is the most reliable signal in the set; flattening it throws that away.
     *
     * Here `open` is 200 of 374 rows and `finish` is 4. A correct slice has far more `open` than
     * `finish` — and still has some `finish`.
     */
    const s = draw({ file, builtAt: 't1', want: 120 });
    expect(s.tools.open).toBeGreaterThan(s.tools.click);
    expect(s.tools.read).toBeGreaterThan(s.tools.click);
    /* But not so much more that the rare ones vanish. */
    expect(s.tools.finish).toBeGreaterThanOrEqual(4);
    expect(s.tools.click).toBeGreaterThanOrEqual(4);
  });

  it('caps a dominant tool while alternatives still have stock', () => {
    /* `open` is 53% of the rows. Left alone it would be most of the round, which is the other
       failure: excellent at opening pages, never learns to stop working. */
    const s = draw({ file, builtAt: 't1', want: 200 });
    expect(s.tools.open / s.count).toBeLessThan(0.45);
    expect(s.tools.open).toBeGreaterThan(s.tools.finish);
  });

  it('gives every tool present at least a floor, even the rarest', () => {
    const s = draw({ file, builtAt: 't1', want: 60 });
    for (const [tool, n] of Object.entries(s.tools)) {
      expect(n, `${tool} got ${n}`).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('when the set is rebuilt', () => {
  it('FORGETS THE OLD MARKS, because line numbers no longer mean the same rows', () => {
    /* Carrying the ledger across a rebuild silently skips turns that were never trained on, while
       counting them as covered. The set is rebuilt daily, so this would happen every day. */
    draw({ file, builtAt: 't1', want: 300 });
    expect(progress('t1', 374).handed).toBe(300);

    const after = draw({ file, builtAt: 't2-rebuilt', want: 50 });
    expect(after.count).toBe(50);
    expect(progress('t2-rebuilt', 374).handed).toBe(50);
  });

  it('can be started again on purpose', () => {
    draw({ file, builtAt: 't1', want: 300 });
    reset('t1');
    expect(progress('t1', 374).handed).toBe(0);
    expect(draw({ file, builtAt: 't1', want: 10 }).count).toBe(10);
  });
});
