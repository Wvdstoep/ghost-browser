/**
 * Reading Facebook properly, in code, once.
 *
 * Evaluating one post used to cost five tool calls and about fifteen thousand tokens — look at
 * sixty clickable things, click, read ten thousand characters, scroll, read again. A real run spent
 * forty-two calls that way and recorded nothing: everything went on OPERATING Facebook and there
 * was nothing left for judging whether a person needs what you sell.
 *
 * The two things worth pinning here are the ones a model should never be asked to do: work out how
 * old a post is from whatever the page happened to write, and decide when a feed has stopped
 * loading. Both are loops or parsing, and both are cheap in code and expensive in tokens.
 */
import { describe, it, expect, vi } from 'vitest';
import { ageInDays, readFeed, url } from '../src/sites/facebook.js';

const NOW = Date.parse('2026-08-25T12:00:00Z');

describe('how old is this post', () => {
  it('prefers the machine-readable date when the page gives one', () => {
    expect(ageInDays({ postedIso: '2026-08-18T12:00:00Z' }, NOW)).toBeCloseTo(7, 1);
  });

  /* Facebook writes relative times in the language of the page, and this account sees Dutch. */
  it.each([
    ['4 u', 4 / 24], ['4 uur', 4 / 24], ['2 h', 2 / 24],
    ['3 d', 3], ['3 dagen', 3], ['2 w', 14], ['2 weken', 14],
    ['12 min', 0], ['gisteren', 1], ['vandaag', 0], ['zojuist', 0],
  ])('reads %s', (text, expected) => {
    expect(ageInDays({ postedText: text }, NOW)).toBeCloseTo(expected, 1);
  });

  it('reads an absolute date, which is what it writes once a post is old', () => {
    expect(ageInDays({ postedText: '9 september 2021' }, NOW)).toBeGreaterThan(1700);
  });

  /* Facebook omits the year only when it is the current one — so a date that would be in the
     future is last year's, not next year's. */
  it('reads a bare day and month as the most recent one that has happened', () => {
    const age = ageInDays({ postedText: '9 september' }, NOW);   // NOW is 25 August
    expect(age).toBeGreaterThan(340);
    expect(age).toBeLessThan(370);
  });

  /*
   * The most important one. An unknown date must not be guessed: a post wrongly called fresh gets
   * answered four years late, and one wrongly called old is silently thrown away.
   */
  it('says it does not know rather than guessing', () => {
    expect(ageInDays({})).toBeNull();
    expect(ageInDays({ postedText: 'Bijgewerkt' })).toBeNull();
  });
});

describe('reading a feed until there is nothing new', () => {
  /* A page that hands out a fresh batch on each scroll, then starts repeating itself. */
  const feedOf = (batches) => {
    let i = 0;
    return {
      evaluate: vi.fn(async () => batches[Math.min(i, batches.length - 1)]),
      mouse: { wheel: vi.fn(async () => { i++; }) },
    };
  };
  const post = (n, over = {}) => ({ author: `P${n}`, text: `post number ${n} about a leaking roof`,
                                    url: `https://fb/p/${n}`, postedText: '2 d', ...over });

  it('scrolls while posts keep appearing and stops when they stop', async () => {
    const page = feedOf([[post(1)], [post(1), post(2)], [post(1), post(2), post(3)],
                         [post(1), post(2), post(3)]]);
    const r = await readFeed(page, { settle: 0, now: () => NOW });
    expect(r.posts.map((p) => p.author)).toEqual(['P1', 'P2', 'P3']);
    expect(r.stopped).toBe('nothing new was loading');
    // It did not keep scrolling into nothing.
    expect(page.mouse.wheel.mock.calls.length).toBeLessThan(8);
  });

  /* Facebook sometimes returns one slow batch, so a single empty round is not the end. */
  it('does not give up on one empty round', async () => {
    let i = 0;
    const page = {
      evaluate: async () => (i === 1 ? [post(1)] : i >= 2 ? [post(1), post(2)] : [post(1)]),
      mouse: { wheel: async () => { i++; } },
    };
    const r = await readFeed(page, { settle: 0, now: () => NOW });
    expect(r.posts).toHaveLength(2);
  });

  it('drops posts past the cut-off and says how many', async () => {
    const page = feedOf([[post(1), post(2, { postedText: '9 september 2021' })]]);
    const r = await readFeed(page, { settle: 0, now: () => NOW });
    expect(r.posts.map((p) => p.author)).toEqual(['P1']);
    // Counted, not silent: "nothing here" and "everything here was old" mean different things.
    expect(r.tooOld).toBe(1);
  });

  /* An unknown date is not old. Treating it as old would silently discard every post whose date
     could not be parsed, which is the failure nobody would ever notice. */
  it('keeps a post whose date it could not read', async () => {
    const page = feedOf([[post(1, { postedText: '', postedIso: null })]]);
    const r = await readFeed(page, { settle: 0, now: () => NOW });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0].ageDays).toBeNull();
  });

  /* Carried between calls, so checking back on a group is cheap instead of a full re-read. */
  it('returns only what is new since the last sweep', async () => {
    const seen = new Set();
    const page1 = feedOf([[post(1), post(2)]]);
    await readFeed(page1, { settle: 0, seen, now: () => NOW });
    const page2 = feedOf([[post(1), post(2), post(3)]]);
    const r = await readFeed(page2, { settle: 0, seen, now: () => NOW });
    expect(r.posts.map((p) => p.author)).toEqual(['P3']);
    expect(r.skippedSeen).toBeGreaterThan(0);
  });

  it('never scrolls forever', async () => {
    let n = 100;
    const page = { evaluate: async () => [post(n++)], mouse: { wheel: async () => {} } };
    const r = await readFeed(page, { settle: 0, maxScrolls: 5, now: () => NOW });
    expect(r.scrolls).toBeLessThanOrEqual(6);
  });

  /* An exception in the page reads exactly like a quiet day on Facebook. It must not. */
  it('says the page could not be read rather than returning nothing', async () => {
    const page = { evaluate: async () => { throw new Error('detached frame'); }, mouse: { wheel: async () => {} } };
    const r = await readFeed(page, { settle: 0 });
    expect(r.error).toMatch(/could not read this page/);
  });
});

describe('the addresses', () => {
  it('escapes what people actually search for', () => {
    expect(url.searchPosts('wie kent een goede dakdekker?'))
      .toBe('https://www.facebook.com/search/posts?q=wie%20kent%20een%20goede%20dakdekker%3F');
  });

  it('builds a search inside one group', () => {
    expect(url.groupSearch('123', 'developer gezocht'))
      .toBe('https://www.facebook.com/groups/123/search/?q=developer%20gezocht');
  });
});
