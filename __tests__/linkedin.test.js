/**
 * LinkedIn, read as data — the same contract as Facebook, with one real advantage and one real
 * difficulty.
 *
 * THE ADVANTAGE: every post carries urn:li:activity:<id>, so the permalink is CONSTRUCTED rather
 * than scraped. A post here can never come back without a link, which is exactly the failure that
 * produced twelve unusable Facebook leads in one run.
 *
 * THE DIFFICULTY: there is no machine-readable date anywhere, only "2d" or "3mo", so the age always
 * comes from parsing that.
 */
import { describe, it, expect } from 'vitest';
import { ageInDays, readFeed, url } from '../src/sites/linkedin.js';

const NOW = Date.parse('2026-08-25T12:00:00Z');

describe('how old is this post', () => {
  it.each([
    ['30m', 0], ['5h', 5 / 24], ['2u', 2 / 24],
    ['3d', 3], ['2w', 14], ['3mo', 90], ['2mnd', 60], ['1y', 365], ['2jr', 730],
  ])('reads %s', (postedText, expected) => {
    expect(ageInDays({ postedText }, NOW)).toBeCloseTo(expected, 1);
  });

  /* An unknown age must not be guessed: wrongly fresh gets answered years late, wrongly old is
     silently discarded. */
  it('says it does not know rather than guessing', () => {
    expect(ageInDays({})).toBeNull();
    expect(ageInDays({ postedText: 'Promoted' })).toBeNull();
    expect(ageInDays({ postedText: '3 days ago maybe' })).toBeNull();
  });
});

describe('reading a LinkedIn feed', () => {
  const feedOf = (batches) => {
    let i = 0;
    return {
      evaluate: async () => batches[Math.min(i, batches.length - 1)],
      mouse: { wheel: async () => { i++; } },
    };
  };
  /* Built as a STRING. A real activity id is nineteen digits, past Number.MAX_SAFE_INTEGER, so
     doing arithmetic on one gives every post the same id — which the dedup then correctly collapsed
     into a single post, and the failure looked like a bug in the reader rather than in the test. */
  const post = (n, over = {}) => ({
    id: `700000000000000000${n}`, author: `Persoon ${n}`, headline: 'Directeur',
    url: `https://www.linkedin.com/feed/update/urn:li:activity:700000000000000000${n}/`,
    text: `wij zoeken iemand die ons platform kan herbouwen (${n})`, postedText: '3d',
    reshared: false, ...over,
  });

  it('scrolls until nothing new loads, like the other one', async () => {
    const page = feedOf([[post(1)], [post(1), post(2)], [post(1), post(2)]]);
    const r = await readFeed(page, { settle: 0, now: () => NOW });
    expect(r.posts.map((p) => p.author)).toEqual(['Persoon 1', 'Persoon 2']);
    expect(r.stopped).toBe('nothing new was loading');
  });

  /* THE ADVANTAGE, pinned: the link is derived from the id, so it is always there. */
  it('always has a link, because the id is the address', async () => {
    const r = await readFeed(feedOf([[post(1)]]), { settle: 0, now: () => NOW });
    expect(r.posts[0].url).toMatch(/urn:li:activity:7000000000000000001/);
  });

  it('drops what is past the cut-off and counts it', async () => {
    const r = await readFeed(feedOf([[post(1), post(2, { postedText: '2y' })]]), { settle: 0, now: () => NOW });
    expect(r.posts).toHaveLength(1);
    expect(r.tooOld).toBe(1);
  });

  it('keeps a post whose age it could not read', async () => {
    const r = await readFeed(feedOf([[post(1, { postedText: 'Promoted' })]]), { settle: 0, now: () => NOW });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0].ageDays).toBeNull();
  });

  /* Exact rather than a hash of the first eighty characters — two posts saying the same thing are
     two posts. */
  it('deduplicates on the real id', async () => {
    const seen = new Set();
    await readFeed(feedOf([[post(1)]]), { settle: 0, seen, now: () => NOW });
    const r = await readFeed(feedOf([[post(1), post(2)]]), { settle: 0, seen, now: () => NOW });
    expect(r.posts.map((p) => p.author)).toEqual(['Persoon 2']);
  });

  it('says it could not read the page rather than returning nothing', async () => {
    const page = { evaluate: async () => { throw new Error('detached'); }, mouse: { wheel: async () => {} } };
    expect((await readFeed(page, { settle: 0 })).error).toMatch(/could not read this page/);
  });
});

describe('the addresses', () => {
  /* LinkedIn will happily lead with a popular post from two years ago, so recency is asked for. */
  it('asks content search for the recent ones first', () => {
    const u = url.searchPosts('platform herbouwen');
    expect(u).toContain('keywords=platform%20herbouwen');
    expect(u).toContain('sortBy');
  });

  it('builds a post address from an id', () => {
    expect(url.post('123')).toBe('https://www.linkedin.com/feed/update/urn:li:activity:123/');
  });
});

/*
 * THE TEST THAT WAS MISSING, AND WHY THE BUG SHIPPED.
 *
 * extractPosts() is the one function that touches the real page, and it was the one function no
 * test ran — every test above stubs page.evaluate to hand back a canned array. So the day LinkedIn's
 * search results stopped carrying data-urn on the wrapper, nothing failed here; it failed on a live
 * run, as twenty hand-read search pages and zero leads.
 *
 * These run extractPosts against a real DOM (jsdom) shaped like the pages it actually meets. The
 * feed and the search page mark posts up DIFFERENTLY, and it has to read both.
 */
import { describe as describeDom, it as itDom, expect as expectDom, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractPosts } from '../src/sites/linkedin.js';

function runExtract(html) {
  const dom = new JSDOM(html);
  const g = global;
  const prevDoc = g.document, prevWin = g.window;
  g.document = dom.window.document; g.window = dom.window;
  try { return extractPosts(); }
  finally { g.document = prevDoc; g.window = prevWin; }
}

describeDom('reading posts off the actual page', () => {
  itDom('reads a classic feed card (urn on the wrapper)', () => {
    const posts = runExtract(`<body><main>
      <div data-urn="urn:li:activity:7111111111111111111">
        <a href="/in/janedev"><span class="update-components-actor__title" aria-label="Jane Developer">Jane Developer</span></a>
        <span class="update-components-actor__sub-description">Founder at Acme · 2d</span>
        <div>We are looking for a developer to build our booking platform, anyone available?</div>
      </div></main></body>`);
    expectDom(posts).toHaveLength(1);
    expectDom(posts[0].id).toBe('7111111111111111111');
    expectDom(posts[0].url).toContain('urn:li:activity:7111111111111111111');
    expectDom(posts[0].author).toBe('Jane Developer');
  });

  /*
   * THE ONE THAT WAS FAILING LIVE. Search results put the urn on an inner link's href and give the
   * wrapper a generated attribute name, so the old [data-urn] selector matched nothing. This is the
   * exact shape the agent read twenty of and found empty.
   */
  itDom('reads a search result (urn only in a link href, wrapper renamed)', () => {
    const posts = runExtract(`<body><main>
      <div class="reusable-search__result-container" data-chameleon-result-urn="urn:li:activity:7222222222222222222">
        <a href="/in/bobbuilds">Bob Builds</a>
        <span>Owner, Garage Bob · 5d</span>
        <span>Onze software werkt niet meer, zoeken iemand die een nieuwe kan bouwen voor de garage.</span>
        <a href="/feed/update/urn:li:activity:7222222222222222222/">Open</a>
      </div></main></body>`);
    expectDom(posts).toHaveLength(1);
    expectDom(posts[0].id).toBe('7222222222222222222');
  });

  itDom('still finds it when the urn survives ONLY in a link href', () => {
    const posts = runExtract(`<body><main>
      <article class="something-generated-xyz">
        <a href="/in/carol">Carol</a>
        <p>Looking for recommendations for a developer to build our web application.</p>
        <a href="https://www.linkedin.com/feed/update/urn:li:activity:7333333333333333333/">view</a>
      </article></main></body>`);
    expectDom(posts).toHaveLength(1);
    expectDom(posts[0].id).toBe('7333333333333333333');
    expectDom(posts[0].url).toContain('7333333333333333333');
  });

  itDom('does not invent posts on a page that has none', () => {
    const posts = runExtract(`<body><main><div>No results found for your search.</div></main></body>`);
    expectDom(posts).toHaveLength(0);
    // ...and the diagnostic says the page WAS read, so a caller can tell empty from broken.
    expectDom(posts.diag).toBeTruthy();
  });

  itDom('does not count the same post twice when the id appears on several nodes', () => {
    const posts = runExtract(`<body><main>
      <div data-urn="urn:li:activity:7444444444444444444">
        <a href="/in/dan" data-id="urn:li:activity:7444444444444444444">Dan</a>
        <div>Need custom software built, who can help with a booking system for our garage?</div>
        <a href="/feed/update/urn:li:activity:7444444444444444444/">open</a>
      </div></main></body>`);
    expectDom(posts).toHaveLength(1);
  });
});
