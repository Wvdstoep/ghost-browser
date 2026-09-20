'use strict';
/**
 * REPLY WATCHER — the other half of the gig engine.
 *
 * gigWatch finds work and drafts the offer. This watches what happens NEXT: whether a client wrote
 * back, and whether a sent offer changed standing. Sending two offers and learning nothing for two
 * weeks is how the first attempt failed — not because the offers were bad, but because nothing was
 * watching the answer.
 *
 * TWO SOURCES, because useme splits them:
 *   /pl/dashboard/offers/  — every offer sent, its client and which bucket it sits in (sent/closed).
 *                            A bucket change is a real event: closed means it is over, a contract
 *                            means it was won.
 *   /pl/mesg/              — the conversations. On useme an ACTIVE conversation means somebody wrote,
 *                            so a thread appearing here at all is the reply signal.
 *
 * Deliberately written to survive an unknown DOM: at the time of writing the inbox says "Brak
 * aktywnych wiadomości" (no replies yet), so there is no real thread to fit selectors to. It finds
 * threads by their LINK SHAPE and keeps whatever text the page shows as the conversation context,
 * rather than guessing at message-bubble classes that would silently break. Refine the per-message
 * split once a real reply exists.
 *
 * Reading needs the owner's login, so a pass runs in the `useme` profile. It never replies: a draft
 * is offered and the owner sends, exactly as the gig side works.
 */
const feed = require('./watcherFeed');

const DEFAULTS = {
  offersUrl: 'https://useme.com/pl/dashboard/offers/',
  inboxUrls: [
    { url: 'https://useme.com/pl/mesg/', name: 'Wiadomości' },
    { url: 'https://useme.com/pl/mesg/archive/', name: 'Archiwum' },
  ],
  /** Open at most this many threads per pass, so a full inbox cannot run away with the browser. */
  maxThreads: 12,
  /** Whose words are ours — used to guess whether a thread is waiting on us. */
  meNames: ['swiftship.dev'],
};

/** The watcher's config, seeded on first run so the owner can see and edit it without a deploy. */
function configFor(wid) {
  const cur = feed.getConfig(wid) || {};
  if (!cur.offersUrl || !cur.inboxUrls) return feed.setConfig(wid, Object.assign({ mode: 'replies' }, DEFAULTS, cur));
  return cur;
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Read the sent/closed buckets and every offer in them. */
async function readOffers(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1800);
  return page.evaluate(() => {
    const strip = (root) => {
      const c = root.cloneNode(true);
      c.querySelectorAll('script,style,noscript,svg').forEach((e) => e.remove());
      return (c.textContent || '').replace(/\s+/g, ' ').trim();
    };
    const txt = strip(document.body);
    const sent = (txt.match(/Wys[^\s]*ane oferty\s*(\d+)/) || [, null])[1];
    const closed = (txt.match(/Zamkni[^\s]*te oferty\s*(\d+)/) || [, null])[1];

    /* DO NOT ASSUME THE LINK SHAPE. The first version keyed offers on a /pl/jobs/<slug>,<id>/ link
       and found NONE while the page plainly said "sent 2" — the cards link somewhere else. So take
       any anchor that could be an offer or its job, and report every distinct href prefix seen so
       the real shape shows up in the log instead of having to be guessed at. */
    const kinds = {};
    const anchors = [].slice.call(document.querySelectorAll('a')).map((a) => {
      const h = a.getAttribute('href') || '';
      const k = h.split('/').slice(0, 4).join('/');
      if (h) kinds[k] = (kinds[k] || 0) + 1;
      return { a, h };
    });
    /* THE REAL SHAPE, read off the page rather than assumed: a sent offer is
       /pl/jobs/my-offer/<offerId>/. Matching it exactly also drops the board's own "Znajdź zlecenie"
       nav link, which a looser /jobs/ match happily collected as a third offer. */
    const OFFER = /^\/(pl|en)\/jobs\/my-offer\/\d+\/?$/;
    const ALT = /^\/(pl|en)\/(offer|offers|deals?)\/\d+\/?$/;
    const seen = {}; const offers = [];
    anchors.forEach(({ a, h }) => {
      if (!(OFFER.test(h) || ALT.test(h)) || seen[h]) return;
      seen[h] = 1;
      const card = a.closest('div,li,article,section');
      offers.push({
        href: h,
        title: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        context: card ? strip(card).slice(0, 700) : '',
      });
    });
    return {
      sentCount: sent == null ? null : Number(sent),
      closedCount: closed == null ? null : Number(closed),
      offers,
      hrefKinds: Object.keys(kinds).sort((x, y) => kinds[y] - kinds[x]).slice(0, 12),
      pageText: txt.slice(0, 600),
    };
  });
}

/**
 * Find conversation threads. A thread link is anything under /pl/mesg/ that is not one of the shell
 * pages, so this keeps working whatever useme calls the id.
 */
async function readInbox(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1800);
  return page.evaluate(() => {
    const strip = (root) => {
      const c = root.cloneNode(true);
      c.querySelectorAll('script,style,noscript,svg').forEach((e) => e.remove());
      return (c.textContent || '').replace(/\s+/g, ' ').trim();
    };
    const SHELL = /^\/(pl|en)\/mesg\/(compose|archive)?\/?$/;
    const seen = {}; const threads = [];
    document.querySelectorAll('a').forEach((a) => {
      const h = a.getAttribute('href') || '';
      if (!/^\/(pl|en)\/mesg\//.test(h) || SHELL.test(h) || /\/compose\//.test(h) || seen[h]) return;
      seen[h] = 1;
      const card = a.closest('div,li,article');
      threads.push({
        href: h,
        label: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140),
        context: card ? strip(card).slice(0, 300) : '',
      });
    });
    const body = strip(document.body);
    return { threads, empty: /Brak aktywnych wiadomo/i.test(body), pageText: body.slice(0, 400) };
  });
}

/** Open one thread and keep its whole visible conversation as context. */
async function readThread(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const c = document.body.cloneNode(true);
    c.querySelectorAll('script,style,noscript,svg,nav,header,footer').forEach((e) => e.remove());
    const text = (c.textContent || '').replace(/\s+/g, ' ').trim();
    const heads = [].slice.call(document.querySelectorAll('h1,h2,h3')).map((h) => (h.textContent || '').trim()).filter(Boolean);
    return { text: text.slice(0, 2500), title: document.title || '', heads: heads.slice(0, 4) };
  });
}

/**
 * One pass. Offers first (they exist even with an empty inbox), then any conversation. Everything
 * lands in THIS watcher's own feed, so the reply desk is separate from the gig board.
 */
async function tick(getPage, wid, opts) {
  const o = opts || {};
  const cfg = Object.assign({}, DEFAULTS, configFor(wid), o.config || {});
  const log = o.log || (() => {});
  const page = await getPage();
  const out = [];

  /* ── sent offers and their standing ───────────────────────────────────────────────────────── */
  try {
    const off = await readOffers(page, cfg.offersUrl);
    log(`[reply-watch] offers: ${off.offers.length} listed (sent ${off.sentCount}, closed ${off.closedCount})`);
    /* When the page says offers exist but none were recognised, the link shape moved. Print what is
       actually there rather than leaving a silent zero. */
    if (!off.offers.length && Number(off.sentCount) > 0) {
      log(`[reply-watch] no offer links recognised — href shapes on the page: ${(off.hrefKinds || []).join(' ')}`);
    }
    for (const ofr of off.offers) {
      const url = ofr.href.startsWith('http') ? ofr.href : 'https://useme.com' + ofr.href;
      /* Which bucket a card sits in is the standing; the page groups them, so read it off the text. */
      const ctx = ofr.context || '';
      const standing = /Zamkni/i.test(ctx) ? 'closed' : 'sent';
      const item = {
        url, title: ofr.title || url, kind: 'offer',
        fields: { type: 'offer', standing, context: ctx, sentCount: off.sentCount, closedCount: off.closedCount },
      };
      out.push(item);
    }
  } catch (e) { log(`[reply-watch] offers: ${e.message}`); }

  /* ── conversations: a thread here means somebody wrote back ───────────────────────────────── */
  let threads = [];
  for (const box of cfg.inboxUrls || []) {
    try {
      const r = await readInbox(page, box.url);
      log(`[reply-watch] ${box.name}: ${r.threads.length} thread(s)${r.empty ? ' (inbox says empty)' : ''}`);
      for (const t of r.threads) threads.push(Object.assign({ box: box.name }, t));
    } catch (e) { log(`[reply-watch] ${box.name}: ${e.message}`); }
  }
  const seen = {};
  threads = threads.filter((t) => (seen[t.href] ? false : (seen[t.href] = true)));

  for (const t of threads.slice(0, Number(cfg.maxThreads) || 12)) {
    const url = t.href.startsWith('http') ? t.href : 'https://useme.com' + t.href;
    let body = null;
    try { body = await readThread(page, url); } catch (e) { log(`[reply-watch] thread ${t.href}: ${e.message}`); }
    const convo = clean((body && body.text) || t.context);
    /* Best effort only: if the conversation does not end on our own words, it is likely our turn.
       Left as a hint, never as a claim - the per-message split needs a real thread to fit. */
    const mine = (cfg.meNames || []).filter((n) => n).map((n) => String(n).toLowerCase());
    const tail = convo.slice(-240).toLowerCase();
    const waiting = mine.length ? !mine.some((n) => tail.includes(n)) : true;
    out.push({
      url,
      title: clean(t.label) || clean((body && body.title)) || url,
      kind: 'reply',
      fields: {
        type: 'reply', box: t.box, waitingOnUs: waiting,
        convo: convo.slice(0, 2000),
        heads: (body && body.heads) || [],
      },
    });
  }

  for (const it of out) {
    try { feed.upsert(wid, it); } catch (e) { log(`[reply-watch] upsert: ${e.message}`); }
  }
  log(`[reply-watch] ${out.length} item(s): ${out.filter((x) => x.kind === 'reply').length} conversation(s), ${out.filter((x) => x.kind === 'offer').length} offer(s)`);
  return out;
}

module.exports = { tick, configFor, readOffers, readInbox, readThread, DEFAULTS };
