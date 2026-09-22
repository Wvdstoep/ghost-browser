/*
 * THE TALLY, AND THE FOUR WAYS A CACHED COUNT GOES WRONG WHILE LOOKING RIGHT.
 *
 * Counting 2,240 job files is easy once. Keeping that count correct while it is cached, sliced
 * across calls and updated from a directory other processes are writing to is where the mistakes
 * live, and none of them raise anything:
 *
 *   - a re-judged job is counted twice, so the corpus drifts upward for ever;
 *   - a deleted job is counted for ever, so it only ever grows;
 *   - the watermark advances past files the slice did not reach, so they are never read at all;
 *   - "not judged yet" and "not read yet" are collapsed, so unfinished work and unread files become
 *     the same thing and neither number means anything.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { tally, usableSince, verdictOf } from '../src/corpus.js';

let dir, jobs, cache;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-corpus-'));
  jobs = path.join(dir, 'jobs');
  cache = path.join(dir, 'cache.json');
  fs.mkdirSync(jobs);
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });

const write = (id, verdict, at = '2026-09-01T10:00:00.000Z') =>
  fs.writeFileSync(path.join(jobs, `${id}.json`), JSON.stringify({
    id, endedAt: at, ...(verdict ? { verdict: { tier: verdict, at } } : {}),
  }));

describe('the tally', () => {
  it('counts each tier once', () => {
    write('a', 'gold'); write('b', 'gold'); write('c', 'silver'); write('d', 'bronze'); write('e', 'void');
    const t = tally({ dir: jobs, cacheFile: cache });
    expect(t.tiers).toEqual({ gold: 2, silver: 1, bronze: 1, void: 1 });
    expect(t.jobs).toBe(5);
    expect(t.scanning).toBe(false);
  });

  it('separates a job that has no verdict from a file it has not read', () => {
    /* Collapsing these makes every still-running job look like unread backlog, and the "is the
       screen still filling in" answer stops meaning anything. */
    write('a', 'gold'); write('b', null);
    const t = tally({ dir: jobs, cacheFile: cache });
    expect(t.unjudged).toBe(1);
    expect(t.tiers.gold).toBe(1);
    expect(t.pending).toBe(0);
  });

  it('DOES NOT DOUBLE-COUNT A JOB THAT WAS RE-JUDGED', () => {
    /* Caching tier COUNTS instead of per-job tiers would add the new verdict without removing the
       old one. The number then drifts upward for ever and nothing about it looks wrong. */
    write('a', 'silver');
    expect(tally({ dir: jobs, cacheFile: cache }).tiers).toEqual({ gold: 0, silver: 1, bronze: 0, void: 0 });

    const p = path.join(jobs, 'a.json');
    const later = Date.now() + 5000;
    fs.writeFileSync(p, JSON.stringify({ id: 'a', verdict: { tier: 'gold', at: '2026-09-02T10:00:00.000Z' } }));
    fs.utimesSync(p, later / 1000, later / 1000);

    expect(tally({ dir: jobs, cacheFile: cache }).tiers).toEqual({ gold: 1, silver: 0, bronze: 0, void: 0 });
  });

  it('stops counting a job whose file is gone', () => {
    write('a', 'gold'); write('b', 'gold');
    tally({ dir: jobs, cacheFile: cache });
    fs.unlinkSync(path.join(jobs, 'b.json'));
    const t = tally({ dir: jobs, cacheFile: cache });
    expect(t.tiers.gold).toBe(1);
    expect(t.jobs).toBe(1);
  });

  it('re-reads nothing on a second call when nothing changed', () => {
    write('a', 'gold');
    tally({ dir: jobs, cacheFile: cache });
    /* Proved by making the file unreadable: a second call that still answers correctly cannot have
       opened it. This is the whole reason the cache exists — 284 MB is not a per-poll cost. */
    fs.writeFileSync(path.join(jobs, 'a.json'), 'not json at all');
    const before = fs.statSync(path.join(jobs, 'a.json'));
    fs.utimesSync(path.join(jobs, 'a.json'), before.atime, new Date(0));
    expect(tally({ dir: jobs, cacheFile: cache }).tiers.gold).toBe(1);
  });
});

describe('reading the history in slices', () => {
  it('reports what is still waiting instead of pretending to be finished', () => {
    for (let i = 0; i < 10; i++) write(`j${i}`, 'gold');
    const first = tally({ dir: jobs, cacheFile: cache, slice: 4 });
    expect(first.tiers.gold).toBe(4);
    expect(first.pending).toBe(6);
    expect(first.scanning).toBe(true);
  });

  it('EVENTUALLY READS EVERY FILE, rather than marking unread ones as seen', () => {
    /* The trap: advance the watermark to "now" after a partial slice and every file older than it
       is treated as already read. The count then stops climbing and settles on a wrong number that
       nothing will ever correct. */
    for (let i = 0; i < 10; i++) write(`j${i}`, 'gold');
    let t;
    for (let i = 0; i < 5; i++) t = tally({ dir: jobs, cacheFile: cache, slice: 4 });
    expect(t.tiers.gold).toBe(10);
    expect(t.pending).toBe(0);
    expect(t.scanning).toBe(false);
  });

  it('survives a half-written job file without abandoning the rest', () => {
    write('a', 'gold');
    fs.writeFileSync(path.join(jobs, 'b.json'), '{"id":"b","verdi');
    const t = tally({ dir: jobs, cacheFile: cache });
    expect(t.tiers.gold).toBe(1);
    expect(t.unjudged).toBe(1);
  });

  it('answers an empty machine without throwing', () => {
    const t = tally({ dir: path.join(dir, 'nope'), cacheFile: cache });
    expect(t.tiers).toEqual({ gold: 0, silver: 0, bronze: 0, void: 0 });
    expect(t.jobs).toBe(0);
  });
});

describe('what counts towards the next round', () => {
  it('counts gold and silver after the moment, and nothing else', () => {
    const ids = {
      a: { tier: 'gold', at: '2026-09-05T00:00:00.000Z' },
      b: { tier: 'silver', at: '2026-09-05T00:00:00.000Z' },
      /* Bronze and void are kept and used differently; neither makes a round worth a night. */
      c: { tier: 'bronze', at: '2026-09-05T00:00:00.000Z' },
      d: { tier: 'void', at: '2026-09-05T00:00:00.000Z' },
      e: { tier: 'gold', at: '2026-09-01T00:00:00.000Z' },
      f: false,
    };
    expect(usableSince(ids, '2026-09-03T00:00:00.000Z')).toBe(2);
  });

  it('counts nothing when there is no moment to count from', () => {
    expect(usableSince({ a: { tier: 'gold', at: '2026-09-05T00:00:00.000Z' } }, '')).toBe(0);
  });
});

describe('the verdict a job carries', () => {
  it('ignores a tier nobody defined', () => {
    expect(verdictOf({ verdict: { tier: 'platinum' } })).toBe(null);
  });

  it('falls back to when the job ended if the verdict carries no time', () => {
    expect(verdictOf({ verdict: { tier: 'gold' }, endedAt: 'x' }).at).toBe('x');
  });
});
