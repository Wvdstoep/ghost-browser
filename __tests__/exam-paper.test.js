import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * A paper that takes forty turns from one wandering job measures that job. The training draw has
 * always capped what one run may give; the exam now does the same.
 */
describe('the paper is a sample, not a few long jobs', () => {
  let dir, file, slice;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-paper-'));
    process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/slice')];
    slice = require('../src/slice');
    file = path.join(dir, 'eval.jsonl');
    const line = (tool, job, n) => JSON.stringify({
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: `u${n}` }, { role: 'assistant', content: JSON.stringify({ tool, args: {} }) }],
      meta: { jobId: job, at: n, tier: 'gold', role: 'general', platform: 'web', sighted: true },
    });
    const rows = [];
    let n = 0;
    /* One enormous job, and forty short ones. */
    for (let i = 0; i < 120; i++) rows.push(line('open', 'j-wanderer', n++));
    for (let j = 0; j < 40; j++) rows.push(line('open', `j-short-${j}`, n++));
    for (let i = 0; i < 60; i++) rows.push(line('read', `j-read-${i}`, n++));
    fs.writeFileSync(file, rows.join('\n'));
  });
  afterEach(() => { delete process.env.PROFILE_DIR; delete require.cache[require.resolve('../src/slice')]; fs.rmSync(dir, { recursive: true, force: true }); });

  const jobsOf = (out) => out.jsonl.split('\n').filter(Boolean).map((l) => JSON.parse(l).meta.jobId);

  it('caps what one run may give, and fills from the others instead', () => {
    const out = slice.exam({ file, want: 100, perRun: 12 });
    const jobs = jobsOf(out);
    const wanderer = jobs.filter((j) => j === 'j-wanderer').length;
    expect(wanderer).toBeLessThanOrEqual(12);
    expect(new Set(jobs).size).toBeGreaterThan(10);
    /* Two tools and a fifteen-per-tool cap make a thirty-turn paper here; the point is WHOSE turns. */
    expect(out.count).toBe(30);
    expect(jobs.filter((j) => j.startsWith('j-short')).length).toBeGreaterThan(0);
  });

  it('without the cap one job would own the paper', () => {
    const out = slice.exam({ file, want: 100, perRun: 0 });
    const wanderer = jobsOf(out).filter((j) => j === 'j-wanderer').length;
    expect(wanderer).toBeGreaterThan(12);
  });

  it('is still the same paper twice', () => {
    const a = slice.exam({ file, want: 100, perRun: 12 });
    const b = slice.exam({ file, want: 100, perRun: 12 });
    expect(a.jsonl).toBe(b.jsonl);
  });
});
