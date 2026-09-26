import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * The ledger stops a promoted turn being drawn twice. That is right for ONE student and wrong the
 * moment a second is tried: a fresh model has learned nothing, and denying it the corpus the
 * incumbent already ate would make the comparison meaningless.
 */
describe('learned by whom', () => {
  let dir, learned;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-learned-'));
    process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/learned')];
    learned = require('../src/learned');
  });
  afterEach(() => {
    delete process.env.PROFILE_DIR;
    delete require.cache[require.resolve('../src/learned')];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const line = (job, at) => JSON.stringify({ messages: [], meta: { jobId: job, at } });

  it('what the incumbent learned keeps the bare key, so nothing already written moves', () => {
    learned.record({ key: 'base', roundId: 'r-1', lines: [line('j1', 1), line('j1', 2)] });
    expect(learned.count('base')).toBe(2);
    /* Asked for by name, the incumbent sees the same shelf. */
    expect(learned.count('base', learned.INCUMBENT)).toBe(2);
    expect(learned.shelf('base', learned.INCUMBENT)).toBe('base');
  });

  it('a different student has learned none of it', () => {
    learned.record({ key: 'base', roundId: 'r-1', lines: [line('j1', 1), line('j1', 2)] });
    expect(learned.count('base', 'Qwen/Qwen3-1.7B')).toBe(0);
    expect(learned.setFor('base', 'Qwen/Qwen3-1.7B').size).toBe(0);
    expect(learned.has('base', line('j1', 1))).toBe(true);
    expect(learned.has('base', line('j1', 1), 'Qwen/Qwen3-1.7B')).toBe(false);
  });

  it('and keeps its own count as it learns', () => {
    learned.record({ key: 'base', roundId: 'r-1', lines: [line('j1', 1)] });
    learned.record({ key: 'base', roundId: 'r-2', lines: [line('j1', 1), line('j2', 9)], student: 'Qwen/Qwen3-1.7B' });
    expect(learned.count('base')).toBe(1);
    expect(learned.count('base', 'Qwen/Qwen3-1.7B')).toBe(2);
  });

  it('resetting one student leaves the other alone', () => {
    learned.record({ key: 'base', roundId: 'r-1', lines: [line('j1', 1)] });
    learned.record({ key: 'base', roundId: 'r-2', lines: [line('j2', 2)], student: 'Qwen/Qwen3-1.7B' });
    learned.reset('base', 'Qwen/Qwen3-1.7B');
    expect(learned.count('base', 'Qwen/Qwen3-1.7B')).toBe(0);
    expect(learned.count('base')).toBe(1);
  });
});
