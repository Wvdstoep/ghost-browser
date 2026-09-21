/*
 * READING A THREAD ON THE DEVICE — and the silence this exists to prevent.
 *
 * On LinkedIn's mobile web the comments are frequently not in the document until something is
 * pressed: "Load more comments", "Zobacz więcej komentarzy", "Eerdere reacties". A reader that only
 * looks therefore reports a post with no replies, which is indistinguishable from a post that
 * genuinely has none. On a reply desk that is the worst possible failure — a silent zero means
 * nobody wrote, so nothing is ever drafted and nobody finds out for weeks. It is the same shape as
 * the chain that returned false in silence and the poster note that could not fail.
 *
 * So the reader presses first, bounded, and always reports whether it pressed and what it saw.
 *
 * The device is stubbed. That is the point: the reader lives on the CLUSTER because the phone's
 * routes are frozen in an APK with no eval, so every part of it can be tested without a phone
 * holding a live login — which is the only way DOM work like this is iterable at all.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const dt = require('../src/deviceThread');

const person = (name, slug) => ({ tag: 'a', text: name, href: `https://www.linkedin.com/in/${slug}/` });
const POST_URL = 'https://www.linkedin.com/feed/update/urn:li:activity:7231234567890123456/';

describe('the people come out of the links, and only the people', () => {
  it('the first profile link is the author and the rest are the thread', () => {
    const th = dt.threadFrom([person('Jan Kowalski', 'jan-kowalski'), person('Anna Nowak', 'anna-nowak')], 'body', POST_URL);
    expect(th.author).toEqual({ slug: 'jan-kowalski', name: 'Jan Kowalski' });
    expect(th.participants).toEqual([{ slug: 'anna-nowak', name: 'Anna Nowak' }]);
  });

  /* A company page is not somebody you reply to. */
  it('company and school pages are not people', () => {
    const th = dt.threadFrom([
      person('Jan', 'jan'),
      { tag: 'a', text: 'Acme', href: '/company/acme/' },
      { tag: 'a', text: 'Uni', href: '/school/uni/' },
    ], 'body', POST_URL);
    expect(th.participants).toEqual([]);
  });

  /* The author appears many times on their own post; they are one person. */
  it('and the same person is counted once, however often they are linked', () => {
    const th = dt.threadFrom([person('Jan', 'jan'), person('Jan', 'jan'), person('Anna', 'anna')], 'body', POST_URL);
    expect(th.participants).toEqual([{ slug: 'anna', name: 'Anna' }]);
  });

  it('a slug survives tracking parameters and case', () => {
    expect(dt.slugOf('/in/Jan-Kowalski?trk=public_post')).toBe('jan-kowalski');
    expect(dt.slugOf('https://www.linkedin.com/in/anna-nowak/')).toBe('anna-nowak');
    expect(dt.slugOf('/company/acme')).toBe('');
  });

  /* The urn is the post's real identity, so dedup is exact rather than a hash of its first words. */
  it('the urn is taken from the address, or from the page when the address lacks it', () => {
    expect(dt.threadFrom([], '', POST_URL).urn).toBe('urn:li:activity:7231234567890123456');
    expect(dt.threadFrom([], 'somewhere urn:li:ugcPost:99 here', 'https://x/y').urn).toBe('urn:li:ugcPost:99');
    expect(dt.threadFrom([], 'no identity', 'https://x/y').urn).toBe('');
  });
});

describe('the control that reveals comments is recognised in the languages it renders in', () => {
  it('finds it in Polish, Dutch, English and German', () => {
    for (const t of ['Zobacz więcej komentarzy (12)', 'Eerdere reacties', 'Load more comments', 'Weitere Kommentare']) {
      expect(dt.isExpander({ text: t }), t).toBe(true);
    }
  });

  it('reads an aria-label as well as visible text', () => {
    expect(dt.isExpander({ label: 'Show more comments' })).toBe(true);
  });

  /* Pressing the wrong thing on a live logged-in account is worse than pressing nothing. */
  it('and refuses anything that is not it', () => {
    for (const t of ['Lubię to', 'Reageren', 'Like', 'Share', 'Udostępnij', '']) {
      expect(dt.isExpander({ text: t }), t).toBe(false);
    }
  });
});

/* A fake phone: answers analyze from a script of rounds, and records every call. */
function fakeDevice(rounds, { failClickAt = -1 } = {}) {
  let round = 0;
  const calls = [];
  const run = async (deviceId, spec) => {
    calls.push(spec.path);
    if (spec.path === '/v1/navigate') return { result: { ok: true } };
    if (spec.path === '/v1/analyze') return { result: rounds[Math.min(round, rounds.length - 1)] };
    if (spec.path === '/v1/click') {
      if (calls.filter((c) => c === '/v1/click').length === failClickAt) throw new Error('tap went nowhere');
      round += 1;
      return { result: 'ok' };
    }
    if (spec.path === '/v1/content') return { result: { text: 'the post and its comments' } };
    return { result: {} };
  };
  return { run, calls };
}

describe('it presses before it reads, and says what it did', () => {
  const EXPAND = { tag: 'button', text: 'Load more comments' };

  it('presses until there is nothing left to press', async () => {
    const { run, calls } = fakeDevice([
      [person('Jan', 'jan'), EXPAND],
      [person('Jan', 'jan'), person('Anna', 'anna'), EXPAND],
      [person('Jan', 'jan'), person('Anna', 'anna'), person('Piotr', 'piotr')],
    ]);
    const th = await dt.readThread({ run, deviceId: 'd1', profile: 'p_linkedin', url: POST_URL, settleMs: 0, log: {} });
    expect(th.pressed).toBe(2);
    expect(th.participants.map((p) => p.slug)).toEqual(['anna', 'piotr']);
    expect(th.truncated).toBe(false);
    expect(th.nothingToExpand).toBe(false);
    expect(calls.filter((c) => c === '/v1/click')).toHaveLength(2);
  });

  /*
   * A feed that always offers more must not loop forever on a phone, and the caller has to be told
   * that what came back is not the whole thread.
   */
  it('stops at the bound and admits the thread is longer', async () => {
    const { run } = fakeDevice([[person('Jan', 'jan'), EXPAND]]);   // always offers more
    const th = await dt.readThread({ run, deviceId: 'd1', profile: 'p_linkedin', url: POST_URL, rounds: 2, settleMs: 0, log: {} });
    expect(th.pressed).toBe(2);
    expect(th.truncated).toBe(true);
  });

  /* The distinction that matters: nothing to expand is a fact, not a failure. */
  it('a post with no comments to reveal says exactly that', async () => {
    const { run, calls } = fakeDevice([[person('Jan', 'jan')]]);
    const th = await dt.readThread({ run, deviceId: 'd1', profile: 'p_linkedin', url: POST_URL, settleMs: 0, log: {} });
    expect(th.pressed).toBe(0);
    expect(th.nothingToExpand).toBe(true);
    expect(th.read).toBe(true);
    expect(calls).not.toContain('/v1/click');
  });

  /* A press that fails must not lose the read that was already possible. */
  it('a tap that goes nowhere still returns what was there', async () => {
    const { run } = fakeDevice([[person('Jan', 'jan'), EXPAND]], { failClickAt: 1 });
    const th = await dt.readThread({ run, deviceId: 'd1', profile: 'p_linkedin', url: POST_URL, settleMs: 0, log: {} });
    expect(th.read).toBe(true);
    expect(th.pressed).toBe(0);
    expect(th.author).toEqual({ slug: 'jan', name: 'Jan' });
  });

  it('and it refuses to run without the things it needs', async () => {
    await expect(dt.readThread({ deviceId: 'd', url: POST_URL })).rejects.toThrow(/runCommand/);
    await expect(dt.readThread({ run: async () => ({}), url: POST_URL })).rejects.toThrow(/deviceId/);
    await expect(dt.readThread({ run: async () => ({}), deviceId: 'd' })).rejects.toThrow(/url/);
  });
});

describe('the pass hands the thread on, not just the text', () => {
  const server = require('fs').readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

  it('a thread surface is read as a thread', () => {
    expect(server).toMatch(/A THREAD, NOT A PAGE/);
    expect(server).toMatch(/deviceThread\.readThread\(/);
    expect(server).toMatch(/linkedin\|facebook/);
  });

  /* The screen has to be able to say who was found without anybody opening a pod log. */
  it('and who it found is recorded on the pass', () => {
    const at = server.indexOf('pages: read.map(');
    const body = server.slice(at, at + 520);
    expect(body).toMatch(/author: x\.who/);
    expect(body).toMatch(/people: x\.people/);
    expect(body).toMatch(/truncated/);
    expect(body).toMatch(/nothingToExpand/);
  });
});
