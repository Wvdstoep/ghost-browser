/**
 * keyring — a second account, and the sense to move to it.
 *
 * The week this exists for: the whole factory ran on one model account, and the day its weekly
 * allowance ended EVERYTHING stopped at once — the builder mid-fix, the master's research verdicts,
 * this browser's QA runs. Three services, one account behind all of them.
 */
import { describe, it, expect } from 'vitest';
import { makeKeyring, isSpent } from '../src/keyring.js';

describe('isSpent — an allowance that resets, not a busy minute', () => {
  it('recognises a spent allowance from what the provider SAYS', () => {
    expect(isSpent({ status: 429, body: 'you (carla) have reached your weekly usage limit' })).toBe(true);
    expect(isSpent({ status: 429, message: 'quota exceeded' })).toBe(true);
    expect(isSpent({ status: 429, body: 'out of credits' })).toBe(true);
  });
  it('does NOT burn a second key on a rate limit, which clears by waiting', () => {
    // The distinction is the whole point: a per-minute limit costs nothing to wait out, and
    // rotating on it would spend both accounts on a problem neither of them has.
    expect(isSpent({ status: 429, body: 'too many requests, slow down' })).toBe(false);
    expect(isSpent({ status: 429, body: 'rate limit exceeded, retry in 20s' })).toBe(false);
  });
  it('a rejected key is not a spent one — the next key would fail identically', () => {
    expect(isSpent({ status: 401, body: 'invalid api key' })).toBe(false);
    expect(isSpent({ status: 500, body: 'usage limit' })).toBe(false);   // status must be 429 too
  });
});

describe('makeKeyring', () => {
  it('prefers the first key and moves on only when it is spent', () => {
    const r = makeKeyring(['a', 'b']);
    expect(r.current()).toBe('a');
    expect(r.spend('a')).toBe('b');
    expect(r.current()).toBe('b');
  });

  it('treats the same key twice as one key', () => {
    const r = makeKeyring(['a', 'a', 'b']);
    expect(r.state()).toEqual({ total: 2, usable: 2, dead: 0 });
  });

  it('ignores blanks, so an unset second field costs nothing', () => {
    const r = makeKeyring(['', '  ', 'a']);
    expect(r.state()).toEqual({ total: 1, usable: 1, dead: 0 });
    expect(r.current()).toBe('a');
  });

  it('lets a rested key back in — an allowance that reset should be used', () => {
    let t = 0;
    const r = makeKeyring(['a', 'b'], { now: () => t, restMs: 1000 });
    r.spend('a');
    expect(r.current()).toBe('b');
    t = 2000;
    expect(r.current()).toBe('a');          // rested, and it is still the preferred key
    expect(r.state()).toEqual({ total: 2, usable: 2, dead: 0 });
  });

  it('with every key spent it hands back the oldest rather than nothing', () => {
    /*
     * The caller still has work to do and the provider may have reset early. A real 429 is a better
     * answer than a synthetic "no key", which is an error path nobody has ever exercised.
     */
    let t = 0;
    const r = makeKeyring(['a', 'b'], { now: () => t, restMs: 60000 });
    r.spend('a'); t = 10; r.spend('b');
    expect(r.state().usable).toBe(0);
    expect(r.current()).toBe('a');          // spent longest ago
  });

  it('is honest when there are no keys at all', () => {
    const r = makeKeyring([]);
    expect(r.current()).toBe(null);
    expect(r.spend('nope')).toBe(null);
  });
});

describe('the primary key is used FIRST — the order is what "backup" means', () => {
  /*
   * Measured live: the master began returning 401 the moment a backup key was saved. The ring was
   * built backup-first, so the reserve account became the one every call used and the working
   * primary only ever saw its failures. A backup that is tried first is not a backup.
   */
  it('hands out the primary while it is healthy', () => {
    const r = makeKeyring(['primary', 'backup']);
    expect(r.current()).toBe('primary');
  });

  it('reaches the backup only once the primary is spent', () => {
    const r = makeKeyring(['primary', 'backup']);
    expect(r.spend('primary')).toBe('backup');
    expect(r.current()).toBe('backup');
  });

  it('prefers the primary again as soon as it has rested', () => {
    let t = 0;
    const r = makeKeyring(['primary', 'backup'], { now: () => t, restMs: 1000 });
    r.spend('primary');
    expect(r.current()).toBe('backup');
    t = 2000;
    expect(r.current()).toBe('primary');
  });
});
