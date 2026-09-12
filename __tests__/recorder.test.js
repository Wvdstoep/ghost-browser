/**
 * recorder — the RECORD half, wired to a session's traffic. The properties that matter: it records
 * NOTHING until armed (an ordinary run learns no cards), it keeps only learnable writes on the armed
 * origin, it caps memory keeping the RECENT requests (the act is last), and a discard learns nothing
 * from a broken walk. Pure — the "requests" are plain objects, no browser.
 */
import { describe, it, expect } from 'vitest';
import { makeRecorder } from '../src/recorder.js';

const silent = { info: () => {}, warn: () => {} };
const post = (url, over = {}) => ({ method: 'POST', url, headers: { 'x-fb-lsd': 't' }, postData: '{"a":1}', ...over });

describe('records only while armed', () => {
  it('an unarmed recorder ignores everything', () => {
    const r = makeRecorder({ log: silent });
    r.observe(post('https://www.facebook.com/api/x'));
    expect(r.armed).toBe(false);
    expect(r.finish({ now: 1 })).toBeNull();
  });

  it('armed, it keeps learnable writes on its origin and distils the last as the act', () => {
    const r = makeRecorder({ log: silent });
    r.arm({ intent: 'facebook.page.post', origin: 'https://www.facebook.com' });
    r.observe(post('https://www.facebook.com/ajax/prefetch'));
    r.observe(post('https://www.google-analytics.com/collect', { headers: {} }));   // not learnable
    r.observe(post('https://x.com/other', { }));                                     // wrong origin
    r.observe(post('https://www.facebook.com/api/graphql/', { postData: '{"message":"hi"}' }));
    const out = r.finish({ now: 5 });
    expect(out.ok).toBe(true);
    expect(out.card.url).toMatch(/graphql/);
    expect(out.card.intent).toBe('facebook.page.post');
    expect(r.armed).toBe(false);   // finishing disarms
  });
});

describe('bounded and honest', () => {
  it('caps the buffer keeping the recent requests', () => {
    const r = makeRecorder({ log: silent });
    r.arm({ intent: 'i', origin: 'https://www.facebook.com' });
    for (let n = 0; n < 400; n++) r.observe(post(`https://www.facebook.com/api/${n}`));
    const out = r.finish({ now: 1 });
    // the ACT (last request) survived the cap
    expect(out.card.url).toMatch(/\/api\/399$/);
  });

  it('a walk with no learnable request distils to null, not a broken card', () => {
    const r = makeRecorder({ log: silent });
    r.arm({ intent: 'i', origin: 'https://www.facebook.com' });
    r.observe({ method: 'GET', url: 'https://www.facebook.com/feed' });
    expect(r.finish({ now: 1 })).toBeNull();
  });

  it('discard learns nothing — a failed walk must not teach a card', () => {
    const r = makeRecorder({ log: silent });
    r.arm({ intent: 'i', origin: 'https://www.facebook.com' });
    r.observe(post('https://www.facebook.com/api/graphql/'));
    r.discard();
    expect(r.armed).toBe(false);
    expect(r.finish({ now: 1 })).toBeNull();
  });

  it('a second arm replaces the first — the walk changed', () => {
    const r = makeRecorder({ log: silent });
    r.arm({ intent: 'first', origin: 'https://a.com' });
    r.observe(post('https://a.com/api/x'));
    r.arm({ intent: 'second', origin: 'https://b.com' });
    expect(r.intent).toBe('second');
    r.observe(post('https://b.com/api/y'));
    const out = r.finish({ now: 1 });
    expect(out.card.intent).toBe('second');
    expect(out.card.url).toMatch(/b\.com/);
  });
});

describe('sealing the act — a setup walk creates, THEN navigates', () => {
  it('the card is the write at the seal, not the last navigation write', () => {
    // A Facebook page setup: fill fields (a validation write), CREATE (the act), then the walk
    // navigates on and fires more writes to find the new page's URL. The seal is dropped at the
    // create; the card must be the create, never the trailing navigation.
    const r = makeRecorder({ log: silent });
    r.arm({ intent: 'facebook.page.setup', origin: 'https://www.facebook.com' });
    r.observe(post('https://www.facebook.com/api/graphql/', { postData: '{"validate":"name"}' })); // 0
    r.seal();                                                                                       // act lands next
    r.observe(post('https://www.facebook.com/api/graphql/', { postData: '{"createPage":"PrintOps"}' })); // 1 = the act
    r.observe(post('https://www.facebook.com/api/graphql/', { postData: '{"loadFeed":1}' }));       // 2 navigation
    r.observe(post('https://www.facebook.com/api/graphql/', { postData: '{"search":"PrintOps"}' })); // 3 navigation
    expect(r.sealed).toBe(true);
    const out = r.finish({ now: 1 });
    expect(out.ok).toBe(true);
    expect(out.card.slots).toEqual(['createPage']);        // the CREATE, not loadFeed/search/validate
  });

  it('sealed is false until seal() is called, and reset by a fresh arm', () => {
    const r = makeRecorder({ log: silent });
    r.arm({ intent: 'i', origin: 'https://x.com' });
    expect(r.sealed).toBe(false);
    r.observe(post('https://x.com/api/a'));
    r.seal();
    expect(r.sealed).toBe(true);
    r.arm({ intent: 'i2', origin: 'https://x.com' });      // a new walk starts unsealed
    expect(r.sealed).toBe(false);
  });

  it('a cap-drop shifts the seal so it still points at the act', () => {
    const r = makeRecorder({ log: silent });
    r.arm({ intent: 'i', origin: 'https://x.com' });
    for (let n = 0; n < 300; n++) r.observe(post(`https://x.com/api/pre${n}`)); // fill to the cap
    r.seal();                                                                    // act lands next
    r.observe(post('https://x.com/api/THE-ACT', { postData: '{"act":1}' }));      // pushes one off the front → seal shifts down
    const out = r.finish({ now: 1 });
    expect(out.card.url).toMatch(/THE-ACT$/);
  });
});
