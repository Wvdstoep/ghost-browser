/*
 * THE READINESS ENGINE, AND THE CONFIDENT WRONG ANSWERS IT MUST NOT GIVE.
 *
 * A screen that says "ready" over blind data trains a model that collapses; one that says "not
 * ready" over a good set because `hover` has no examples never trains anything. Each test is one
 * of those two mistakes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readiness from '../src/readiness.js';
import coverage from '../src/coverage.js';

const { scoreOf } = readiness;

const cov = (over = {}) => ({
  total: 5000, sighted: 1000,
  perTool: { look: { all: 1500, sighted: 200, gold: 150 }, read: { all: 1200, sighted: 200, gold: 150 }, open: { all: 1000, sighted: 200, gold: 150 }, finish: { all: 300, sighted: 200, gold: 150 }, dig: { all: 200, sighted: 200, gold: 100 } },
  sightedTiers: { gold: 700, silver: 250, bronze: 50, void: 0 },
  ...over,
});

describe('the six checks', () => {
  it('is ready when every gate passes, and says so', () => {
    const r = scoreOf({ coverage: cov(), exam: { overlap: 0 }, sliceTurns: 440 });
    expect(r.ok).toBe(true);
    expect(r.why).toMatch(/ready/);
    expect(r.checks.map((c) => c.name)).toEqual(['sight', 'coverage', 'balance', 'labels', 'freshness', 'exam']);
  });

  it('refuses a set that cannot see its pages, in the planner\'s own words', () => {
    const r = scoreOf({ coverage: cov({ sighted: 98 }), exam: { overlap: 0 }, sliceTurns: 440 });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/only 98 turn/);
    expect(r.checks[0].score).toBe(22);
  });

  it('does NOT stop the first round over a tool with no examples, but names it for the collector', () => {
    const r = scoreOf({ coverage: cov(), exam: { overlap: 0 }, catalogue: ['look', 'read', 'open', 'finish', 'dig', 'hover', 'type'] });
    expect(r.ok).toBe(true);
    expect(r.aim).toEqual(['hover', 'type']);
    expect(r.checks.find((c) => c.name === 'coverage').ok).toBe(false);
  });

  it('DOES stop a round over coverage once something is serving', () => {
    const r = scoreOf({ coverage: cov(), exam: { overlap: 0 }, catalogue: ['look', 'hover'], serving: { adapter: 'x' }, corpus: { usableSinceLastRound: 500 } });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/fewer than 4 sighted/);
  });

  it('refuses a set that is mostly the model\'s own word', () => {
    const r = scoreOf({ coverage: cov({ sightedTiers: { gold: 200, silver: 800, bronze: 0 } }), exam: { overlap: 0 } });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/only 20% of the sighted turns are gold/);
  });

  it('refuses an exam that overlaps the train set', () => {
    const r = scoreOf({ coverage: cov(), exam: { overlap: 3 } });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/3 exam job/);
  });

  it('wants new runs only once something is serving', () => {
    expect(scoreOf({ coverage: cov(), exam: { overlap: 0 }, corpus: { usableSinceLastRound: 0 } }).ok).toBe(true);
    const r = scoreOf({ coverage: cov(), exam: { overlap: 0 }, corpus: { usableSinceLastRound: 12 }, serving: { adapter: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/only 12 new usable/);
  });

  it('scores the weakest check, never an average', () => {
    /* Half the slice sighted scores sight at 50; but with only 220 sighted turns the loudest tool
       owns 91% of them, so balance is weaker still - and the weakest one is the score. */
    const r = scoreOf({ coverage: cov({ sighted: 220 }), exam: { overlap: 0 }, sliceTurns: 440 });
    expect(r.checks.find((c) => c.name === 'sight').score).toBe(50);
    expect(r.score).toBe(Math.min(...r.checks.map((c) => c.score)));
    expect(r.score).toBeLessThan(50);
  });

  it('survives an empty set', () => {
    const r = scoreOf({});
    expect(r.ok).toBe(false);
    expect(r.score).toBe(0);
  });
});

describe('reading coverage off the set', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-cov-')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });

  const line = (tool, { sighted = false, tier = 'gold', job = 'j1' } = {}) => JSON.stringify({
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: JSON.stringify({ tool, args: {} }) }],
    meta: { jobId: job, tier, grade: tier, verified: [], role: 'general', at: 'x', sighted },
  });

  it('counts per tool, sighted and blind, and the tiers of the sighted ones', () => {
    const p = path.join(dir, 'train.jsonl');
    fs.writeFileSync(p, [line('look', { sighted: true }), line('look'), line('open', { sighted: true, tier: 'silver', job: 'j2' }), ''].join('\n'));
    const c = coverage.scan(p);
    expect(c.total).toBe(3);
    expect(c.sighted).toBe(2);
    expect(c.perTool.look).toEqual({ all: 2, sighted: 1, gold: 1 });
    expect(c.perTool.open).toEqual({ all: 1, sighted: 1, gold: 0 });
    expect(c.sightedTiers.gold).toBe(1);
    expect(c.sightedTiers.silver).toBe(1);
    expect([...c.jobIds].sort()).toEqual(['j1', 'j2']);
  });

  it('finds an exam job that leaked into the train set', () => {
    const t = path.join(dir, 'train.jsonl'); const e = path.join(dir, 'eval.jsonl');
    fs.writeFileSync(t, [line('look', { job: 'a' }), line('open', { job: 'b' })].join('\n'));
    fs.writeFileSync(e, [line('look', { job: 'b' }), line('open', { job: 'c' })].join('\n'));
    expect(coverage.overlap(coverage.scan(t), coverage.scan(e))).toBe(1);
  });

  it('caches by the file, and re-reads when the file changes', () => {
    const p = path.join(dir, 'train.jsonl');
    fs.writeFileSync(p, line('look'));
    expect(coverage.cached(p).total).toBe(1);
    fs.writeFileSync(p, [line('look'), line('read'), line('open')].join('\n'));
    const s = fs.statSync(p); fs.utimesSync(p, s.atime, new Date(s.mtimeMs + 5000));
    expect(coverage.cached(p).total).toBe(3);
    expect(coverage.summary(coverage.cached(p)).perTool.length).toBe(3);
  });
});
