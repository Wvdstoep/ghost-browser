/**
 * routecards — the browser learning the API it was using all along. The disciplines a prompt cannot
 * enforce: only WRITES to the page's own API are learnable (not analytics, not assets, not reads);
 * a card stores where a token LIVES, never its value; an act with no auth marker is refused rather
 * than shipped to 401 forever; an unverified card never displaces the UI; and ONE failure quarantines
 * a card, because a stale internal API doing the wrong thing silently is the error this must not cause.
 * Pure module, no browser.
 */
import { describe, it, expect } from 'vitest';
import { isLearnable, originOf, shapeOf, distill, planFor, onVerified, onFailed, buildReplay, afterReplay, cardKey } from '../src/routecards.js';

const req = (over = {}) => ({ method: 'POST', url: 'https://www.facebook.com/api/graphql/', headers: { 'x-fb-lsd': 'AbC' }, postData: '{"text":"hi"}', ...over });

describe('what is worth learning from', () => {
  it('only WRITES to the page\'s own API — never GETs, analytics, or assets', () => {
    expect(isLearnable(req())).toBe(true);
    expect(isLearnable(req({ method: 'GET' }))).toBe(false);
    expect(isLearnable(req({ url: 'https://www.facebook.com/main.js' }))).toBe(false);
    expect(isLearnable(req({ url: 'https://www.google-analytics.com/collect', method: 'POST' }))).toBe(false);
    expect(isLearnable(req({ url: 'https://www.facebook.com/tr?ev=x', method: 'POST' }))).toBe(false);
  });

  it('originOf fences a card to one site', () => {
    expect(originOf('https://www.facebook.com/api/x?y=1')).toBe('https://www.facebook.com');
    expect(originOf('garbage')).toBe('');
  });
});

describe('a card stores SHAPE, never secrets', () => {
  it('json body → slots are its keys, auth is remembered by NAME and place', () => {
    const s = shapeOf(req({ postData: '{"text":"hello","audience":"public"}' }));
    expect(s.bodyKind).toBe('json');
    expect(s.slots).toEqual(['text', 'audience']);
    expect(s.authAt).toContainEqual({ in: 'header', name: 'x-fb-lsd' });
    // the actual token value never appears anywhere in the shape
    expect(JSON.stringify(s)).not.toMatch(/AbC/);
  });

  it('form body → csrf-ish fields are recognised as auth-at, not just data slots', () => {
    const s = shapeOf(req({ headers: {}, postData: 'message=hi&fb_dtsg=TOKEN123&jazoest=2' }));
    expect(s.bodyKind).toBe('form');
    expect(s.slots).toEqual(['message', 'fb_dtsg', 'jazoest']);
    expect(s.authAt).toContainEqual({ in: 'body', name: 'fb_dtsg' });
    expect(JSON.stringify(s)).not.toMatch(/TOKEN123/);
  });
});

describe('distilling a walk into a card', () => {
  const walk = [
    req({ url: 'https://www.facebook.com/ajax/bootload', headers: { 'x-fb-lsd': 'x' } }),
    req({ url: 'https://www.google-analytics.com/collect', method: 'POST', headers: {} }),
    req({ url: 'https://www.facebook.com/api/graphql/', headers: { 'x-fb-lsd': 'x' }, postData: '{"variables":{"message":"hi"}}' }),
  ];

  it('picks the LAST learnable write as the act, ignoring analytics between', () => {
    const out = distill({ intent: 'facebook.page.post', origin: 'https://www.facebook.com', requests: walk, now: 100 });
    expect(out.ok).toBe(true);
    expect(out.card.intent).toBe('facebook.page.post');
    expect(out.card.url).toMatch(/graphql/);
    expect(out.card.confidence).toBe(0);          // DISTILL proposes; VERIFY earns confidence
    expect(out.card.lastVerified).toBeNull();
  });

  it('refuses an act with no auth marker — a card that would 401 forever is worse than none', () => {
    const out = distill({ intent: 'x', origin: 'https://www.facebook.com', requests: [req({ headers: {}, postData: '{"a":1}' })] });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/no auth token/);
  });

  it('a walk with no learnable request yields no card', () => {
    expect(distill({ intent: 'x', requests: [req({ method: 'GET' })] })).toBeNull();
  });

  it('with a sealIndex, the act is the write AT the seal — not the last one', () => {
    // setup walk: [validate, CREATE, navigate, navigate]; the seal was dropped before the create.
    const reqs = [
      req({ postData: '{"validate":1}' }),
      req({ postData: '{"createPage":"PrintOps"}' }),
      req({ postData: '{"loadFeed":1}' }),
      req({ postData: '{"search":"PrintOps"}' }),
    ];
    const out = distill({ intent: 'facebook.page.setup', origin: 'https://www.facebook.com', requests: reqs, now: 1, sealIndex: 1 });
    expect(out.ok).toBe(true);
    expect(out.card.slots).toEqual(['createPage']);
  });

  it('without a sealIndex, it still falls back to the LAST write (an operate walk ends on its act)', () => {
    const reqs = [req({ postData: '{"a":1}' }), req({ postData: '{"theActuralPost":1}' })];
    const out = distill({ intent: 'facebook.page.post', origin: 'https://www.facebook.com', requests: reqs, now: 1 });
    expect(out.card.slots).toEqual(['theActuralPost']);
  });

  it('an out-of-range sealIndex falls back to the last write rather than crashing', () => {
    const out = distill({ intent: 'x', origin: 'https://www.facebook.com', requests: [req()], now: 1, sealIndex: 9 });
    expect(out.ok).toBe(true);
  });
});

describe('the plan: an unproven card never displaces the UI', () => {
  const base = distill({ intent: 'facebook.page.post', origin: 'https://www.facebook.com', requests: [req()], now: 1 }).card;

  it('no card → UI', () => { expect(planFor(null).mode).toBe('ui'); });
  it('freshly distilled but unverified → UI (ride along to verify)', () => {
    expect(planFor(base).mode).toBe('ui');
    expect(planFor(base).reason).toMatch(/not yet verified/);
  });
  it('verified → fast', () => {
    const v = onVerified(base, 2);
    expect(planFor(v).mode).toBe('fast');
    expect(planFor(v).card).toBe(v);
  });
  it('quarantined → UI even if it was once verified', () => {
    const q = onFailed(onVerified(base, 2), 3);
    expect(planFor(q).mode).toBe('ui');
    expect(planFor(q).reason).toMatch(/quarantined/);
  });
});

describe('verify raises, one failure quarantines', () => {
  const base = distill({ intent: 'i', origin: 'https://www.facebook.com', requests: [req()], now: 1 }).card;

  it('onVerified stamps the time, bumps confidence (capped at 5), clears fails', () => {
    let c = base;
    for (let i = 0; i < 8; i++) c = onVerified(c, i);
    expect(c.confidence).toBe(5);
    expect(c.lastVerified).toBe(7);
    expect(c.fails).toBe(0);
    expect(c.quarantined).toBe(false);
  });

  it('a SINGLE failure quarantines and drops confidence — never a slow decay', () => {
    const c = onFailed(onVerified(onVerified(base, 1), 2), 3);
    expect(c.quarantined).toBe(true);
    expect(c.fails).toBe(1);
    expect(c.confidence).toBeLessThan(2);
  });

  it('cardKey is one card per (origin, intent)', () => {
    expect(cardKey('https://www.facebook.com', 'facebook.page.post')).toBe('https://www.facebook.com::facebook.page.post');
  });
});

describe('the replay request and the fallback rule', () => {
  const card = onVerified(distill({
    intent: 'facebook.page.post', origin: 'https://www.facebook.com',
    requests: [{ method: 'POST', url: 'https://www.facebook.com/api/graphql/', headers: {}, postData: 'message=old&fb_dtsg=T&jazoest=2' }],
    now: 1,
  }).card, 2);

  it('buildReplay fills the real slots, leaves the auth-at fields for the live page, carries NO token', () => {
    const r = buildReplay(card, { message: 'our new post', jazoest: '2' });
    expect(r.url).toMatch(/graphql/);
    expect(r.method).toBe('POST');
    expect(r.values.message).toBe('our new post');
    // fb_dtsg is auth-at (body) — not required from the caller; the page merges the live token
    expect(JSON.stringify(r)).not.toMatch(/"fb_dtsg":"T"/);
  });

  it('buildReplay refuses when a required (non-auth) slot has no value — never posts a blank', () => {
    expect(buildReplay(card, { jazoest: '2' })).toBeNull();   // message missing
  });

  it("afterReplay: a FAILED replay quarantines AND returns fallback 'ui' — the same job retries by UI", () => {
    const out = afterReplay(card, { ok: false, now: 5 });
    expect(out.fallback).toBe('ui');
    expect(out.card.quarantined).toBe(true);
  });

  it('afterReplay: a verified replay raises the card and needs no fallback', () => {
    const out = afterReplay(card, { ok: true, now: 5 });
    expect(out.fallback).toBeNull();
    expect(out.card.confidence).toBeGreaterThan(card.confidence);
  });
});
