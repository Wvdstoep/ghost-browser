/**
 * sites/google.js — search results as data, and pages read for their content rather than their furniture.
 *
 * WHY THIS IS NOT JUST open() AND read().
 *
 * Doing research by hand costs: open the search, look at sixty links, guess which are results and
 * which are navigation, click one, read ten thousand characters of which nine thousand are menus
 * and cookie notices, go back, lose the results. Five or six calls per source, and the model spends
 * its thinking on operating a browser instead of on what the pages actually say.
 *
 * Here the results come back as a list — title, address, and Google's own snippet — and a page
 * comes back as its readable content with the navigation stripped. Following four sources costs
 * five calls total, and the words that arrive are worth reading.
 *
 * TWO THINGS GOOGLE DOES THAT WILL WASTE A RUN IF NOBODY EXPECTS THEM:
 *
 *   THE CONSENT WALL. In Europe the first request is a full-page "before you continue" and no
 *   results at all. It looks exactly like a search that found nothing, which is the worst way for
 *   anything to fail. It is detected and reported as itself.
 *
 *   THE REDIRECT WRAPPER. Result links are sometimes /url?q=REAL&sa=… rather than the destination,
 *   and handing that to anything downstream stores a Google address instead of the source.
 *
 *   THE OPAQUE WRAPPER (2026). Signed-in results now link to /goto?url=<token> — the destination is
 *   not in the page at all, Google only produces it server-side as a 302 when the link is followed
 *   WITH the search page as referer (a bare fetch is a 400). Measured: every research pass made 4-15
 *   searches and each returned "0 result(s)" because the extractor required an http address and
 *   dropped Google's own domain — so a page full of results read as an empty one, for weeks. Now the
 *   wrapper is kept as `via` and resolved out of band, one HEAD-sized request per result, no tab.
 */

const GOOGLE_HOST = /^https?:\/\/([a-z0-9-]+\.)*google\.[a-z.]+\//i;

/* Injected into the page. Must never throw: an exception here is indistinguishable from "no
   results", and that lie is expensive. */
function extractResults() {
  const out = [];
  const seen = new Set();

  const isGoogle = (h) => /^https?:\/\/([a-z0-9-]+\.)*google\.[a-z.]+\//i.test(h);

  /*
   * What a result link points at: { url } when the destination is in the page, { via } when it is
   * behind Google's opaque /goto wrapper and has to be resolved by following it (search() does
   * that). A Google address that is neither is Google's own furniture — not a source.
   */
  const unwrap = (href) => {
    try {
      const u = new URL(href, location.origin);
      // The old wrapper: /url?q=REAL or /url?url=REAL. Since 2026 the inner address can itself be
      // the opaque /goto hop (the page rewrites hrefs to that on mousedown) — unwrap it once more.
      if (/^\/url$/.test(u.pathname)) {
        const real = u.searchParams.get('q') || u.searchParams.get('url');
        if (real) return unwrap(real);
      }
      if (/^\/goto$/.test(u.pathname) && u.searchParams.get('url')) return { via: u.href };
      if (!/^https?:$/.test(u.protocol) || isGoogle(u.href)) return null;
      return { url: u.href };
    } catch { return null; }
  };

  /*
   * A result is an <a> wrapping an <h3>. That has been the shape of a Google result far longer than
   * any class name, and class names here are generated — anything built on them breaks silently,
   * which is the failure nobody notices until a week of empty runs.
   */
  for (const h3 of document.querySelectorAll('h3')) {
    try {
      const a = h3.closest('a[href]');
      if (!a) continue;
      const link = unwrap(a.getAttribute('href') || '');
      if (!link) continue;
      const key = link.url || link.via;
      if (seen.has(key)) continue;
      seen.add(key);

      const title = (h3.innerText || '').trim();
      if (!title) continue;

      /* The source line Google prints under the title ("Reddit · r/nocode", "G2 · Reviews"): with an
         opaque link it is the only thing in the page that says WHERE a result lives, and it lets a
         reader pick the right thread before spending a page visit on it. */
      const source = ((a.innerText || '').split('\n').map((s) => s.trim()).find((s) => s && s !== title) || '').slice(0, 100);

      /*
       * The snippet: the block of text under the result. Walking up to a container and taking what
       * is not the title is more durable than naming a class, and a wrong snippet costs nothing
       * while a missing one costs a page visit to find out what the result was about.
       */
      let snippet = '';
      let box = a.parentElement;
      for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
        const t = (box.innerText || '').replace(title, '').trim();
        if (t.length > snippet.length) snippet = t;
        if (snippet.length > 120) break;
      }

      out.push({ title, url: link.url || '', ...(link.via ? { via: link.via } : {}), source,
                 snippet: snippet.replace(/\s+/g, ' ').slice(0, 320) });
    } catch { /* one odd result must not cost the rest */ }
  }
  return out;
}

/**
 * Turn each opaque /goto wrapper into the address it stands for.
 *
 * Google answers the wrapper with a 302 to the real page — but only when the request carries the
 * search page as referer and the session's cookies; the context's own request client has both, and
 * with redirects off the Location header IS the answer. No tab, no page load on the destination:
 * ten results resolve in well under a second. Anything that will not resolve keeps the wrapper as
 * its address (a page.goto on it with a Google referer does land on the source) and says so.
 */
async function resolveWrapped(page, results, referer) {
  const pending = results.filter((r) => !r.url && r.via);
  if (!pending.length) return 0;
  const req = page.request || (typeof page.context === 'function' && page.context().request) || null;
  let resolved = 0;
  await Promise.all(pending.map(async (r) => {
    try {
      if (!req) throw new Error('no request client on this page');
      const res = await req.get(r.via, { maxRedirects: 0, timeout: 8000, headers: { referer } });
      const status = res.status();
      const loc = (res.headers() || {}).location || '';
      if (status >= 300 && status < 400 && /^https?:/i.test(loc) && !GOOGLE_HOST.test(loc)) { r.url = loc; resolved++; }
      else throw new Error(`HTTP ${status} with no destination`);
    } catch (e) {
      r.url = r.via;
      r.unresolved = String(e && e.message || e).split('\n')[0].slice(0, 120);
    }
  }));
  for (const r of results) delete r.via;
  return resolved;
}

/** Is this the consent wall rather than a page of results? */
function looksLikeConsent(text, url) {
  const t = String(text || '').toLowerCase();
  return /consent\.google\./i.test(String(url || ''))
    || (/(voordat je verdergaat|before you continue|accept all|alles accepteren)/.test(t) && t.length < 4000);
}

/**
 * A page, read for what it says.
 *
 * Prefers the element that means "the content" — main, article, the schema role — and falls back to
 * the body with the furniture removed. Nine tenths of a scraped page is navigation, cookie banners
 * and footers, and every character of it is paid for twice: once in tokens and once in the model's
 * attention.
 */
function extractReadable() {
  const strip = ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'form',
                 '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]'];
  const pick = document.querySelector('main, article, [role="main"], #content, .content') || document.body;
  const clone = pick.cloneNode(true);
  for (const sel of strip) {
    for (const el of clone.querySelectorAll(sel)) el.remove();
  }
  const text = (clone.innerText || '').replace(/\n{3,}/g, '\n\n').trim();

  // Whatever the page says about itself — often the fastest way to know it is the wrong page.
  const meta = (n) => {
    const el = document.querySelector(`meta[name="${n}"], meta[property="og:${n}"]`);
    return el ? (el.getAttribute('content') || '').trim().slice(0, 300) : '';
  };

  /* Contact details, which is what most research is actually looking for and which are tedious to
     find by eye in a wall of text. */
  const emails = [...new Set((document.body.innerHTML.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g) || [])
    .filter((e) => !/\.(png|jpe?g|gif|svg|webp)$/i.test(e)))].slice(0, 8);
  const phones = [...new Set((text.match(/(\+\d{1,3}[\s-]?)?(\(?\d{2,4}\)?[\s-]?){2,4}\d{2,4}/g) || [])
    .map((p) => p.trim()).filter((p) => p.replace(/\D/g, '').length >= 9))].slice(0, 6);

  return {
    title: (document.title || '').trim().slice(0, 200),
    description: meta('description'),
    text: text.slice(0, 6000),
    emails, phones,
    length: text.length,
  };
}

const url = {
  search: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=nl`,
  // A window on the results, for research where age matters. Google's own parameter, not a guess.
  searchRecent: (q, days = 365) =>
    `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=nl&tbs=qdr:${days <= 7 ? 'w' : days <= 31 ? 'm' : days <= 365 ? 'y' : 'y'}`,
};

/** Search, and hand back the results as data. */
async function search(page, query, { recentDays = null, settle = 1200 } = {}) {
  const where = recentDays ? url.searchRecent(query, recentDays) : url.search(query);
  await page.goto(where, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await new Promise((r) => setTimeout(r, settle));

  let results = [];
  try { results = await page.evaluate(extractResults); }
  catch (e) { return { query, results: [], error: `could not read the results: ${e.message}` }; }

  if (results.length) {
    let here = where;
    try { here = page.url() || where; } catch { /* keep the search address */ }
    await resolveWrapped(page, results, here);
    // Two wrappers can stand for the same page; keep the first.
    const seen = new Set();
    results = results.filter((r) => !seen.has(r.url) && seen.add(r.url));
  }

  if (!results.length) {
    /*
     * A SEARCH THAT FAILED MUST NEVER LOOK LIKE A SEARCH THAT FOUND NOTHING.
     *
     * Measured: a research run made fifteen searches, every one returned "0 result(s)" with no
     * error, and the market gate rejected the candidate because "the research produced zero leads".
     * The market was never tested — the SEARCH was broken, and nothing said so. An empty result set
     * with no explanation is the most expensive kind of silence: it reads as evidence.
     *
     * So an empty page is always explained, from what it actually shows.
     */
    let text = '', here = '';
    try { text = await page.evaluate(() => document.body.innerText); here = page.url(); } catch { /* gone */ }
    if (looksLikeConsent(text, here)) {
      /* Named, because it looks exactly like a search that found nothing and a person can clear it
         in one click — but only if they are told that is what they are looking at. */
      return { query, results: [], consent: true,
               error: 'Google is showing its consent page instead of results. Accept it once in the live view and this will work from then on.' };
    }
    const low = String(text || '').toLowerCase();
    if (/unusual traffic|not a robot|are you a robot|captcha|verify you.?re human/i.test(low)) {
      return { query, results: [], blocked: true,
               error: 'Google is challenging this browser (unusual-traffic / captcha) instead of returning results. THE SEARCH DID NOT RUN — do not read this as "nothing found". Solve it once in the live view, or search a site directly instead.' };
    }
    if (!text.trim()) {
      return { query, results: [], blocked: true,
               error: 'The results page came back EMPTY (no text at all) — the search did not run. Do not read this as "nothing found".' };
    }
    // Real zero: the page loaded, has content, and simply lists nothing. Say which it is, and show
    // the first line of the page so a reader can tell at a glance.
    return { query, results: [], url: where, empty: true,
             error: `No results were listed for "${query}". The page did load (it starts: "${text.trim().slice(0, 120).replace(/s+/g, ' ')}") — so this is a genuine empty result, not a broken search.` };
  }
  return { query, results, url: where };
}

/** Follow one result and read what it actually says. */
/*
 * The block was never the IP — the session already exits through the owner's own home node. It is
 * that a bare page.goto is a COLD, REFERER-LESS arrival that reads in under a second: to Forbes or a
 * Cloudflare "just a moment" wall that pattern is a bot, so it 403s or serves a challenge. The account
 * pages the agent normally works are logged in (real cookies, a trusted session) and are never
 * challenged; a fresh article has none of that. So arrive like the human whose browser this is:
 * carry a search referer, and if a challenge lands, wait it out the way a real browser does.
 */
const CHALLENGE = /just a moment|checking your browser|verify you are human|enable javascript and cookies|attention required|are you a robot/i;

/*
 * AN ADDRESS TYPED FROM MEMORY IS NOT A SOURCE.
 *
 * Measured, in a research pass whose searches had all failed: the model "remembered" Reddit thread
 * addresses — plausible subreddit, plausible slug, invented id — and dug them. Reddit does not 404 a
 * wrong id; it redirects to whatever post owns that id, so the pass read four unrelated threads and
 * quoted them as evidence for the idea. Nothing in the trail said so: the dig "worked".
 *
 * Reddit rewrites the slug of a thread address to the post's real title, so a link that was actually
 * seen on a page keeps its slug and a fabricated one does not — that is the tell. LinkedIn behaves
 * the same way with activity ids. A "page not found" title is the blunt version of the same thing.
 */
const NOT_FOUND = /page not found|\b404\b.*\b(not found|error)\b|\bnot found\b.*\b404\b|doesn.t exist|nobody on reddit goes by that name|this page isn.t available|there.s nothing here/i;

function landedElsewhere(target, landed, title = '') {
  let t, l;
  try { t = new URL(target); l = new URL(landed); } catch { return ''; }
  const host = (u) => u.hostname.replace(/^(www|old|new|m|np)\./, '');
  const asked = t.href.slice(0, 160);
  // Short, because an article ABOUT 404 pages has a long title and is a page that exists.
  if (NOT_FOUND.test(String(title || '')) && String(title).length < 120) {
    return `That address does not exist (the page says "${String(title).trim().slice(0, 60)}"). Never type an address from memory — only open links you have actually seen, in google() results or on a page you read.`;
  }
  if (/reddit\.com$/.test(host(t)) && /reddit\.com$/.test(host(l))) {
    const a = t.pathname.match(/\/comments\/([a-z0-9]+)(?:\/([^/]+))?/i);
    const b = l.pathname.match(/\/comments\/([a-z0-9]+)(?:\/([^/]+))?/i);
    if (a && b) {
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      const idOff = a[1].toLowerCase() !== b[1].toLowerCase();
      const slugOff = a[2] && b[2] && norm(a[2]) !== norm(b[2]) && !norm(b[2]).startsWith(norm(a[2]).slice(0, 24));
      if (idOff || slugOff) {
        return `That was not a real link: you asked for ${asked} and Reddit sent you to a DIFFERENT thread (${l.pathname.slice(0, 120)}). The address was written from memory, and what is on this page is not evidence for anything you searched. Only open links you have actually seen — in google() results or on a page you read — never one you composed.`;
      }
    }
  }
  if (/linkedin\.com$/.test(host(t)) && /linkedin\.com$/.test(host(l))) {
    const a = t.href.match(/activity[-:](\d{6,})/i), b = l.href.match(/activity[-:](\d{6,})/i);
    if (a && b && a[1] !== b[1]) {
      return `That was not a real link: you asked for ${asked} and LinkedIn sent you to a different post. Only open links you have actually seen on a page — never one written from memory.`;
    }
  }
  return '';
}

async function readPage(page, target, { settle = 900 } = {}) {
  const go = (opts) => page.goto(target, { referer: 'https://www.google.com/', waitUntil: 'domcontentloaded', timeout: 45000, ...opts });
  try { await go(); }
  catch (e) {
    // A direct hit that 403'd or was interrupted mid-redirect. Try once more, patiently — networkidle
    // gives a challenge or a slow redirect time to settle instead of failing on the first blip.
    try { await go({ waitUntil: 'networkidle', timeout: 30000 }); }
    catch (e2) { return { url: target, error: `could not open that page (${String(e2.message).split('\n')[0]}). It may refuse non-referred visits — try a different source.` }; }
  }
  await new Promise((r) => setTimeout(r, settle));
  // If we landed on an anti-bot interstitial, give it a few seconds to clear itself — a real browser passes these.
  let title = '';
  try {
    title = await page.title().catch(() => '');
    for (let i = 0; i < 3 && CHALLENGE.test(title); i++) { await new Promise((r) => setTimeout(r, 2500)); title = await page.title().catch(() => ''); }
  } catch { /* best effort — read whatever is there */ }
  // A made-up address that the site quietly redirected: refuse to read it as if it were the page asked for.
  let landed = target;
  try { landed = page.url() || target; } catch { /* keep target */ }
  const elsewhere = landedElsewhere(target, landed, title);
  if (elsewhere) return { url: landed, elsewhere: true, error: elsewhere };
  try { return { url: page.url(), ...(await page.evaluate(extractReadable)) }; }
  catch (e) { return { url: target, error: `could not read that page: ${e.message}` }; }
}

module.exports = { extractResults, extractReadable, looksLikeConsent, search, readPage, resolveWrapped, landedElsewhere, url };
