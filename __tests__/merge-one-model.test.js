import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * Averaging two adapters adds their matrices, which means something only when both were fitted to
 * the same network. Two students training side by side on two cards are not shares of one batch
 * and must never be treated as any: across models it is a shape error at load, after the hours
 * are spent and with both shares consumed.
 */
describe('a batch merges one model only', () => {
  let dir, training;
  const write = (rows) => {
    fs.mkdirSync(path.join(dir, 'training'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'training', 'rounds.json'), JSON.stringify(rows));
  };
  const share = (id, batch, model, extra = {}) => ({
    id, batch, share: 2, merge: false, status: 'done', discarded: false,
    device: id, scope: { level: 'base', name: '', key: 'base' },
    recipe: { base: model }, adapterHub: `hub:${id}`,
    result: { agreement_pct: 30, collapse: { ratio: 1.2, tool: 'read' } },
    baseline: { agreement_pct: 20 },
    ...extra,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-merge-'));
    process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/training')];
    training = require('../src/training');
  });
  afterEach(() => {
    delete process.env.PROFILE_DIR;
    delete require.cache[require.resolve('../src/training')];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('two shares of one model are ready to merge', () => {
    write([
      share('r-1', 'b-1', 'Qwen/Qwen2.5-0.5B-Instruct'),
      share('r-2', 'b-1', 'Qwen/Qwen2.5-0.5B-Instruct'),
    ]);
    const out = training.batchReadyToMerge('r-1');
    expect(out).toBeTruthy();
    expect(out.abandoned).toBeFalsy();
  });

  it('two models in one batch are abandoned, with the reason', () => {
    write([
      share('r-1', 'b-1', 'Qwen/Qwen2.5-0.5B-Instruct'),
      share('r-2', 'b-1', 'Qwen/Qwen3-0.6B'),
    ]);
    const out = training.batchReadyToMerge('r-1');
    expect(out.abandoned).toBe(true);
    expect(out.why).toMatch(/cannot be averaged/);
    expect(out.why).toContain('Qwen/Qwen3-0.6B');
  });

  it('two rounds with no batch at all are simply two rounds', () => {
    write([
      { ...share('r-1', '', 'Qwen/Qwen2.5-0.5B-Instruct'), share: 1 },
      { ...share('r-2', '', 'Qwen/Qwen3-0.6B'), share: 1 },
    ]);
    /* No batch id: nothing to merge, and nothing claimed. */
    expect(training.batchReadyToMerge('r-1')).toBe(null);
    expect(training.batchReadyToMerge('r-2')).toBe(null);
  });
});
