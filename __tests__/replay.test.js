/**
 * replay — the REPLAY half wired into a walk, with the live browser faked. The properties that matter,
 * all Carla's rules: a 2xx is the ONLY success; any other status, a thrown fetch, or no response is a
 * failure that quarantines the card and falls back to the UI; a card that cannot be rebuilt from the
 * values at hand is NOT a failure (it never ran) and must not be quarantined; and the page is only put
 * on the card's origin once we know the card actually builds. `runInPage` and `ensureOrigin` are fakes
 * here — the one real in-page fetch is proven by replay.e2e against a live browser.
 */
import { describe, it, expect } from 'vitest';
import { attemptReplay } from '../src/replay.js';
import { distill, onVerified } from '../src/routecards.js';

// A verified card for a simple form API: POST message + a csrf token that is auth-at (re-read live).
const verifiedCard = onVerified(distill({
  intent: 'fixture.post', origin: 'https://app.example.com',
  requests: [{ method: 'POST', url: 'https://app.example.com/api/post', headers: {}, postData: 'message=old&fb_dtsg=T' }],
  now: 1,
}).card, 2);

describe('a verified replay that the API accepts', () => {
  it('done:true, the card is raised, and the UI walk is not needed', async () => {
    let ran = null;
    const out = await attemptReplay({
      card: verifiedCard, values: { message: 'the replayed post' },
      runInPage: (r) => { ran = r; return { status: 200, ok: true }; },
      now: 5,
    });
    expect(out.done).toBe(true);
    expect(out.healed).toBe(false);
    expect(out.status).toBe(200);
    expect(out.card.confidence).toBeGreaterThan(verifiedCard.confidence);   // onVerified raised it
    expect(out.card.quarantined).toBe(false);
    expect(ran.values.message).toBe('the replayed post');                   // the caller's value was carried
    expect(out.reason).toMatch(/answered 200/);
  });

  it('puts the page on the card origin BEFORE the fetch, exactly once', async () => {
    const seen = [];
    await attemptReplay({
      card: verifiedCard, values: { message: 'x' },
      ensureOrigin: (o) => { seen.push(o); },
      runInPage: () => { expect(seen).toEqual(['https://app.example.com']); return { status: 200 }; },
      now: 6,
    });
    expect(seen).toEqual(['https://app.example.com']);
  });
});

describe('a replay the API refuses is a failure that heals', () => {
  it('a non-2xx status quarantines the card and returns to the UI', async () => {
    const out = await attemptReplay({
      card: verifiedCard, values: { message: 'x' },
      runInPage: () => ({ status: 403, ok: false }), now: 7,
    });
    expect(out.done).toBe(false);
    expect(out.healed).toBe(true);
    expect(out.card.quarantined).toBe(true);
    expect(out.reason).toMatch(/did not verify.*403/);
  });

  it('a thrown fetch is a failure, not a crash — quarantine and walk the UI', async () => {
    const out = await attemptReplay({
      card: verifiedCard, values: { message: 'x' },
      runInPage: () => { throw new Error('page closed mid-fetch'); }, now: 8,
    });
    expect(out.healed).toBe(true);
    expect(out.card.quarantined).toBe(true);
  });
});

describe('a card that does not apply is NOT a failure', () => {
  it('an unbuildable card (a missing payload value) never ran, so it is not quarantined', async () => {
    let called = false;
    const out = await attemptReplay({
      card: verifiedCard, values: {},                    // message is missing → buildReplay returns null
      runInPage: () => { called = true; return { status: 200 }; }, now: 9,
    });
    expect(called).toBe(false);                          // the fetch never fired
    expect(out.done).toBe(false);
    expect(out.healed).toBe(false);                      // NOT quarantined
    expect(out.card.quarantined).toBe(false);
    expect(out.reason).toMatch(/cannot be rebuilt/);
  });

  it('cannot reach the origin → walk the UI, but do not quarantine a card that never ran', async () => {
    let called = false;
    const out = await attemptReplay({
      card: verifiedCard, values: { message: 'x' },
      ensureOrigin: () => { throw new Error('navigation blocked'); },
      runInPage: () => { called = true; return { status: 200 }; }, now: 10,
    });
    expect(called).toBe(false);
    expect(out.done).toBe(false);
    expect(out.healed).toBe(false);
    expect(out.card.quarantined).toBe(false);
    expect(out.reason).toMatch(/could not reach/);
  });
});
