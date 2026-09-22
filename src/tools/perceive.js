'use strict';
const { dismissConsent } = require('../inspector');
/**
 * tools/perceive.js — the three ways the agent finds out where it is.
 *
 * `look` gives the CONTROLS as a numbered list, `read` gives the WORDS, and `open` goes somewhere
 * and does both. Keeping them together makes the division visible, because confusing the two is the
 * most expensive mistake this agent makes: you cannot judge a post from a look, that is judging a
 * page by its buttons, and a run that looks when it should read finds nothing and reports nothing.
 *
 * All three carry a memory of what they last returned. Resending sixty identical element lines on
 * every step was most of the token bill, and worse than the cost: a scroll that loaded nothing
 * followed by a read returning the same text taught the model that the group was worth another pass.
 * Saying "nothing changed" in one line is both cheaper and truer.
 */

/*
 * ── READING A TABLE AS DATA, BECAUSE PROSE IS WHERE THE NUMBERS GO WRONG ─────────────────────────
 *
 * `read` hands back the page as text and the model retypes what it needs out of it. For a paragraph
 * that is fine. For a table of numbers it is the one step in the whole chain that can be silently
 * wrong: a column misaligned by one, a thousands separator read as a decimal point, a row skipped
 * because it wrapped. Nothing downstream can tell — a wrong impression count looks exactly like a
 * right one.
 *
 * The numbers are already structured in the page. This returns the cells: header row, then the body
 * rows, as they are. The model chooses which table and what the columns mean; it never transcribes.
 *
 * It also replaces a loop. Reading a Search Console report by eye was look → read → scroll → read
 * again; one call answers the same question, which is most of the difference between a walk that
 * takes four steps and one that took a hundred and sixty.
 *
 * Runs INSIDE the page, so it sees what a real table is made of: a <table>, an ARIA grid, and the
 * row/cell roles that every component library lands on once it renders. Deliberately not a scraper
 * for one site — every analytics page this platform reads is a table somewhere.
 */
const GRAB_TABLES = (maxRows) => {
  const clean = (el) => String((el && el.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const visible = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 20) return false;
      const st = getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
    } catch { return false; }
  };
  /* Cells by role first (a component library labels them), then by tag for a plain table. */
  const cellsOf = (row) => {
    let cs = [...row.querySelectorAll('[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]')];
    if (!cs.length) cs = [...row.querySelectorAll('th,td')];
    /* Only DIRECT cells — a nested table's cells belong to the nested table. */
    return cs.filter((c) => c.closest('[role="row"],tr') === row).map(clean);
  };
  const rowsOf = (t) => {
    let rs = [...t.querySelectorAll('[role="row"]')];
    if (!rs.length) rs = [...t.querySelectorAll('tr')];
    return rs.filter((r) => r.closest('table,[role="table"],[role="grid"],[role="treegrid"]') === t);
  };

  const found = [];
  const seen = new Set();
  for (const t of document.querySelectorAll('table,[role="table"],[role="grid"],[role="treegrid"]')) {
    if (seen.has(t) || !visible(t)) continue;
    seen.add(t);
    const rows = rowsOf(t).map(cellsOf).filter((r) => r.length && r.some((c) => c));
    if (rows.length < 2) continue;                  // a header alone is not a table worth returning
    /* The first row is a header when the page says so, or when it is the only row without numbers. */
    const first = rows[0];
    const looksHeader = !!t.querySelector('thead,[role="columnheader"]')
      || !first.some((c) => /^[\s$€£]*[\d.,]+%?$/.test(c));
    found.push({
      headers: looksHeader ? first : [],
      rows: (looksHeader ? rows.slice(1) : rows).slice(0, maxRows),
      rowsTotal: looksHeader ? rows.length - 1 : rows.length,
      caption: clean(t.querySelector('caption')) || (t.getAttribute('aria-label') || '').slice(0, 80),
    });
  }
  /* Biggest first: on a dashboard the one that matters is almost always the one with the most rows. */
  return found.sort((a, b) => b.rowsTotal - a.rowsTotal).slice(0, 6);
};

/* A search page is useless to read by hand — the matches load as you scroll, which is sweep's job.
   A group's own page or a single post reads fine, so those are deliberately not matched here. */
const SEARCH_PAGE = [
  /linkedin\.com\/search\/results\/content/i,
  /facebook\.com\/search\//i,
];

/* Standing on one of these, the address in the bar IS the post's permalink. A whole run once spent
   its budget clicking timestamps to obtain something it was already holding, because nothing said so. */
const IS_PERMALINK = /\/posts\/|\/permalink\/|story_fbid=/;

/** Gather text from every reachable frame, piercing shadow roots. Runs inside the page. */
const COLLECT_TEXT = () => {
  const seen = new Set();
  const collect = (root) => {
    const base = root === document ? (document.body || document.documentElement) : root;
    let s = (base && (base.innerText || base.textContent)) || '';
    let all = [];
    try { all = root.querySelectorAll('*'); } catch { all = []; }
    for (const el of all) if (el.shadowRoot && !seen.has(el.shadowRoot)) { seen.add(el.shadowRoot); s += '\n' + collect(el.shadowRoot); }
    return s;
  };
  return collect(document);
};

module.exports = {
  /** Every clickable thing, numbered. The numbers are only valid until the page changes. */
  async look(ctx) {
    const an = await ctx.freshAnalysis();
    /*
     * THE NUMBERED LIST GOES INTO THE RECORD, NOT JUST TO THE MODEL.
     *
     * Without this the step reads "2 things to click" and nothing else, so every `click [13]` in the
     * history is a decision whose entire justification was thrown away when the run ended. Training
     * on that teaches a model to guess an index out of nothing — which is the stale-index failure we
     * are trying to remove, taught deliberately.
     *
     * Stored on EVERY look, including the unchanged-page case below where the live transcript says
     * "the numbers above are still valid". The model has them in its transcript; a single turn
     * replayed later does not, and the turn is the unit training sees.
     *
     * Capped, because this is written to disk for every look of every job and the jobs directory is
     * already 284 MB. Two thousand characters is roughly thirty elements, which covers the thing
     * that was actually clicked in almost every case.
     */
    ctx.step('look', `${an.title || an.url} — ${an.elementCount} things to click${an.modal ? ' (inside the open dialog)' : ''}`,
      { url: an.url, marks: String(an.summary || '').slice(0, 2000) });
    /* Sixty element lines, resent every step, was most of the bill. If the page has not moved since
       the last look, say so in one line instead of repeating all of it. */
    const fingerprint = `${an.url}|${an.summary}`;
    if (fingerprint === ctx.memo.look) {
      ctx.observe(`Still ${an.url} and nothing on it has changed. The numbers above are still valid — use them, scroll, or go somewhere else.`);
      return;
    }
    ctx.memo.look = fingerprint;
    ctx.observe(`Page: ${an.title}\nAddress: ${an.url}\n\nClickable:\n${an.summary || '(nothing)'}`);
  },

  /**
   * THE FEED TRAP. The agent kept building LinkedIn search URLs, open()ing them and read()ing the
   * raw text — which returns the page frame, not the posts, because the posts stream in as you
   * scroll. So it read twenty searches by hand and saved nothing, while sweep sat unused. On a feed
   * or a search page this redirects to sweep instead of handing back text.
   */
  async read(ctx, a) {
    const hereNow = ctx.page().url();
    const onSearch = SEARCH_PAGE.some((re) => re.test(hereNow));
    if (onSearch && !a.force) {
      const which = /linkedin/i.test(hereNow) ? 'linkedin' : 'facebook';
      ctx.observe(`You are on a ${which} feed/search page. Do NOT read it by hand — reading `
        + `returns the page frame, and the posts only load as you scroll. Call `
        + `sweep({ site: "${which}", search: "the words you are looking for" }) instead: `
        + `it scrolls to the end and hands you the posts with author, text, age and link. `
        + `Then save_lead each real one. That is how leads are found here.`);
      return;
    }
    await ctx.settle(400);
    /*
     * CLEAR THE WALL FIRST. A cookie/consent banner covers the page and IS the page as far as
     * innerText is concerned — live: 2044 characters of Polish cookie categories where a listing
     * should have been, three builds spent on it. look() has always done this inside analyzePage;
     * a flow that reads without looking deserves the same. Idempotent (the site sets its own
     * cookie) and it only clicks an exact known consent phrase, so it cannot hit real content.
     */
    let dismissed = null;
    try { dismissed = await dismissConsent(ctx.page()); } catch { /* no banner is the normal case */ }
    if (dismissed) await ctx.settle(600);
    let text = await ctx.page().evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
    /* A thin top document means the real content lives inside a frame (a logged-in dashboard/app)
       or a shadow tree. Gathering from every reachable frame and keeping the richest is what lets
       the agent read an SPA it cannot otherwise see, instead of reporting "15 characters". */
    if (text.trim().length < 40) {
      for (const fr of ctx.page().frames()) {
        let t = '';
        try { t = await fr.evaluate(COLLECT_TEXT); } catch { t = ''; }
        if (t && t.trim().length > text.trim().length) text = t;
      }
    }
    const trimmed = text.replace(/\n{3,}/g, '\n\n').slice(0, 5000);
    ctx.step('read', `read the page (${text.length} characters)${dismissed ? ` — cleared a consent banner first ("${dismissed}")` : ''}`);
    const here = ctx.page().url();
    /* Reading the same thing twice teaches nothing and costs the same. It happened often: a scroll
       that loaded nothing new, then a read returning identical text, and the model would conclude
       the group was worth another pass. */
    if (trimmed === ctx.memo.read) {
      ctx.observe('That is the same text you already read — nothing new loaded. Scroll further, or move on.');
      return;
    }
    ctx.memo.read = trimmed;
    ctx.observe(`You are on: ${here}\n`
      + (IS_PERMALINK.test(here)
          ? 'That is a post\'s own page, so that address is its permalink — use it as postUrl.\n' : '')
      + `\nPage text:\n${trimmed}`);
  },

  /**
   * The tables on this page, as cells. See GRAB_TABLES above for why this exists.
   *
   * `index` picks one when there are several (they come back biggest-first); `rows` caps how many
   * body rows are returned. Frames are searched too, because a dashboard's real content often lives
   * in one — the same reason `read` walks them.
   */
  async read_table(ctx, a = {}) {
    await ctx.settle(500);
    const maxRows = Math.min(Math.max(Number(a.rows) || 25, 1), 100);
    let tables = [];
    try { tables = await ctx.page().evaluate(GRAB_TABLES, maxRows); } catch { tables = []; }
    if (!tables.length) {
      for (const fr of ctx.page().frames()) {
        let t = []; try { t = await fr.evaluate(GRAB_TABLES, maxRows); } catch { t = []; }
        if (t && t.length) { tables = t; break; }
      }
    }
    if (!tables.length) {
      ctx.step('read', 'no table on this page');
      ctx.observe('There is no table on this page. If the numbers you want are drawn in a chart, read the page instead — and if you are on the wrong address, open the right one rather than clicking about.');
      return;
    }
    const pick = Number.isInteger(a.index) && tables[a.index] ? a.index : 0;
    const t = tables[pick];
    const render = (cells) => cells.join(' | ');
    const lines = [
      ...(t.headers.length ? [render(t.headers), '-'.repeat(Math.min(60, render(t.headers).length))] : []),
      ...t.rows.map(render),
    ];
    const more = t.rowsTotal > t.rows.length
      ? `\n(${t.rowsTotal - t.rows.length} more row(s) not shown — ask for more with rows:)` : '';
    const others = tables.length > 1
      ? `\n\nOther tables here: ${tables.map((x, i) => `[${i}] ${x.caption || (x.headers[0] || 'table')} (${x.rowsTotal} rows)`).filter((_, i) => i !== pick).join(', ')} — read one with index:`
      : '';
    ctx.step('read', `read a table (${t.rowsTotal} row(s)${tables.length > 1 ? `, ${tables.length} tables on the page` : ''})`);
    /*
     * THE CELLS, NOT A SUMMARY. The point of this tool is that the numbers arrive exactly as the page
     * has them, so they are handed over verbatim and the model is told not to do arithmetic on them.
     */
    ctx.observe(`${t.caption ? t.caption + '\n' : ''}${lines.join('\n')}${more}${others}\n\nThese are the page's own cells. File them exactly as they read — never round, convert or add them up.`);
  },

  /** Go to an address. A bare host is completed rather than rejected — see below. */
  async open(ctx, a) {
    // A bare host is what a model writes when it has read one in a prompt. Chromium rejects it
    // outright, which costs a step and teaches nothing.
    const url = /^[a-z]+:\/\//i.test(String(a.url).trim())
      ? String(a.url).trim() : `https://${String(a.url).trim().replace(/^\/+/, '')}`;
    ctx.step('open', url);
    await ctx.page().goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    ctx.resetClickLoop();                 // a new page is progress
    await ctx.settle(700);                // let an SPA hydrate / frames attach before the first look
    const an = await ctx.freshAnalysis();
    ctx.observe(`Opened ${an.url} — ${an.title}\n\nClickable:\n${an.summary}`);
  },
};
