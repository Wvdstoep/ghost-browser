'use strict';
/**
 * deviceThread.js — read a post and its comments ON THE DEVICE, from the cluster.
 *
 * WHY THE READER LIVES HERE AND NOT ON THE PHONE.
 *
 * The phone exposes a fixed set of routes (navigate / analyze / click / type / scroll / content /
 * screenshot) and each one calls a hardcoded `window.__gb.<fn>` baked into the APK's assets. There
 * is no eval. So every improvement to a page reader would otherwise mean building an APK, pushing
 * it, and installing it on the phone — for work that is inherently trial and error against a DOM
 * that changes without notice. One bad guess would cost a release.
 *
 * The routes that exist are enough. `analyze` returns every interactive element with its text, its
 * aria-label, its role and its HREF, and on LinkedIn a person's profile slug IS the href
 * (/in/<slug>). So the reader is cluster-side code driving the phone's hands, which is also exactly
 * Principle 1 of the ring: the device is eyes and hands, the cluster is the brain.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE. On LinkedIn's mobile web the comments frequently are not in the
 * document at all until something is pressed — "Load more comments", "Zobacz więcej komentarzy",
 * "Eerdere reacties". A reader that simply looks therefore reports a post with no replies, which is
 * indistinguishable from a post that genuinely has none. That is the failure mode this whole session
 * kept finding elsewhere, and on a reply desk it is the worst one: a silent zero means nobody wrote,
 * so nothing is ever drafted.
 *
 * So this presses first, bounded, and then always reports whether it pressed, how many times, and
 * what it saw. A zero that has looked is a fact. A zero that has not is a bug.
 */

/*
 * The controls that reveal comments, in the languages this account's LinkedIn renders in. DATA
 * rather than a regex in code, so another language is a line here and not a deploy of new logic.
 * Matched lowercase and loosely, because the count is usually inside the label ("12 more comments").
 */
const EXPAND_LABELS = [
  'load more comments', 'more comments', 'previous comments', 'show more comments',
  'zobacz więcej komentarzy', 'więcej komentarzy', 'wcześniejsze komentarze', 'pokaż komentarze',
  'meer reacties', 'eerdere reacties', 'reacties weergeven',
  'mehr kommentare', 'weitere kommentare',
];

/** A LinkedIn activity urn, which is the post's real identity and makes dedup exact. */
function urnOf(text) {
  const m = /urn:li:(?:activity|ugcPost):(\d+)/.exec(String(text || ''));
  return m ? m[0] : '';
}

/** The profile slug out of any LinkedIn person link. */
function slugOf(href) {
  const m = /\/in\/([^/?#]+)/.exec(String(href || ''));
  return m ? decodeURIComponent(m[1]).toLowerCase() : '';
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Does this element look like a control that reveals more comments?
 *
 * Kept separate and pure because it decides whether the reader presses anything at all, and a
 * reader that presses the wrong thing on a live logged-in account is worse than one that presses
 * nothing.
 */
function isExpander(el) {
  const hay = `${clean(el && el.text)} ${clean(el && el.label)}`.toLowerCase();
  if (!hay) return false;
  return EXPAND_LABELS.some((l) => hay.includes(l));
}

/**
 * Build the thread from one analyze payload plus the page's text.
 *
 * PURE ON PURPOSE. This is the half that gets the DOM wrong, so it has to be testable against a
 * recorded payload rather than only against a phone holding a live login.
 *
 * The people are taken from the profile links, in document order: on a post page the first such
 * link is the author and the rest are the commenters. Their text is NOT taken from the link (which
 * is just a name) but from the page text, because a comment's body is not inside its author link.
 */
function threadFrom(elements = [], pageText = '', url = '') {
  const els = Array.isArray(elements) ? elements : [];
  const people = [];
  const seen = new Set();
  for (const el of els) {
    const slug = slugOf(el && el.href);
    if (!slug || seen.has(slug)) continue;
    /* "miniprofile" and company links are not people in a thread. */
    if (/^(company|school|showcase)$/.test(slug)) continue;
    seen.add(slug);
    people.push({ slug, name: clean(el.text) || clean(el.label) || slug });
  }
  const expanders = els.filter(isExpander).map((el) => clean(el.text) || clean(el.label));
  const text = clean(pageText);
  return {
    url: String(url || ''),
    urn: urnOf(url) || urnOf(pageText),
    author: people[0] || null,
    /* Everyone who is not the author and appears on the page is a participant in the thread. The
       cluster decides who is worth replying to; this only reports who is there. */
    participants: people.slice(1),
    text: text.slice(0, 20000),
    chars: text.length,
    /* Reported so a caller can tell "nothing to expand" from "never tried". */
    expanders,
  };
}

/**
 * Read a post and its comments on the device.
 *
 * `run` is device-hub's runCommand. Nothing here touches a Playwright page: the phone is the only
 * browser involved, using its own login, fingerprint and residential IP, which is the entire reason
 * this runs there instead of on the cluster.
 */
async function readThread({ run, deviceId, profile, url, rounds = 3, settleMs = 2200, log = console } = {}) {
  if (typeof run !== 'function') throw new Error('readThread needs device-hub runCommand');
  if (!deviceId) throw new Error('readThread needs a deviceId');
  if (!url) throw new Error('readThread needs a post url');

  const call = async (path, body = {}) => {
    const r = await run(deviceId, { method: 'POST', path, body: { ...body, profile } }, 120000);
    return (r && r.result) || {};
  };
  const analyze = async () => {
    const r = await call('/v1/analyze');
    /* The phone answers analyze as the element array itself, or wrapped — accept both rather than
       assuming, because the wrapper has changed once already. */
    if (Array.isArray(r)) return r;
    if (Array.isArray(r.elements)) return r.elements;
    if (Array.isArray(r.result)) return r.result;
    return [];
  };
  const pageText = async () => {
    const r = await call('/v1/content');
    if (typeof r === 'string') return r;
    return String(r.text || r.content || '');
  };

  await call('/v1/navigate', { url });
  await new Promise((r) => setTimeout(r, settleMs));

  let pressed = 0;
  const pressedLabels = [];
  let els = await analyze();

  /*
   * PRESS BEFORE READING, and bound it. Each press is a round trip and a repaint on a phone, and an
   * unbounded loop on a feed that always offers "more" would never stop.
   */
  for (let i = 0; i < rounds; i += 1) {
    const idx = els.findIndex(isExpander);
    if (idx < 0) break;
    const label = clean(els[idx].text) || clean(els[idx].label);
    try {
      await call('/v1/click', { index: idx });
      pressed += 1;
      pressedLabels.push(label);
      log.info?.(`[thread] ${deviceId}: pressed "${label}" (${pressed}/${rounds})`);
    } catch (e) {
      log.warn?.(`[thread] ${deviceId}: could not press "${label}": ${e.message}`);
      break;
    }
    await new Promise((r) => setTimeout(r, settleMs));
    els = await analyze();
  }

  const text = await pageText();
  const thread = threadFrom(els, text, url);

  /*
   * THE HONEST REPORT. A reader that returns nothing has to say whether it looked, or a quiet day
   * and a broken selector are the same event — which is how a reply desk stops replying without
   * anybody noticing.
   */
  return {
    ...thread,
    read: true,
    pressed,
    pressedLabels,
    roundsAllowed: rounds,
    /* Still offering more after the last press: the thread is longer than what came back. */
    truncated: pressed >= rounds && els.some(isExpander),
    /* Nothing was pressed AND nothing offered to press: the page really had no more to give. */
    nothingToExpand: pressed === 0 && !thread.expanders.length,
    elements: els.length,
  };
}

module.exports = { readThread, threadFrom, isExpander, slugOf, urnOf, EXPAND_LABELS };
