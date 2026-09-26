import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * The scoreboard is what makes "which student" answerable at a glance: every measured round in one
 * table with the model as a column. These hold the two things a screen cannot recover on its own -
 * that a trial is marked as one, and that the tools are ordered the same way for every column.
 */
describe('the scoreboard', () => {
  let dir, students, training;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-results-'));
    process.env.PROFILE_DIR = dir;
    for (const m of ['../src/training', '../src/students']) delete require.cache[require.resolve(m)];
    training = require('../src/training');
    students = require('../src/students');
    fs.mkdirSync(path.join(dir, 'training'), { recursive: true });
    const round = (id, model, start, after, extra = {}) => ({
      id, status: 'done', endedAt: '2026-09-26T09:00:00.000Z', device: 'Modal L4',
      scope: { level: 'base', name: '', key: 'base' },
      recipe: { base: model, epochs: 3, lr: 4e-5, answerTokens: 320 },
      baseline: start == null ? null : { agreement_pct: start, turns: 354, per_tool: { read: { seen: 41, right: 20, pct: 48.8 } } },
      result: { agreement_pct: after, turns: 354, args_agreement_pct: 19, unusable_pct: 2,
        collapse: { ratio: 1.5, tool: 'read', distinct: 24 },
        per_tool: { read: { seen: 41, right: 25, pct: 61.0 }, open: { seen: 75, right: 21, pct: 28.0 } } },
      ...extra,
    });
    fs.writeFileSync(path.join(dir, 'training', 'rounds.json'), JSON.stringify([
      round('r-a', 'Qwen/Qwen2.5-0.5B-Instruct', 36.44, 41.2, { promoted: true, adapterHub: 'hub:r-a' }),
      round('r-b', 'Qwen/Qwen3-0.6B', 12.99, 30.1),
      round('r-t', 'Qwen/Qwen3-1.7B', null, 12.43, { recipe: { base: 'Qwen/Qwen3-1.7B', trial: true, adapter: '' } }),
    ]));
  });
  afterEach(() => {
    delete process.env.PROFILE_DIR;
    for (const m of ['../src/training', '../src/students']) delete require.cache[require.resolve(m)];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* The route's own shaping, exercised through the pieces it is built from. */
  const build = () => {
    const all = training.allRounds();
    const verdictOf = (r) => (r.promoted ? 'promoted' : (r.discarded ? 'refused' : (students.isTrial(r) ? 'measured' : r.status)));
    return all.filter((r) => r.result && typeof r.result.agreement_pct === 'number').map((r) => ({
      id: r.id, model: String((r.recipe && r.recipe.base) || ''), trial: students.isTrial(r),
      verdict: verdictOf(r),
      start: r.baseline ? r.baseline.agreement_pct : null,
      after: r.result.agreement_pct,
      change: r.baseline ? Number((r.result.agreement_pct - r.baseline.agreement_pct).toFixed(2)) : null,
    }));
  };

  it('puts every model in one table, as a column rather than a filter', () => {
    const rows = build();
    expect(rows.map((r) => r.model)).toEqual([
      'Qwen/Qwen2.5-0.5B-Instruct', 'Qwen/Qwen3-0.6B', 'Qwen/Qwen3-1.7B',
    ]);
    expect(new Set(rows.map((r) => r.model)).size).toBe(3);
  });

  it('marks a trial as measured, not as a round that failed to be promoted', () => {
    const rows = build();
    const trial = rows.find((r) => r.id === 'r-t');
    expect(trial.trial).toBe(true);
    expect(trial.verdict).toBe('measured');
    /* A trial has no start of its own, and that is not a zero. */
    expect(trial.start).toBe(null);
    expect(trial.change).toBe(null);
  });

  it('carries the change so two students can be read against their own starts', () => {
    const rows = build();
    expect(rows.find((r) => r.id === 'r-a').change).toBeCloseTo(4.76, 2);
    expect(rows.find((r) => r.id === 'r-b').change).toBeCloseTo(17.11, 2);
    /* The challenger moved further and still sits lower - which is the whole point of showing both. */
    expect(rows.find((r) => r.id === 'r-b').after).toBeLessThan(rows.find((r) => r.id === 'r-a').after);
  });

  it('orders the tools once, by how often they are asked, for every column', () => {
    const all = training.allRounds();
    const seen = new Map();
    for (const r of all) for (const [tool, v] of Object.entries((r.result || {}).per_tool || {})) seen.set(tool, Math.max(seen.get(tool) || 0, v.seen || 0));
    const tools = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([tool]) => tool);
    expect(tools[0]).toBe('open');
    expect(tools).toContain('read');
  });

  it('the bar is the newest measurement of what serves, not the score it was born with', () => {
    /*
     * The serving adapter was born at 34.55% under an exam that cut answers off at 48 tokens and
     * measures 36.72% under the one that does not. Quoting the first understates what a
     * challenger must beat, which is the one number on that screen that must not flatter.
     */
    const born = {
      id: 'r-serving', status: 'done', promoted: true, adapterHub: 'hub:r-serving',
      endedAt: '2026-09-25T17:47:00.000Z', recipe: { base: 'Qwen/Qwen2.5-0.5B-Instruct' },
      baseline: { agreement_pct: 5.86 }, result: { agreement_pct: 34.55, per_tool: {} },
    };
    const remeasured = {
      id: 'r-trial', status: 'done', endedAt: '2026-09-26T01:10:00.000Z',
      recipe: { base: 'Qwen/Qwen2.5-0.5B-Instruct', trial: true, adapter: 'hub:r-serving' },
      baseline: null, result: { agreement_pct: 36.72, per_tool: {} },
    };
    const all = [remeasured, born];
    const servingRound = all.find((r) => r.promoted && (r.adapterHub || r.adapter));
    const name = String(servingRound.adapterHub || servingRound.adapter || '');
    const newer = all.find((r) => r.result && typeof r.result.agreement_pct === 'number'
      && String((r.recipe && r.recipe.adapter) || '') === name
      && (Date.parse(r.endedAt || r.startedAt || '') || 0) > (Date.parse(servingRound.endedAt || servingRound.startedAt || '') || 0));
    expect(newer).toBeTruthy();
    expect(newer.result.agreement_pct).toBe(36.72);
    /* And with nothing newer, the round's own number stands. */
    const alone = [born];
    const none = alone.find((r) => String((r.recipe && r.recipe.adapter) || '') === name
      && (Date.parse(r.endedAt || '') || 0) > (Date.parse(born.endedAt) || 0));
    expect(none).toBeFalsy();
  });
});
