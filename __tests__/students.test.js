import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * The student is chosen by measurement. These hold the two things that would quietly ruin that: a
 * trial being mistaken for a training round, and a candidate being scored against a number that
 * came off a different paper.
 */
describe('choosing the student', () => {
  let dir, students;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-students-'));
    process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/students')];
    students = require('../src/students');
  });
  afterEach(() => {
    delete process.env.PROFILE_DIR;
    delete require.cache[require.resolve('../src/students')];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const trial = (model, pct, extra = {}) => ({
    id: `r-${model.slice(-4)}`, status: 'done', endedAt: '2026-09-26T01:00:00.000Z',
    recipe: { base: model, trial: true },
    result: { agreement_pct: pct, turns: 354, args_agreement_pct: pct / 2, unusable_pct: 5, collapse: { ratio: 1.2, tool: 'read' } },
    ...extra,
  });

  it('the incumbent stands in the field as the control', () => {
    expect(students.CANDIDATES.map((c) => c.id)).toContain('Qwen/Qwen2.5-0.5B-Instruct');
    expect(students.CANDIDATES.length).toBeGreaterThanOrEqual(3);
  });

  it('the field is the family we already serve, and what waits says why', () => {
    const ids = students.CANDIDATES.map((c) => c.id);
    /* Every candidate serves through the ChatML template the export already writes. */
    expect(ids.every((i) => i.startsWith('Qwen/'))).toBe(true);
    expect(ids).toContain('Qwen/Qwen3-1.7B');
    /* A different family is not refused, it is postponed - with the reason written down. */
    expect(students.LATER.map((c) => c.id)).toContain('google/gemma-4-E4B-it');
    expect(students.LATER.find((c) => c.id === 'google/gemma-4-E4B-it').needs).toMatch(/template/);
    /* And postponed means not queueable by accident. */
    expect(() => students.queue(['google/gemma-4-E4B-it'])).toThrow(/not a candidate/);
  });

  it('a trial is not a training round', () => {
    expect(students.isTrial({ recipe: { trial: true, base: 'x' } })).toBe(true);
    expect(students.isTrial({ recipe: { base: 'x', lr: 2e-4 } })).toBe(false);
    expect(students.isTrial(null)).toBe(false);
  });

  it('queues candidates once each, and refuses one nobody has heard of', () => {
    students.queue(['Qwen/Qwen3-1.7B', 'Qwen/Qwen3-1.7B']);
    expect(students.next()).toBe('Qwen/Qwen3-1.7B');
    expect(students.list([]).queue).toEqual(['Qwen/Qwen3-1.7B']);
    expect(() => students.queue(['nobody/ghost-9000'])).toThrow(/not a candidate/);
    students.shift('Qwen/Qwen3-1.7B');
    expect(students.next()).toBe('');
  });

  it('reads each candidate score off its own trial round and names the leader', () => {
    const rounds = [trial('Qwen/Qwen3-1.7B', 21.4), trial('Qwen/Qwen2.5-0.5B-Instruct', 6.1)];
    const out = students.list(rounds);
    const inc = out.candidates.find((c) => c.id === 'Qwen/Qwen2.5-0.5B-Instruct');
    expect(inc.trial.agreement).toBe(6.1);
    expect(inc.trial.turns).toBe(354);
    expect(out.leader.id).toBe('Qwen/Qwen3-1.7B');
    /* One never tried has no number at all, rather than a zero that would sort like a loss. */
    expect(out.candidates.find((c) => c.id === 'Qwen/Qwen3-0.6B').trial).toBe(null);
  });

  it('a running trial is reported as running, not as a score', () => {
    const rounds = [{ id: 'r-run', status: 'running', recipe: { base: 'Qwen/Qwen3-0.6B', trial: true }, result: null }];
    const out = students.list(rounds);
    expect(out.running).toBe(true);
    expect(out.candidates.find((c) => c.id === 'Qwen/Qwen3-0.6B').trial.agreement).toBe(null);
    expect(out.leader).toBe(null);
  });

  it('a failed trial keeps its reason where it can be read', () => {
    const rounds = [{ id: 'r-bad', status: 'failed', recipe: { base: 'Qwen/Qwen3-0.6B', trial: true }, result: null, why: 'could not load Qwen/Qwen3-0.6B' }];
    const t = students.list(rounds).candidates.find((c) => c.id === 'Qwen/Qwen3-0.6B').trial;
    expect(t.status).toBe('failed');
    expect(t.why).toMatch(/could not load/);
  });

  it('clearing forgets the queue', () => {
    students.queue(['Qwen/Qwen3-0.6B']);
    expect(students.clear()).toEqual([]);
    expect(students.next()).toBe('');
  });
});
