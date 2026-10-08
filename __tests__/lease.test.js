/** lease — the pure decisions: signed, expiring, bound to a profile, fail-closed, constrained per field. */
import { describe, it, expect } from 'vitest';
import { mint, verify, decide } from '../src/lease.js';

const SECRET = 'test-secret';
const post = (url, body) => ({ method: 'POST', url, postData: JSON.stringify(body) });
const lease = (allow, o = {}) => verify(SECRET, mint(SECRET, { profile: 'p', allow, ...o }), { profile: 'p' });

describe('a lease is trusted only if it is signed, current, and for this profile', () => {
  it('verifies a fresh one and refuses a tampered, expired, foreign or unsigned one', () => {
    const t = mint(SECRET, { profile: 'p', allow: [{ method: 'POST', path: '/x' }], ttlMs: 60000, now: 1000 });
    expect(verify(SECRET, t, { profile: 'p', now: 2000 })).toBeTruthy();
    expect(verify(SECRET, t, { profile: 'p', now: 1000 + 61000 })).toBeNull();          // expired
    expect(verify(SECRET, t, { profile: 'other', now: 2000 })).toBeNull();              // another profile's lease
    expect(verify('wrong', t, { profile: 'p', now: 2000 })).toBeNull();                 // another secret
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), allow: [{ method: 'POST', path: '/*', body: null, max: null }] })).toString('base64url');
    expect(verify(SECRET, forged + '.' + sig, { profile: 'p', now: 2000 })).toBeNull(); // widened after signing
    expect(verify(SECRET, '', {})).toBeNull();
    expect(verify(SECRET, 'garbage', {})).toBeNull();
  });
});

describe('decide', () => {
  it('lets reads through with no lease at all, and refuses every write (fail closed)', () => {
    expect(decide(null, { method: 'GET', url: 'http://a/x' }).allow).toBe(true);
    expect(decide(null, { method: 'HEAD', url: 'http://a/x' }).allow).toBe(true);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(decide(null, { method: m, url: 'http://a/x' }).allow).toBe(false);
  });
  it('allows exactly the write the lease names, and nothing next to it', () => {
    const l = lease([{ method: 'POST', path: '/api/send' }]);
    expect(decide(l, post('http://a/api/send', { to: 'x' })).allow).toBe(true);
    expect(decide(l, post('http://a/api/delete', {})).allow).toBe(false);
    expect(decide(l, { method: 'PUT', url: 'http://a/api/send' }).allow).toBe(false);
    expect(decide(l, post('http://a/api/send/../delete', {})).allow).toBe(false);
  });
  it('constrains body fields by pattern, for JSON and form bodies alike', () => {
    const l = lease([{ method: 'POST', path: '/api/send', body: { to: '^bob@example\\.org$' } }]);
    expect(decide(l, post('http://a/api/send', { to: 'bob@example.org' })).allow).toBe(true);
    expect(decide(l, post('http://a/api/send', { to: 'eve@evil.example' })).allow).toBe(false);
    expect(decide(l, post('http://a/api/send', { to: 'bob@example.org.evil.example' })).allow).toBe(false);
    expect(decide(l, post('http://a/api/send', {})).allow).toBe(false);                    // field absent
    expect(decide(l, { method: 'POST', url: 'http://a/api/send', postData: 'to=bob%40example.org&body=hi' }).allow).toBe(true);
    expect(decide(l, { method: 'POST', url: 'http://a/api/send', postData: 'to=eve%40evil.example' }).allow).toBe(false);
  });
  it('counts uses per rule', () => {
    const l = lease([{ method: 'POST', path: '/api/send', max: 2 }]);
    expect(decide(l, post('http://a/api/send', {}), [1]).allow).toBe(true);
    expect(decide(l, post('http://a/api/send', {}), [2]).allow).toBe(false);
  });
  it('supports a single-segment wildcard in the path and no more', () => {
    const l = lease([{ method: 'DELETE', path: '/api/items/*' }]);
    expect(decide(l, { method: 'DELETE', url: 'http://a/api/items/7' }).allow).toBe(true);
    expect(decide(l, { method: 'DELETE', url: 'http://a/api/items/7/comments' }).allow).toBe(false);
  });
  it('an expired lease is read-only', () => {
    const l = lease([{ method: 'POST', path: '/api/send' }]);
    expect(decide(l, post('http://a/api/send', {}), [], l.exp + 1).allow).toBe(false);
  });
});
