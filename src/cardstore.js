'use strict';
/**
 * cardstore.js — where route cards live: beside the sessions, because a card is EXECUTION knowledge
 * (this browser learned this platform's API in this profile's session), not portable data. One JSON
 * file per store, keyed by (origin, intent). Best-effort by design — the cards make repeated work
 * cheap, so a store that will not load simply means every intent walks the UI, which is exactly
 * where things stand without this file at all.
 *
 * It persists SHAPES, never token values (routecards.shapeOf guarantees that upstream), so a leak of
 * this file is not a leak of a session. Visible in the GB UI so a person can watch what the browser
 * has learned and, if a platform changes, forget a card by hand.
 */

const fs = require('fs');
const path = require('path');
const { cardKey } = require('./routecards');

const DIR = process.env.CARD_DIR || process.env.PROFILE_DIR || '/profiles';
const FILE = 'route-cards.json';

function makeCardStore({ dir = DIR, file = FILE, log = console } = {}) {
  const full = path.join(dir, file);
  let cards = load();

  function load() {
    try { return JSON.parse(fs.readFileSync(full, 'utf8')) || {}; }
    catch { return {}; }   // no file yet, or unreadable — an empty store means "learn everything by UI"
  }

  function persist() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(full, JSON.stringify(cards, null, 2));
    } catch (e) { log.warn?.(`[cards] could not persist ${full}: ${e.message}`); }   // never fatal
  }

  return {
    _file: full,
    get(origin, intent) { return cards[cardKey(origin, intent)] || null; },
    /* Look a card up by INTENT alone, whichever origin it was learned on. Intents are namespaced per
       platform (herald.facebook.setup), so this is unambiguous — and it means a card learned on
       web.facebook.com is still found by a walk that thinks in www.facebook.com. The card carries its
       own origin, so the executor still hits exactly where it was recorded. */
    findByIntent(intent) {
      for (const c of Object.values(cards)) if (c && c.intent === intent && !c.quarantined) return c;
      for (const c of Object.values(cards)) if (c && c.intent === intent) return c;   // fall back to a quarantined one so planFor can report it
      return null;
    },
    put(card) {
      if (!card || !card.origin || !card.intent) return null;
      cards[cardKey(card.origin, card.intent)] = card;
      persist();
      return card;
    },
    forget(origin, intent) { delete cards[cardKey(origin, intent)]; persist(); },
    /** Everything learned, for the UI — shapes only, so this is safe to render. */
    list() { return Object.values(cards); },
    reload() { cards = load(); return this; },
  };
}

module.exports = { makeCardStore };
