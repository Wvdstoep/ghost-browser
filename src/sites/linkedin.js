/**
 * sites/linkedin.js — LinkedIn read as data, the same way Facebook is.
 *
 * SAME SHAPE, DIFFERENT SITE, AND ONE GENUINE ADVANTAGE.
 *
 * Facebook has to be scraped for its permalinks — the href is buried, decorated with tracking
 * parameters, and sometimes absent. LinkedIn puts a stable identifier on every post:
 *
 *     data-urn="urn:li:activity:7231234567890123456"
 *
 * That urn IS the address. The permalink is /feed/update/<urn>/ and can be CONSTRUCTED rather than
 * found, which means a post can never come back without a link — the failure that produced twelve
 * unusable Facebook leads in one run. It also makes deduplication exact rather than a hash of the
 * first eighty characters.
 *
 * WHAT IS HARDER HERE. LinkedIn shows ages as "2d", "1w", "3mo" with no machine-readable date
 * anywhere, so the age always comes from parsing that string; there is no <time datetime> to fall
 * back on. And a "post" is often a repost of somebody else's, where the person to approach is the
 * original author and not the one who shared it — that is recorded rather than flattened, because
 * approaching the wrong one of the two is worse than not approaching at all.
 */

/* Injected into the page. Self-contained, and must never throw: an exception here looks exactly
   like a quiet day on LinkedIn. */
function extractPosts() {
  const out = [];
  const byId = new Map();
  /*
   * WHY THIS REPORTS ON ITSELF.
   *
   * The first version keyed on [data-urn] and [data-id], which is how the FEED is marked up. On
   * /search/results/content/ — where the agent actually spends its time, because that is where you
   * search — LinkedIn marks results up differently, so it matched nothing and returned an empty
   * list. "0 posts" and "0 posts because the markup moved" are the same answer from outside, so the
   * agent read twenty search pages by hand, found nothing, and nobody could tell why. It says which
   * route found what now, and how much text was on the page it found nothing in.
   */
  const diag = { byAttr: 0, byScan: 0, byHref: 0, tooShort: 0, chars: 0 };
  // innerText in a real browser; textContent as a fallback (jsdom under test has no innerText).
  const vis = (n) => (n && (n.innerText != null ? n.innerText : n.textContent) || '');
  try { diag.chars = vis(document.body).length; } catch { /* ignore */ }

  const RE = /urn:li:activity:(\d+)/;

  /*
   * The card, not the thing that happened to carry the id. The id can sit on a wrapper, on an inner
   * div, or on a link inside the footer — so walk up until there is enough text to be a post,
   * stopping well short of the page container.
   */
  function cardFor(el) {
    let node = el;
    for (let i = 0; i < 8 && node && node.parentElement; i++) {
      const t = vis(node).trim();
      if (t.length >= 80) return node;
      node = node.parentElement;
    }
    return el;
  }

  function offer(el, id, route) {
    if (!el || !id) return;
    const card = cardFor(el);
    const prev = byId.get(id);
    // Several nodes can carry the same id; keep whichever resolves to the most complete card.
    const len = (vis(card).trim()).length;
    if (!prev || len > prev.len) {
      if (!prev) diag[route]++;
      byId.set(id, { card, len });
    }
  }

  /*
   * ROUTE 1 — the attribute names LinkedIn is known to use. Cheap, and covers the feed and the
   * search page as they stand today.
   */
  try {
    const q = '[data-urn],[data-id],[data-entity-urn],[data-chameleon-result-urn],[data-activity-urn]';
    for (const el of Array.from(document.querySelectorAll(q))) {
      for (const a of Array.from(el.attributes || [])) {
        const m = RE.exec(a.value || '');
        if (m) { offer(el, m[1], 'byAttr'); break; }
      }
    }
  } catch { /* ignore */ }

  /*
   * ROUTE 2 — any attribute anywhere whose VALUE carries an activity urn. LinkedIn renames
   * attributes; it cannot rename the urn, because the urn is the thing the id IS. This is what
   * stops the next markup change from being another silent zero. Only run when route 1 came up
   * empty, since it walks the whole document.
   */
  if (byId.size === 0) {
    try {
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const attrs = el.attributes;
        if (!attrs || !attrs.length) continue;
        for (let i = 0; i < attrs.length; i++) {
          const m = RE.exec(attrs[i].value || '');
          if (m) { offer(el, m[1], 'byScan'); break; }
        }
      }
    } catch { /* ignore */ }
  }

  /*
   * ROUTE 3 — the link to the post itself. A search result always offers a way to open the post,
   * and that href contains the urn even when nothing else on the card does.
   */
  if (byId.size === 0) {
    try {
      for (const a of Array.from(document.querySelectorAll('a[href*="urn:li:activity:"]'))) {
        const m = RE.exec(a.getAttribute('href') || '');
        if (m) offer(a, m[1], 'byHref');
      }
    } catch { /* ignore */ }
  }

  for (const [id, { card: el }] of byId) {
    try {
      const text = vis(el).trim();
      if (text.length < 25) { diag.tooShort++; continue; }

      /*
       * The author. LinkedIn's own accessible name for the actor is the most reliable thing on the
       * card; the visible name is often duplicated for screen readers and comes back doubled.
       */
      let author = null, profileUrl = null, headline = null;
      const actor = el.querySelector('.update-components-actor__title, [data-view-name="actor-name"], a[href*="/in/"], a[href*="/company/"]');
      if (actor) {
        author = (actor.getAttribute('aria-label') || vis(actor)).trim().split('\n')[0].slice(0, 80) || null;
        const a = (actor.closest && actor.closest('a[href]')) || el.querySelector('a[href*="/in/"], a[href*="/company/"]');
        if (a) {
          const href = a.getAttribute('href') || '';
          profileUrl = href.startsWith('http') ? href : 'https://www.linkedin.com' + href;
          profileUrl = profileUrl.split('?')[0];
        }
      }
      // The line under the name — what they do, which on LinkedIn is half of whether they matter.
      const sub = el.querySelector('.update-components-actor__description, .update-components-actor__sub-description, [class*="subline"]');
      if (sub) headline = vis(sub).trim().split('\n')[0].slice(0, 140) || null;

      /*
       * The age. There is no machine-readable date anywhere on a LinkedIn card, so this is the only
       * source: a short relative string, usually next to a bullet in the sub-description.
       */
      let postedText = null;
      const whole = (sub ? vis(sub) : '') || text;
      const rel = whole.match(/\b(\d+)\s*(m|min|h|u|d|w|mo|mnd|y|jr)\b/i);
      if (rel) postedText = rel[0].trim();

      /* A repost: the person worth approaching is the ORIGINAL author, not whoever shared it, and
         flattening those together sends a message to the wrong person. */
      const reshared = !!el.querySelector('.update-components-mini-update-v2, [data-view-name="reshared-update"]');

      out.push({
        id,
        author, profileUrl, headline,
        // Constructed, never scraped. A post here can never come back without a link.
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:' + id + '/',
        postedIso: null,
        postedText,
        reshared,
        text: text.slice(0, 1200),
      });
    } catch { /* one odd card must not cost the rest */ }
  }

  // The diagnostic rides along on the array so the shape stays what every caller already expects.
  try { Object.defineProperty(out, 'diag', { value: diag, enumerable: false }); } catch { /* ignore */ }
  return out;
}

/**
 * How old, from LinkedIn's short forms. Deliberately separate from Facebook's: the vocabulary
 * differs ("mo" and "mnd" for months, which Facebook never writes) and merging them would mean one
 * parser quietly mis-reading the other site.
 */
function ageInDays(post, now = Date.now()) {
  const s = String(post.postedText || '').toLowerCase().trim();
  if (!s) return null;
  const m = s.match(/^(\d+)\s*(m|min|h|u|d|w|mo|mnd|y|jr)$/);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'm': case 'min': return 0;
    case 'h': case 'u': return n / 24;
    case 'd': return n;
    case 'w': return n * 7;
    case 'mo': case 'mnd': return n * 30;
    case 'y': case 'jr': return n * 365;
    default: return null;
  }
}

/**
 * Read a feed until nothing new is loading — the same contract as the Facebook one, so the agent's
 * sweep tool does not have to care which site it is on.
 */
async function readFeed(page, {
  maxAgeDays = 92,
  maxScrolls = 12,
  maxPosts = 60,
  seen = new Set(),
  settle = 1400,
  now = () => Date.now(),
} = {}) {
  const found = [];
  let tooOld = 0, skippedSeen = 0, scrolls = 0, emptyRounds = 0;
  let diag = null, sawAnyPost = false;

  for (; scrolls <= maxScrolls; scrolls++) {
    let batch = [];
    try { batch = await page.evaluate(extractPosts); }
    catch (e) { return { posts: found, error: `could not read this page: ${e.message}`, scrolls }; }
    if (batch && batch.diag && !diag) diag = batch.diag;
    if (batch && batch.length) sawAnyPost = true;

    let fresh = 0;
    for (const p of batch) {
      // Exact, because LinkedIn gives every post a real identifier.
      if (seen.has(p.id)) { skippedSeen++; continue; }
      seen.add(p.id);
      fresh++;

      const age = ageInDays(p, now());
      // An unknown age is NOT old — discarding those would silently drop every post whose relative
      // date this could not read.
      if (age !== null && age > maxAgeDays) { tooOld++; continue; }
      found.push({ ...p, ageDays: age === null ? null : Math.round(age) });
      if (found.length >= maxPosts) break;
    }
    if (found.length >= maxPosts) break;

    if (fresh === 0) { if (++emptyRounds >= 2) break; }
    else emptyRounds = 0;

    try {
      await page.mouse.wheel(0, 1400);
      await new Promise((r) => setTimeout(r, settle));
    } catch { break; }
  }

  /*
   * WHY NOTHING, when there is nothing. An empty feed and a feed this code can no longer read look
   * identical from the outside, and the second one is a bug that hid for a whole run. If not one
   * post was recognised on a page that clearly had text on it, say so plainly rather than reporting
   * a quiet day — that is the difference between "search elsewhere" and "the extractor is broken".
   */
  let note = null;
  if (!sawAnyPost && diag && diag.chars > 400) {
    note = `read ${diag.chars} characters here but recognised no posts — the page markup may have `
         + `moved, or this search genuinely has no results`;
  }

  return {
    posts: found, scrolls, tooOld, skippedSeen, diag, note,
    stopped: found.length >= maxPosts ? 'enough posts'
      : scrolls > maxScrolls ? 'scrolled as far as it goes'
      : 'nothing new was loading',
  };
}

const url = {
  /* Content search is where people describe what they need. LinkedIn's own sort parameter puts the
     recent ones first, which matters more here than on Facebook — it will happily lead with a
     popular post from two years ago. */
  searchPosts: (q) => `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(q)}&sortBy=%22date_posted%22`,
  searchPeople: (q) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`,
  feed: () => 'https://www.linkedin.com/feed/',
  notifications: () => 'https://www.linkedin.com/notifications/',
  messages: () => 'https://www.linkedin.com/messaging/',
  post: (id) => `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
};

module.exports = { extractPosts, ageInDays, readFeed, url };
