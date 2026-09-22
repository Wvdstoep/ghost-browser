/*
 * STALE MEANS "IT HAS MISSED ITS OWN SCHEDULE".
 *
 * One threshold of 45 minutes was exactly right while every watcher ran every few minutes: it meant
 * two or three missed passes. The Search Console watcher reads once a day, because the numbers move
 * once a day and a pass is a model-driven walk through six tabs of a signed-in console. On the old
 * rule its card said STALE for twenty-three hours out of twenty-four, while working perfectly.
 *
 * That is the failure worth a test: a warning that is always on teaches the owner to ignore the field,
 * and the next watcher that really does go quiet then looks exactly like this one.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const wfs = require('../src/workflows');

const MIN = 60e3;
const sched = (every, extra = {}) => ({ nodes: [{ id: 'trigger', type: 'trigger', trigger: { type: 'schedule', every, ...extra } }] });

describe('how often a scheduled watcher is meant to fire', () => {
  it('reads the interval off its own trigger', () => {
    expect(wfs.intervalMs(sched('minute', { n: 15 }).nodes[0].trigger)).toBe(15 * MIN);
    expect(wfs.intervalMs(sched('hour', { n: 2 }).nodes[0].trigger)).toBe(2 * 60 * MIN);
    expect(wfs.intervalMs(sched('day', { at: '07:20' }).nodes[0].trigger)).toBe(24 * 60 * MIN);
  });

  /* `every: 'day'` carries a time of day, never an n — reading n there would make it a one-minute watcher. */
  it('ignores n on a daily trigger, where it means nothing', () => {
    expect(wfs.intervalMs({ type: 'schedule', every: 'day', at: '07:20', n: 1 })).toBe(24 * 60 * MIN);
  });

  it('says nothing about a trigger that is not a schedule', () => {
    expect(wfs.intervalMs({ type: 'manual' })).toBe(0);
    expect(wfs.intervalMs({ type: 'schedule', every: 'fortnight' })).toBe(0);
    expect(wfs.intervalMs(null)).toBe(0);
  });

  it('finds the trigger on the node, or on the record itself', () => {
    expect(wfs.triggerOf(sched('minute', { n: 5 })).every).toBe('minute');
    expect(wfs.triggerOf({ trigger: { type: 'schedule', every: 'hour', n: 1 } }).every).toBe('hour');
    expect(wfs.triggerOf({ nodes: [] })).toBe(null);
    expect(wfs.triggerOf(null)).toBe(null);
  });
});

describe('when silence becomes news', () => {
  /* THE BUG: 596 minutes after a daily pass, its card read STALE. It was not. */
  it('does not call a daily watcher stale the morning after it read', () => {
    const after = wfs.staleAfterMs(sched('day', { at: '07:20' }));
    expect(after).toBe(36 * 60 * MIN);
    expect(596 * MIN).toBeLessThan(after);
  });

  it('leaves the fast watchers exactly as accurate as they were', () => {
    /* 45 minutes was the old threshold for every watcher, and it stays the floor. */
    expect(wfs.staleAfterMs(sched('minute', { n: 1 }))).toBe(45 * MIN);
    expect(wfs.staleAfterMs(sched('minute', { n: 15 }))).toBe(45 * MIN);
    expect(wfs.staleAfterMs(sched('minute', { n: 20 }))).toBe(45 * MIN);
    expect(wfs.STALE_FLOOR_MS).toBe(45 * MIN);
  });

  it('scales past the floor when the interval is longer than it', () => {
    expect(wfs.staleAfterMs(sched('hour', { n: 1 }))).toBe(90 * MIN);
    expect(wfs.staleAfterMs(sched('hour', { n: 6 }))).toBe(9 * 60 * MIN);
  });

  /* An unscheduled or unknown flow keeps the old answer rather than becoming never-stale. */
  it('falls back to the floor for anything it cannot read', () => {
    expect(wfs.staleAfterMs({ nodes: [] })).toBe(45 * MIN);
    expect(wfs.staleAfterMs(null)).toBe(45 * MIN);
  });

  it('is what the health route actually judges on, and it says which number it used', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
    const at = src.indexOf("app.get('/v1/watchers/:id/health'");
    expect(at).toBeGreaterThan(-1);
    const route = src.slice(at, at + 1400);
    expect(route).toMatch(/workflows\.staleAfterMs\(wf\)/);
    expect(route).toMatch(/sinceMin > staleAfterMin/);
    /* Reported, so a card that says stale can be checked against the rule that said so. */
    expect(route).toMatch(/staleAfterMinutes: staleAfterMin/);
    expect(route).not.toMatch(/sinceMin > 45/);
  });
});
