/**
 * sites/facebook.js — Facebook, understood once, so the agent never has to work it out again.
 *
 * WHY THIS EXISTS.
 *
 * Evaluating a single post used to cost five tool calls and about fifteen thousand tokens: look at
 * sixty clickable things, click one, read ten thousand characters of page, scroll, read again. In a
 * real run that produced forty-two tool calls and zero leads — every step spent OPERATING Facebook
 * and nothing left for the only thing a model is actually good at, which is judging whether a
 * person needs what you sell.
 *
 * So the site is read here, in code, and handed over as a list of posts: who wrote it, what it
 * says, when, and its permalink. One call. The agent stops being a browser driver and goes back to
 * being a reader.
 *
 * THE STOPPING RULE IS MECHANICAL, NOT A JUDGEMENT.
 *
 * "Scroll until you start seeing the same posts again" is a loop, and asking a model to run a loop
 * one iteration per turn is how you spend a budget on scrolling. It runs in here: keep scrolling
 * while new posts keep appearing, stop when a whole screenful is already seen or older than the
 * cut-off, and never scroll forever.
 *
 * WHY SELECTORS ARE A LAST RESORT. Facebook's class names are generated and change without notice,
 * so anything built on them breaks silently and invisibly — the worst failure mode there is. What
 * IS stable is what the page MEANS: an article element per post, a permalink whose href contains
 * /posts/ or /permalink/, a time element or a dated link. Everything below reads meaning first and
 * only falls back to shape. When it finds nothing it says so, loudly, rather than returning an
 * empty list that looks like a quiet day on Facebook.
 */

/*
 * OPEN EVERY COLLAPSED POST BEFORE READING ANY OF THEM.
 *
 * Facebook truncates a long post in a feed and keeps the rest behind a "See more" control, so
 * innerText on the article is its first line until that control is pressed. Reading without pressing
 * is why a filed thread's body kept coming back as a copy of its own headline — and a headline is
 * what the drafter then had to answer.
 *
 * Injected, so self-contained and it must never throw: a failure here is indistinguishable from
 * "nothing to expand", and would put us straight back to reading first lines.
 *
 * Returns how many it opened, which is worth having in the log the day this stops working.
 */
function expandPosts() {
  /* The words this browser actually meets. It shows pages in the owner's own language. */
  const LABELS = [
    'see more', 'see more.', 'meer weergeven', 'mehr anzeigen', 'voir plus', 'ver más', 'ver mais',
    'mostra altro', 'zobacz więcej', 'daha fazla göster', 'læs mere', 'visa mer', 'vis mer',
  ];
  let opened = 0;
  try {
    const articles = Array.from(document.querySelectorAll('div[role="article"], article'));
    for (const el of articles) {
      for (const b of Array.from(el.querySelectorAll('div[role="button"], span[role="button"]'))) {
        const label = (b.innerText || '').trim().toLowerCase();
        if (!label || label.length > 30) continue;       // a long label is not an expander
        /*
         * Either it says so, or it sits inside a block Facebook has clamped — the clamp is the
         * truncation itself, so the structural test needs no language at all.
         */
        const clamped = (() => {
          let p = b.parentElement;
          for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
            const st = window.getComputedStyle(p);
            if (st && (st.webkitLineClamp && st.webkitLineClamp !== 'none')) return true;
          }
          return false;
        })();
        if (!LABELS.includes(label) && !clamped) continue;
        try { b.click(); opened++; } catch (e) { /* one that will not open must not stop the rest */ }
      }
    }
  } catch (e) { /* never throw: silence here reads as 'nothing collapsed' */ }
  return opened;
}

/* Injected into the page. Runs in the browser, so it must be self-contained and must never throw —
   an exception here is indistinguishable from "no posts", which is the lie that would waste days. */
function extractPosts() {
  const out = [];
  const seen = new Set();

  // A post is an <article> on every Facebook surface — feed, group, search results. That has been
  // true far longer than any class name, because it is what the markup MEANS.
  const articles = Array.from(document.querySelectorAll('div[role="article"], article'));

  for (const el of articles) {
    try {
      const text = (el.innerText || '').trim();
      if (text.length < 25) continue;                       // a reaction bar, not a post

      // The permalink: a link to a post, a permalink, or a story. Facebook decorates these
      // heavily, so the path is what identifies them rather than the whole href.
      let url = null;
      for (const a of el.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        if (/\/posts\/|\/permalink\/|story_fbid=|\/groups\/\d+\/posts\//.test(href)) {
          url = href.startsWith('http') ? href : location.origin + href;
          break;
        }
      }

      /*
       * The date. Facebook writes it three ways and only one is machine-readable: a <time> element
       * with a datetime attribute. The other two are the link's own text ("9 september 2021") and
       * a relative phrase ("4 u"), so all three are captured and the caller decides. Guessing here
       * would be worse than admitting the date is unknown — a lead wrongly called fresh is one that
       * gets answered four years late.
       */
      let iso = null, dateText = null;
      const t = el.querySelector('time[datetime]');
      if (t) iso = t.getAttribute('datetime');
      const dated = el.querySelector('a[href*="/posts/"] span, a[href*="permalink"] span, time');
      if (dated) dateText = (dated.innerText || '').trim().slice(0, 40) || null;

      // The author is the first strong link that is not the group itself.
      let author = null, profileUrl = null;
      for (const a of el.querySelectorAll('h2 a, h3 a, strong a, span a[role="link"]')) {
        const name = (a.innerText || '').trim();
        const href = a.getAttribute('href') || '';
        if (name && name.length < 60 && !/\/groups\/\d+\/?$/.test(href)) {
          author = name;
          profileUrl = href.startsWith('http') ? href : location.origin + href;
          break;
        }
      }

      let group = null;
      const g = el.querySelector('a[href*="/groups/"]');
      if (g) {
        const gt = (g.innerText || '').trim();
        if (gt && gt.length < 80) group = gt;
      }

      // Two copies of the same post on one page — search results do this — count once.
      const key = url || (author || '') + '|' + text.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        author, profileUrl, group, url,
        postedIso: iso, postedText: dateText,
        // Enough to judge on. The whole thing can be read later if it turns out to matter.
        text: text.slice(0, 1200),
      });
    } catch { /* one malformed post must not cost the other thirty */ }
  }
  return out;
}

/** Turn whatever the page said about a date into days old, or null when it genuinely cannot tell. */
function ageInDays(post, now = Date.now()) {
  if (post.postedIso) {
    const t = Date.parse(post.postedIso);
    if (Number.isFinite(t)) return Math.max(0, (now - t) / 86400000);
  }
  const s = String(post.postedText || '').toLowerCase().trim();
  if (!s) return null;

  // Facebook's relative forms, in the languages this account actually sees.
  let m = s.match(/^(\d+)\s*(m|min|minuten|minutes?)\b/);        if (m) return 0;
  m = s.match(/^(\d+)\s*(u|uur|h|hours?)\b/);                    if (m) return Number(m[1]) / 24;
  m = s.match(/^(\d+)\s*(d|dag|dagen|days?)\b/);                 if (m) return Number(m[1]);
  m = s.match(/^(\d+)\s*(w|week|weken|weeks?)\b/);               if (m) return Number(m[1]) * 7;
  if (/^(gisteren|yesterday)/.test(s)) return 1;
  if (/^(vandaag|today|zojuist|just now|nu)/.test(s)) return 0;

  const MONTHS = { januari:0, january:0, februari:1, february:1, maart:2, march:2, april:3,
                   mei:4, may:4, juni:5, june:5, juli:6, july:6, augustus:7, august:7,
                   september:8, oktober:9, october:9, november:10, december:11 };

  /*
   * "9 september" — a day and a month with no year. This is checked BEFORE the general parser
   * because Date.parse reads it as the YEAR 9 and returns a date two thousand years ago, which
   * looked exactly like a very old post and was caught only by a test asserting the age.
   *
   * Facebook omits the year only when it is the current one, so a date that would still be in the
   * future belongs to last year.
   */
  m = s.match(/^(\d{1,2})\s+([a-z]+)$/);
  if (m && MONTHS[m[2]] !== undefined) {
    const d = new Date(now);
    let guess = new Date(d.getFullYear(), MONTHS[m[2]], Number(m[1]));
    if (guess.getTime() > now) guess = new Date(d.getFullYear() - 1, MONTHS[m[2]], Number(m[1]));
    return Math.max(0, (now - guess.getTime()) / 86400000);
  }

  /*
   * A full date, which is what Facebook writes once a post is old enough to matter. Bounded on both
   * sides: anything before Facebook existed or in the future is this parser being confidently
   * wrong, and an age nobody can rely on is worse than admitting the date is unknown.
   */
  const abs = Date.parse(s);
  if (Number.isFinite(abs)) {
    const days = (now - abs) / 86400000;
    if (days >= -1 && days < 20 * 365) return Math.max(0, days);
  }
  return null;
}

/**
 * Read a feed properly: scroll until there is nothing new, then hand back what is worth reading.
 *
 * `seen` is carried BETWEEN calls by the caller, so a second sweep of the same group returns only
 * what has appeared since — which is what makes checking back cheap rather than a full re-read.
 */
async function readFeed(page, {
  maxAgeDays = 92,
  maxScrolls = 12,
  maxPosts = 60,
  seen = new Set(),
  settle = 1200,
  now = () => Date.now(),
} = {}) {
  const found = [];
  let tooOld = 0, skippedSeen = 0, scrolls = 0, emptyRounds = 0;

  for (; scrolls <= maxScrolls; scrolls++) {
    let batch = [];
    /*
     * PRESS "SEE MORE" FIRST. Without this the text of a long post is its opening line, which is
     * also its title — the reason filed threads kept arriving with a body that was a copy of the
     * headline. Best-effort and never fatal: an expansion that fails leaves the old behaviour.
     */
    try {
      const opened = await page.evaluate(expandPosts);
      if (Number(opened) > 0) await new Promise((r) => setTimeout(r, 400));   // a COUNT, and only then wait for the text to render
    } catch (e) { /* read what is there */ }
    try { batch = await page.evaluate(extractPosts); }
    catch (e) { return { posts: found, error: `could not read this page: ${e.message}`, scrolls }; }

    let fresh = 0;
    for (const p of batch) {
      const key = p.url || `${p.author || ''}|${(p.text || '').slice(0, 80)}`;
      if (seen.has(key)) { skippedSeen++; continue; }
      seen.add(key);
      fresh++;

      const age = ageInDays(p, now());
      /*
       * Old posts are counted and dropped, not returned. Somebody who asked four years ago has long
       * since found what they needed, and answering them is the clearest sign to whoever reads it
       * that nobody is home. An unknown date is NOT treated as old — that would silently discard
       * every post whose date this could not parse.
       */
      if (age !== null && age > maxAgeDays) { tooOld++; continue; }
      found.push({ ...p, ageDays: age === null ? null : Math.round(age) });
      if (found.length >= maxPosts) break;
    }

    if (found.length >= maxPosts) break;

    /*
     * THE STOPPING RULE. A screenful with nothing new in it means the feed has stopped loading —
     * twice in a row, because Facebook sometimes returns one slow batch. This is the loop that was
     * being asked of the model one turn at a time.
     */
    if (fresh === 0) { if (++emptyRounds >= 2) break; }
    else emptyRounds = 0;

    try {
      await page.mouse.wheel(0, 1400);
      await new Promise((r) => setTimeout(r, settle));
    } catch { break; }
  }

  return {
    posts: found,
    scrolls,
    // Said out loud, because "nothing here" and "everything here was old" are different answers and
    // only one of them means move on.
    tooOld,
    skippedSeen,
    stopped: found.length >= maxPosts ? 'enough posts'
      : scrolls > maxScrolls ? 'scrolled as far as it goes'
      : 'nothing new was loading',
  };
}

/** The addresses that matter, built properly rather than typed from memory into a prompt. */
const url = {
  searchPosts: (q) => `https://www.facebook.com/search/posts?q=${encodeURIComponent(q)}`,
  searchGroups: (q) => `https://www.facebook.com/search/groups?q=${encodeURIComponent(q)}`,
  groupSearch: (id, q) => `https://www.facebook.com/groups/${encodeURIComponent(id)}/search/?q=${encodeURIComponent(q)}`,
  myGroupsFeed: () => 'https://www.facebook.com/groups/feed/',
  notifications: () => 'https://www.facebook.com/notifications',
  messages: () => 'https://www.facebook.com/messages/t/',
};

module.exports = { extractPosts, expandPosts, ageInDays, readFeed, url };
