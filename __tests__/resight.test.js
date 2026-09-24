/*
 * RE-SIGHTING THE OLD RUNS, AND THE WAYS IT COULD MINT A WRONG PAGE.
 *
 * A re-sight attaches a page fetched today to a decision taken months ago. The danger is not that it
 * fails - a failed fetch leaves the turn blind, as it was - but that it succeeds on the WRONG page:
 * a read after a click nobody recorded, a 404 the same length as an article, a redirect to a login
 * wall. Each test here is one of those.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import resight from '../src/resight.js';

const { candidates, accept, contentFor, pick, left, load, save, setOn, state, urlOfStep } = resight;

const step = (kind, text, extra = {}) => ({ kind, text, at: '2026-09-01T00:00:00Z', ...extra });
const blind = (n) => step('read', `read the page (${n} characters)`);

describe('which reads can be re-taken', () => {
  it('takes the address from the open before the read', () => {
    const job = { steps: [step('tool', 'open(https://example.org/a)'), step('open', 'https://example.org/a'), step('tool', 'read()'), blind(911)] };
    expect(candidates(job)).toEqual([{ index: 3, url: 'https://example.org/a', expected: 911 }]);
  });

  it('never re-sights a read after a click, because nobody knows where the click went', () => {
    const job = { steps: [step('open', 'https://example.org/a'), step('click', 'clicked [3]'), blind(911)] };
    expect(candidates(job)).toEqual([]);
  });

  it('knows the address again after a later open, and from a dig that named its url', () => {
    const job = { steps: [
      step('open', 'https://example.org/a'), step('click', 'clicked [3]'), blind(100),
      step('read', 'read https://example.org/b (2000 characters)', { url: 'https://example.org/b' }), blind(2100),
    ] };
    expect(candidates(job)).toEqual([{ index: 4, url: 'https://example.org/b', expected: 2100 }]);
  });

  it('leaves alone a read that already carries its page, or was already tried', () => {
    const job = { steps: [
      step('open', 'https://example.org/a'),
      { ...blind(500), content: 'You are on: ...' },
      { ...blind(500), resighted: { rejected: 'empty' } },
      blind(500),
    ] };
    expect(candidates(job).map((c) => c.index)).toEqual([3]);
  });

  it('reads "back to" and "now using" as addresses too', () => {
    expect(urlOfStep(step('open', 'back to https://example.org/x'))).toBe('https://example.org/x');
    expect(urlOfStep(step('open', 'now using "hn" — https://news.ycombinator.com/'))).toBe('https://news.ycombinator.com/');
    expect(urlOfStep(step('look', 'Example — 12 things to click'))).toBeNull();
  });
});

describe('whether the page fetched today is the page read then', () => {
  it('accepts a length within a third of the record, on the same site', () => {
    expect(accept({ expected: 1000, got: 1200, asked: 'https://a.org/x', landed: 'https://www.a.org/x' }).ok).toBe(true);
  });
  it('refuses an empty page, a redirect elsewhere, and a page of a different size', () => {
    expect(accept({ expected: 1000, got: 12 }).ok).toBe(false);
    expect(accept({ expected: 1000, got: 1000, asked: 'https://a.org/x', landed: 'https://login.b.org/' }).why).toMatch(/redirected/);
    expect(accept({ expected: 1000, got: 300 }).why).toMatch(/300 characters today against 1000/);
    expect(accept({ expected: 1000, got: 4000 }).ok).toBe(false);
  });
  it('hands the model exactly what the read tool would have', () => {
    const c = contentFor('https://a.org/x', 'one\n\n\n\ntwo');
    expect(c).toBe('You are on: https://a.org/x\n\nPage text:\none\n\ntwo');
    expect(contentFor('u', 'x'.repeat(9000)).length).toBeLessThan(5100);
  });
});

describe('the order and the bookkeeping', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-resight-')); process.env.PROFILE_DIR = dir; });
  afterEach(() => { delete process.env.PROFILE_DIR; try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });

  const run = (id, tier, n = 2) => ({ id, status: 'done', createdAt: `2026-09-0${n}T00:00:00Z`, verdict: { tier },
    steps: [step('open', `https://${id}.org/`), blind(800), step('scroll', 'down'), blind(1600)] });

  it('takes gold runs first, skips void ones and runs already done, and never overfills a batch', () => {
    const jobs = [run('silver1', 'silver'), run('gold1', 'gold'), run('void1', 'void'), run('gold2', 'gold', 3)];
    const b = pick(jobs, { doneJobs: { gold2: 'x' } }, { max: 3 });
    expect(b.map((x) => x.job.id)).toEqual(['gold1', 'silver1']);
    expect(b[0].cands.length).toBe(2);
    expect(b[1].cands.length).toBe(1);
    expect(left(jobs, { doneJobs: { gold2: 'x' } })).toBe(4);
  });

  it('scans the runs on disk in slices, and orders what it found gold first', () => {
    const { scan, order, loadJob } = resight;
    const jdir = path.join(dir, 'jobs');
    fs.mkdirSync(jdir, { recursive: true });
    for (const j of [run('silver1', 'silver'), run('gold1', 'gold'), run('void1', 'void'), run('gold2', 'gold', 3)]) {
      fs.writeFileSync(path.join(jdir, `${j.id}.json`), JSON.stringify(j));
    }
    fs.writeFileSync(path.join(jdir, 'broken.json'), '{not json');
    const a = scan(jdir, { doneJobs: {} }, { from: 0, limit: 2 });
    expect(a.done).toBe(false);
    expect(a.next).toBe(2);
    const b = scan(jdir, { doneJobs: {} }, { from: a.next, limit: 100 });
    expect(b.done).toBe(true);
    const all = order([...a.found, ...b.found]);
    expect(all.map((e) => e.id)).toEqual(['gold2', 'gold1', 'silver1']);
    expect(all.every((e) => e.n === 2)).toBe(true);
    expect(loadJob(jdir, 'gold1').id).toBe('gold1');
    expect(loadJob(jdir, 'nope')).toBeNull();
  });

  it('keeps its tallies and its switch on disk', () => {
    expect(load().on).toBe(false);
    setOn(true);
    const st = load(); st.accepted = 7; st.rejected = 2; st.left = 40; st.doneJobs.a = 'x'; save(st);
    expect(state()).toMatchObject({ on: true, accepted: 7, rejected: 2, left: 40, doneJobs: 1 });
    setOn(false);
    expect(state().on).toBe(false);
  });
});
