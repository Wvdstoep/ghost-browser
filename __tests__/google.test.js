/**
 * Google, read as data rather than driven by hand.
 *
 * Doing research with look/click/read costs five or six calls per source: sixty links to guess
 * among, a click, ten thousand characters of which nine are menus and cookie notices, then back —
 * and the results are gone. All of that is the model operating a browser instead of thinking about
 * what the pages say.
 *
 * The two things pinned here are the ones that quietly ruin a research run: Google's consent wall,
 * which looks exactly like a search that found nothing, and its redirect wrapper, which stores a
 * Google address where a source should be.
 */
import { describe, it, expect, vi } from 'vitest';
import { looksLikeConsent, search, readPage, extractResults, resolveWrapped, landedElsewhere, url } from '../src/sites/google.js';

const pageThat = (results, { text = '', at = 'https://www.google.com/search?q=x', request } = {}) => ({
  goto: vi.fn(async () => {}),
  url: () => at,
  request,
  evaluate: vi.fn(async (fn) => (String(fn).includes('querySelectorAll(\'h3\')') || String(fn).includes('h3')
    ? results : text)),
});

/*
 * THE OPAQUE WRAPPER — the defect that emptied every research pass for weeks.
 *
 * Measured 2026-09-04 in the live browser: the results page was full, and google() reported
 * "0 result(s)" on every query. Signed-in Google links each result as /goto?url=<token>; the
 * destination is nowhere in the DOM (mousedown only re-wraps the token in /url?url=…), and Google
 * produces it as a 302 only when the wrapper is fetched with the search page as referer — a bare
 * fetch is a 400. The old extractor wanted an http address and dropped Google's own domain, so a
 * page of results read as an empty one, and the master's gate read "zero demand".
 */
describe('the opaque /goto wrapper', () => {
  const { JSDOM } = (() => { try { return require('jsdom'); } catch { return {}; } })();
  // The markup as it was served (class names generated; the <a><h3> shape and the /goto href are the contract).
  const RESULT = (token, title, source) =>
    `<div class="MjjYud"><div><a jsname="UWckNb" class="zReHs" href="/goto?url=${token}" data-jsarwt="1" data-usg="x" data-ved="y">`
    + `<h3 class="LC20lb">${title}</h3><div><span>${source}</span><div><cite>12 reacties · 3 maanden geleden</cite></div></div></a>`
    + `<div class="VwiC3b">People here keep asking which builder lets them self-host the result.</div></div></div>`;
  const withDom = (html, fn) => {
    if (!JSDOM) return null;   // jsdom absent — the resolver tests below still guard the fix
    const dom = new JSDOM(html, { url: 'https://www.google.com/search?q=x' });
    const g = dom.window;
    // jsdom has no layout engine, so innerText is undefined — emulate a browser's: block elements break lines.
    const BLOCK = /^(DIV|P|H[1-6]|LI|UL|OL|SECTION|ARTICLE|TR|BR)$/;
    Object.defineProperty(g.HTMLElement.prototype, 'innerText', { configurable: true, get() {
      const walk = (n) => n.nodeType === 3 ? n.textContent
        : [...n.childNodes].map(walk).join('').replace(/^|$/g, BLOCK.test(n.tagName) ? '\n' : '');
      return walk(this).replace(/\n{2,}/g, '\n').trim();
    } });
    const prev = { document: global.document, location: global.location };
    global.document = g.document; global.location = g.location;
    try { return fn(); } finally { global.document = prev.document; global.location = prev.location; }
  };

  it('keeps a /goto result as `via` (with its source line) instead of dropping it as Google furniture', () => {
    const got = withDom(RESULT('CAESabc', "What's the best AI no-code web app builder?", 'Reddit · r/nocode')
                        + RESULT('CAESdef', 'I tested 5 AI app builders', 'Reddit · r/SideProject'), extractResults);
    if (!got) return;
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ title: "What's the best AI no-code web app builder?", url: '',
                                   via: 'https://www.google.com/goto?url=CAESabc', source: 'Reddit · r/nocode' });
    expect(got[0].snippet).toMatch(/self-host/);
  });

  it('unwraps the mousedown form /url?url=%2Fgoto… to the same wrapper, and still reads the old /url?q=REAL', () => {
    const got = withDom(
      `<a href="http://www.google.com/url?sa=t&amp;url=%2Fgoto%3Furl%3DCAESxyz"><h3>Wrapped twice</h3></a>`
      + `<a href="/url?q=https://example.nl/pricing&amp;sa=U"><h3>Old wrapper</h3></a>`
      + `<a href="https://www.google.com/search?q=more"><h3>More results</h3></a>`, extractResults);
    if (!got) return;
    expect(got.map((r) => r.via || r.url)).toEqual(['https://www.google.com/goto?url=CAESxyz', 'https://example.nl/pricing']);
  });

  const answer = (status, location) => ({ status: () => status, headers: () => (location ? { location } : {}) });

  it('resolves each wrapper through the context request client — search referer, redirects off — and hands back the real address', async () => {
    const get = vi.fn(async (u) => answer(302, u.endsWith('A') ? 'https://www.reddit.com/r/nocode/comments/1mbctla/whats_the_best/' : 'https://www.reddit.com/r/SideProject/comments/1rvddm1/tested/'));
    const results = [{ title: 'a', url: '', via: 'https://www.google.com/goto?url=A', source: 'Reddit · r/nocode', snippet: '' },
                     { title: 'b', url: '', via: 'https://www.google.com/goto?url=B', source: '', snippet: '' },
                     { title: 'c', url: 'https://example.nl/', source: '', snippet: '' }];
    const n = await resolveWrapped({ request: { get } }, results, 'https://www.google.com/search?q=x');
    expect(n).toBe(2);
    expect(results[0].url).toBe('https://www.reddit.com/r/nocode/comments/1mbctla/whats_the_best/');
    expect(results[1].url).toMatch(/SideProject/);
    expect(results.every((r) => !('via' in r))).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);   // the plain result costs nothing
    expect(get.mock.calls[0][1]).toMatchObject({ maxRedirects: 0, headers: { referer: 'https://www.google.com/search?q=x' } });
  });

  it('a wrapper that will not resolve keeps the wrapper as its address and says why — never silently vanishes', async () => {
    const get = vi.fn(async () => answer(400));
    const results = [{ title: 'a', url: '', via: 'https://www.google.com/goto?url=A', source: '', snippet: '' }];
    await resolveWrapped({ request: { get } }, results, 'https://www.google.com/');
    expect(results[0].url).toBe('https://www.google.com/goto?url=A');
    expect(results[0].unresolved).toMatch(/HTTP 400/);
  });

  it('search() resolves wrappers in place, so the agent sees real addresses and the count is right', async () => {
    const get = vi.fn(async () => answer(302, 'https://www.reddit.com/r/nocode/comments/1mbctla/x/'));
    const page = pageThat([{ title: 'a', url: '', via: 'https://www.google.com/goto?url=A', source: 'Reddit · r/nocode', snippet: 's' },
                           { title: 'a again', url: '', via: 'https://www.google.com/goto?url=B', source: '', snippet: 's' }],
                          { request: { get } });
    const r = await search(page, 'site:reddit.com builder', { settle: 0 });
    expect(r.results).toHaveLength(1);   // two wrappers, one page
    expect(r.results[0].url).toBe('https://www.reddit.com/r/nocode/comments/1mbctla/x/');
    expect(r.error).toBeUndefined();
  });
});

/*
 * AN ADDRESS TYPED FROM MEMORY IS NOT A SOURCE. With google() dead, the same pass "remembered"
 * thread addresses and dug them; Reddit redirected each invented id to whatever post owns it, and
 * four unrelated threads were quoted as evidence. Reddit rewrites a thread's slug to its real title,
 * so a link that was actually seen keeps its slug and a composed one does not.
 */
describe('a dig that lands somewhere else than it asked', () => {
  it('reddit: a different post id, or a slug rewritten to another title, is refused as not-a-real-link', () => {
    expect(landedElsewhere('https://www.reddit.com/r/nocode/comments/1abc123/best_ai_app_builder_self_hosted/',
                           'https://www.reddit.com/r/nocode/comments/1abc123/my_cat_learned_to_open_doors/')).toMatch(/not a real link/);
    expect(landedElsewhere('https://old.reddit.com/r/nocode/comments/1abc123/best_ai_app_builder/',
                           'https://www.reddit.com/r/SideProject/comments/1zzz999/best_ai_app_builder/')).toMatch(/DIFFERENT thread/);
  });

  it('reddit: the ordinary redirects a real link goes through are fine', () => {
    // old → www, trailing-slash, a slug Reddit merely extended, or a query string
    expect(landedElsewhere('https://old.reddit.com/r/nocode/comments/1abc123/best_ai_app_builder/',
                           'https://www.reddit.com/r/nocode/comments/1abc123/best_ai_app_builder_for_startups/?rdt=1')).toBe('');
    expect(landedElsewhere('https://www.reddit.com/r/nocode/comments/1abc123/',
                           'https://www.reddit.com/r/nocode/comments/1abc123/best_ai_app_builder/')).toBe('');
    expect(landedElsewhere('https://example.nl/pricing', 'https://example.nl/pricing/', 'Pricing')).toBe('');
  });

  it('a "page not found" title is refused; an article about 404 pages is not', () => {
    expect(landedElsewhere('https://x.nl/a', 'https://x.nl/a', 'Page not found')).toMatch(/does not exist/);
    expect(landedElsewhere('https://x.nl/a', 'https://x.nl/a', '404 Not Found')).toMatch(/does not exist/);
    expect(landedElsewhere('https://x.nl/a', 'https://x.nl/a', 'How we redesigned our 404 page and cut bounce rate by 30% — a long engineering write-up about not found pages and what error copy should say')).toBe('');
  });

  it('readPage() refuses to read the wrong thread and names the composed address in the error', async () => {
    const page = {
      goto: vi.fn(async () => {}),
      url: () => 'https://www.reddit.com/r/nocode/comments/1abc123/completely_other_thread/',
      title: async () => 'Completely other thread : r/nocode',
      evaluate: vi.fn(async () => ({ title: 'x', description: '', text: 'not this', emails: [], phones: [], length: 8 })),
    };
    const r = await readPage(page, 'https://www.reddit.com/r/nocode/comments/1abc123/best_ai_app_builder_self_hosted/', { settle: 0 });
    expect(r.elsewhere).toBe(true);
    expect(r.error).toMatch(/not a real link/);
    expect(page.evaluate).not.toHaveBeenCalled();   // the unrelated page is never read as evidence
  });
});

describe('the consent wall', () => {
  /*
   * In Europe the first request is a full-page "before you continue" and no results at all. It is
   * indistinguishable from a search that found nothing unless somebody says so — and a person can
   * clear it in one click, but only if they know that is what they are looking at.
   */
  it('is recognised by its address', () => {
    expect(looksLikeConsent('', 'https://consent.google.com/m?continue=')).toBe(true);
  });

  it('is recognised by what it says', () => {
    expect(looksLikeConsent('Voordat je verdergaat naar Google\nAlles accepteren', 'https://www.google.com/')).toBe(true);
    expect(looksLikeConsent('Before you continue to Google — Accept all', 'https://www.google.com/')).toBe(true);
  });

  it('is not confused with a page that merely mentions accepting something', () => {
    expect(looksLikeConsent('x'.repeat(6000) + ' accept all cookies', 'https://example.com')).toBe(false);
  });

  it('is reported as itself, with what to do about it', async () => {
    const page = pageThat([], { text: 'Voordat je verdergaat naar Google — alles accepteren',
                                at: 'https://consent.google.com/m' });
    const r = await search(page, 'anything', { settle: 0 });
    expect(r.consent).toBe(true);
    expect(r.error).toMatch(/Accept it once in the live view/);
  });
});

describe('searching', () => {
  const hit = (n) => ({ title: `Result ${n}`, url: `https://example${n}.nl/`, snippet: `about thing ${n}` });

  it('hands back the results as data', async () => {
    const page = pageThat([hit(1), hit(2)]);
    const r = await search(page, 'autobedrijf alkmaar', { settle: 0 });
    expect(r.results).toHaveLength(2);
    expect(page.goto.mock.calls[0][0]).toContain('q=autobedrijf%20alkmaar');
  });

  it('can ask for recent results only, using Google’s own parameter', async () => {
    const page = pageThat([hit(1)]);
    await search(page, 'x', { recentDays: 7, settle: 0 });
    expect(page.goto.mock.calls[0][0]).toContain('tbs=qdr:w');
  });

  /* An exception reads exactly like a search that found nothing, and that lie is expensive. */
  it('says it could not read the page rather than returning nothing', async () => {
    const page = { goto: async () => {}, url: () => 'https://www.google.com/',
                   evaluate: async () => { throw new Error('detached'); } };
    const r = await search(page, 'x', { settle: 0 });
    expect(r.error).toMatch(/could not read the results/);
  });

  it('escapes what people actually type', () => {
    expect(url.search('garage "geen website" -marktplaats'))
      .toContain('q=garage%20%22geen%20website%22%20-marktplaats');
  });
});

describe('following a result', () => {
  it('reads the page and hands back what it says', async () => {
    const page = {
      goto: vi.fn(async () => {}),
      url: () => 'https://example.nl/contact',
      evaluate: async () => ({ title: 'Contact', description: '', text: 'Bel ons op 072 123 4567',
                               emails: ['info@example.nl'], phones: ['072 123 4567'], length: 24 }),
    };
    const r = await readPage(page, 'https://example.nl/contact', { settle: 0 });
    expect(r).toMatchObject({ title: 'Contact', emails: ['info@example.nl'] });
    expect(page.goto).toHaveBeenCalledWith('https://example.nl/contact', expect.anything());
  });

  it('reports a page it could not read instead of pretending it was empty', async () => {
    const page = { goto: async () => {}, url: () => 'x', evaluate: async () => { throw new Error('nope'); } };
    const r = await readPage(page, 'https://example.nl', { settle: 0 });
    expect(r.error).toMatch(/could not read that page/);
  });
});
