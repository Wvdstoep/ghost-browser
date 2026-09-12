/**
 * Who is calling, and what they may hold open.
 *
 * The rule that must not bend: an unauthenticated request never gets a browser. A session costs
 * real memory for its whole life, so an anonymous one is a way to spend someone else's money —
 * which is why there is no free tier that opens Chromium, and why "no keys configured" refuses
 * everything instead of opening up.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseKeys, auth, PLANS } from '../src/keys.js';

const res = () => {
  const r = { code: null, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  return r;
};
const req = (header) => ({ get: (h) => (h.toLowerCase() === 'authorization' ? header : undefined) });

describe('parsing keys out of env', () => {
  it('reads the simple key:plan form', () => {
    const keys = parseKeys('abc:solo,def:team');
    expect(keys.get('abc')).toMatchObject({ plan: 'solo', maxConcurrent: 1 });
    expect(keys.get('def')).toMatchObject({ plan: 'team', maxConcurrent: 3 });
  });

  it('reads the JSON form with an owner', () => {
    const keys = parseKeys(JSON.stringify({ k1: { plan: 'scale', owner: 'acme' } }));
    expect(keys.get('k1')).toMatchObject({ plan: 'scale', owner: 'acme', maxConcurrent: 8 });
  });

  it('drops entries naming a plan that does not exist, rather than inventing one', () => {
    expect(parseKeys('abc:enterprise').size).toBe(0);
  });

  it('is empty when nothing is set', () => {
    expect(parseKeys('').size).toBe(0);
    expect(parseKeys(undefined).size).toBe(0);
  });

  it('has no plan that allows unlimited concurrency', () => {
    for (const p of Object.values(PLANS)) {
      expect(p.maxConcurrent).toBeGreaterThan(0);
      expect(p.maxConcurrent).toBeLessThanOrEqual(8);
    }
  });
});

describe('the middleware', () => {
  it('refuses everything when no keys are configured — that is a misconfiguration, not an open door', () => {
    const r = res();
    auth(new Map())(req('Bearer anything'), r, () => { throw new Error('must not pass'); });
    expect(r.code).toBe(503);
  });

  it('refuses a missing or wrong key', () => {
    const keys = parseKeys('good:solo');
    for (const header of [undefined, '', 'Bearer wrong', 'Basic good']) {
      const r = res();
      auth(keys)(req(header), r, () => { throw new Error('must not pass'); });
      expect(r.code).toBe(401);
    }
  });

  it('attaches the plan to the request so concurrency is enforced from it', () => {
    const keys = parseKeys('good:team');
    const next = vi.fn();
    const request = req('Bearer good');
    auth(keys)(request, res(), next);
    expect(next).toHaveBeenCalled();
    expect(request.client).toMatchObject({ plan: 'team', maxConcurrent: 3 });
  });
});
