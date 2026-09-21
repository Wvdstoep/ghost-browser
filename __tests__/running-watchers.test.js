/*
 * A FLAG THAT CANNOT LET GO WEDGES THE WHOLE MACHINE.
 *
 * The bug, from production: `facebook-post-polish-it-group-offer` stayed in runningWatchers for 114
 * minutes. Its own health said it all — active:false, running:true, and a recorded lastPass that had
 * started and ENDED inside seven seconds, nearly two hours earlier. It held no browser session.
 *
 * Nothing was ever going to clear it. The flag was removed in .finally(), so a pass that throws
 * cleans up, but a promise that never settles cannot: the only code that would release the flag is
 * the callback that never ran.
 *
 * Three things were blocked by that one entry, because the gates ask `.size`, not anything about the
 * profile: every other watcher pass, every flow run (the dev agent burned 40 of 150 iterations in a
 * sleep-and-retry loop), and the deployer's idle gate, which left a built image unrolled for hours.
 *
 * And it was unreportable: health computes stale as `active && !running && ...`, so a stuck flag
 * makes `running` true and staleness false forever. These tests pin the release, and pin that the
 * release is loud, because a silent reap would hide a hanging pass instead of surfacing it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { RunningWatchers, DEFAULT_TTL_MS, ttl } = require('../src/runningWatchers');

const MIN = 60 * 1000;
const logger = () => { const warns = []; return { warns, warn: (m) => warns.push(m) }; };

describe('runningWatchers: one pass at a time, and never forever', () => {
  const saved = process.env.WATCHER_RUN_TTL_MS;
  afterEach(() => { if (saved === undefined) delete process.env.WATCHER_RUN_TTL_MS; else process.env.WATCHER_RUN_TTL_MS = saved; });

  it('still gates a second pass while the first is genuinely running', () => {
    const r = new RunningWatchers(logger());
    r.add('useme-gigs');
    expect(r.size).toBe(1);
    expect(r.has('useme-gigs')).toBe(true);
    expect([...r]).toEqual(['useme-gigs']);      // the gates spread it into their message
  });

  it('releases when the pass settles, as it always did', () => {
    const r = new RunningWatchers(logger());
    r.add('useme-gigs'); r.delete('useme-gigs');
    expect(r.size).toBe(0);
  });

  /* THE BUG. 114 minutes, on a watcher that was not even active. */
  it('lets go of a flag whose pass never settled', () => {
    const log = logger();
    const r = new RunningWatchers(log);
    r.add('facebook-post-polish-it-group-offer');
    r._at.set('facebook-post-polish-it-group-offer', Date.now() - 114 * MIN);
    expect(r.size).toBe(0);
    expect(r.has('facebook-post-polish-it-group-offer')).toBe(false);
  });

  it('says so out loud, naming the run and how long it held', () => {
    const log = logger();
    const r = new RunningWatchers(log);
    r.add('facebook-post-polish-it-group-offer');
    r._at.set('facebook-post-polish-it-group-offer', Date.now() - 114 * MIN);
    r.reap();
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]).toContain('facebook-post-polish-it-group-offer');
    expect(log.warns[0]).toMatch(/11[0-9] min/);
    expect(log.warns[0]).toMatch(/never settled/);
  });

  /* A reap frees the FLAG, not the work, so it must not fire on a pass that is merely slow. */
  it('leaves a slow but plausible pass alone', () => {
    const log = logger();
    const r = new RunningWatchers(log);
    r.add('facebook-post-watcher');
    r._at.set('facebook-post-watcher', Date.now() - 25 * MIN);   // under the 30 min cap
    expect(r.size).toBe(1);
    expect(log.warns).toHaveLength(0);
  });

  it('frees the machine for everyone else, not just the stuck watcher', () => {
    const r = new RunningWatchers(logger());
    r.add('stuck'); r._at.set('stuck', Date.now() - 90 * MIN);
    r.add('useme-gigs');                                          // a healthy pass, just started
    expect([...r]).toEqual(['useme-gigs']);
    /* .size is what every gate actually asks, and it is why one stuck flag blocked all of them. */
    r.delete('useme-gigs');
    expect(r.size).toBe(0);
  });

  it('reaps on every kind of read, since the gates do not all ask the same way', () => {
    const mk = () => { const r = new RunningWatchers(logger()); r.add('stuck'); r._at.set('stuck', Date.now() - 90 * MIN); return r; };
    expect(mk().size).toBe(0);
    expect(mk().has('stuck')).toBe(false);
    expect([...mk().values()]).toEqual([]);
    expect([...mk().keys()]).toEqual([]);
    expect([...mk()]).toEqual([]);
    const seen = []; mk().forEach((k) => seen.push(k)); expect(seen).toEqual([]);
  });

  it('reports who holds a flag and since when — the two facts that diagnosed this', () => {
    const r = new RunningWatchers(logger());
    const t0 = Date.now();
    r.add('useme-gigs');
    expect(r.startedAt('useme-gigs')).toBeGreaterThanOrEqual(t0);
    expect(r.startedAt('nobody')).toBe(0);
  });

  it('forgets the timestamp too, so a re-run is not judged by the old one', () => {
    const r = new RunningWatchers(logger());
    r.add('useme-gigs'); r._at.set('useme-gigs', Date.now() - 90 * MIN);
    r.delete('useme-gigs');
    r.add('useme-gigs');                                          // fresh run, same id
    expect(r.size).toBe(1);
    expect(r.startedAt('useme-gigs')).toBeGreaterThan(Date.now() - MIN);
  });

  it('takes the cap from the environment, refusing a value too small to be safe', () => {
    delete process.env.WATCHER_RUN_TTL_MS;
    expect(ttl()).toBe(DEFAULT_TTL_MS);
    process.env.WATCHER_RUN_TTL_MS = String(45 * MIN);
    expect(ttl()).toBe(45 * MIN);
    /* A tiny cap would reap healthy passes and let two fight for one browser: refuse it. */
    process.env.WATCHER_RUN_TTL_MS = '5';
    expect(ttl()).toBe(DEFAULT_TTL_MS);
    process.env.WATCHER_RUN_TTL_MS = 'soon';
    expect(ttl()).toBe(DEFAULT_TTL_MS);
  });

  it('survives having no logger rather than throwing while clearing', () => {
    const r = new RunningWatchers(null);
    r.add('stuck'); r._at.set('stuck', Date.now() - 90 * MIN);
    expect(() => r.size).not.toThrow();
    expect(r.size).toBe(0);
  });
});
