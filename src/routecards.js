'use strict';
/**
 * routecards.js — the browser learns the API it was using all along.
 *
 * Every platform's web UI is a client of an internal API: each click the browser makes fires the
 * requests the page's own JavaScript sends. The GB is a real Chromium, so that traffic already
 * flows through it — this module stops throwing the knowledge away. A long UI walk is recorded, the
 * traffic distilled into a ROUTE CARD per intent, and the next time that intent is asked the card
 * is REPLAYED as an in-page fetch inside the logged-in session: forty clicks become two requests.
 *
 * FIVE DISCIPLINES, each earned rather than assumed:
 *  1 RECORD  — capture requests the page made; nothing new is sent, so recording is free and safe.
 *  2 DISTILL — one card per intent: method, URL template, which fields are slots, where the auth
 *              token lives (a header/cookie present on the request), what a success looked like.
 *  3 REPLAY  — execute the card as a fetch in the page context; same origin, same cookies, no clicks.
 *  4 VERIFY  — read the result back; an unverified replay is a FAILURE, never a success.
 *  5 HEAL    — a failed card is quarantined on the spot and the job falls back to the UI path with
 *              the recorder on, which re-learns it. The UI path is never deleted — it is the ground
 *              truth the fast path is measured against.
 *
 * This file is PURE (no Playwright, no fs, no network) so every discipline is unit-tested. The pool
 * feeds it captured requests; the agent asks it for a plan; a store persists the cards. It holds no
 * token VALUES — only where a token LIVES — so a leak of the card store is not a leak of a session.
 */

/* Requests worth learning from: the page's own API calls, not its chrome. */
const IGNORE_EXT = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|woff2?|ico|map|mp4|woff|ttf)(\?|$)/i;
const IGNORE_HOST = /(google-analytics|googletagmanager|doubleclick|facebook\.com\/tr|sentry|datadog|hotjar|segment|mixpanel)/i;
const AUTH_HEADERS = ['authorization', 'x-csrf-token', 'x-csrftoken', 'x-xsrf-token', 'fb-dtsg', 'x-fb-lsd', 'x-li-lsd', 'csrf-token'];

/** Is this a request a card could be built from? POST/PUT/PATCH to an API-ish URL, same-ish origin. */
function isLearnable(req) {
  if (!req || !req.url) return false;
  const method = String(req.method || 'GET').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;   // reads are not the acts we replay
  if (IGNORE_EXT.test(req.url) || IGNORE_HOST.test(req.url)) return false;
  return true;
}

/** The origin of a URL, or '' if unparseable — cards are keyed and fenced by origin. */
function originOf(url) {
  const m = /^(https?:\/\/[^/]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * Turn a captured request into the SHAPE a card stores — never the values. The body's keys become
 * slots; where an auth token sits is remembered by NAME, so replay can re-read the live one from
 * the same place rather than reusing a captured (and by then expired) value.
 */
function shapeOf(req) {
  const headers = req.headers || {};
  const authAt = [];
  for (const h of AUTH_HEADERS) if (headers[h] || headers[h.toLowerCase()]) authAt.push({ in: 'header', name: h });
  let bodyKind = 'none'; let slots = [];
  const raw = req.postData || req.body || '';
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') { bodyKind = 'json'; slots = Object.keys(j); }
    } catch {
      if (/=/.test(raw) && /&|=/.test(raw)) {
        bodyKind = 'form';
        slots = [...raw.matchAll(/(^|&)([^=&]+)=/g)].map((m) => decodeURIComponent(m[2]));
      }
    }
    // A body often carries the csrf/anti-forgery token as a field — that is an auth-at too, whether
    // the body is JSON or a form. Replay re-reads its live value from the page, never the captured one.
    for (const s of slots) if (/csrf|token|lsd|dtsg|jazoest/i.test(s)) authAt.push({ in: 'body', name: s });
  }
  return {
    method: String(req.method || 'POST').toUpperCase(),
    url: String(req.url),
    origin: originOf(req.url),
    bodyKind,
    slots,
    authAt: dedupeAuth(authAt),
  };
}

function dedupeAuth(list) {
  const seen = new Set(); const out = [];
  for (const a of list) { const k = a.in + ':' + a.name.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(a); } }
  return out;
}

/**
 * DISTILL — from a walk's captured requests + the intent it accomplished, pick the ONE request that
 * IS the act and build a card.
 *
 * WHICH REQUEST IS THE ACT. When the walk SEALED its decisive act (the agent calls recorder.seal()
 * the instant it executes the approved create/post), `sealIndex` marks the slot that act's own
 * request lands in — so the act is the FIRST learnable write at or after the seal, and everything the
 * walk did afterward (navigating to find the new page's URL, dismissing a tour) is correctly ignored.
 * Without a seal we fall back to the old heuristic — the LAST learnable write — which is right for a
 * simple operate walk whose final action IS the act, but wrong for a setup walk that keeps going.
 * Either way VERIFY (step 4, live) is what actually proves the card; distillation only proposes.
 */
function distill({ intent, origin, requests = [], now = 0, sealIndex = null }) {
  const learnable = requests.filter(isLearnable).filter((r) => !origin || originOf(r.url) === origin);
  if (!learnable.length) return null;
  const act = (sealIndex != null && sealIndex >= 0 && sealIndex < learnable.length)
    ? learnable[sealIndex]                    // the write the sealed act fired — not the last navigation
    : learnable[learnable.length - 1];
  const shape = shapeOf(act);
  if (!shape.authAt.length) {
    // No auth marker on the act means replay would fire unauthenticated — a card that cannot carry
    // the session is worse than none, because it would 401 every time and look like a dead API.
    return { ok: false, reason: 'no auth token found on the act request — cannot replay authenticated' };
  }
  return {
    ok: true,
    card: {
      intent, origin: shape.origin,
      method: shape.method, url: shape.url,
      bodyKind: shape.bodyKind, slots: shape.slots, authAt: shape.authAt,
      confidence: 0,            // earned by VERIFY, not granted by DISTILL
      lastVerified: null,
      learnedAt: now,
      fails: 0,
      quarantined: false,
    },
  };
}

/**
 * The PLAN a caller gets when it asks to do an intent: replay a verified card, or walk the UI.
 * A card is only offered when it is not quarantined AND has been verified at least once — an
 * unproven card never displaces the UI path, it only rides ALONGSIDE a UI walk to be verified.
 */
function planFor(card) {
  if (!card) return { mode: 'ui', reason: 'no card for this intent — walk the UI (and record)' };
  if (card.quarantined) return { mode: 'ui', reason: 'card quarantined after a failure — walk the UI (and re-record)' };
  if (!card.lastVerified) return { mode: 'ui', reason: 'card not yet verified — walk the UI and verify it in passing' };
  return { mode: 'fast', card, reason: `replaying verified card (confidence ${card.confidence})` };
}

/** After a REPLAY that was verified live: raise confidence, clear the fail streak, stamp the time. */
function onVerified(card, now = 0) {
  return { ...card, lastVerified: now, confidence: Math.min(5, (card.confidence || 0) + 1), fails: 0, quarantined: false };
}

/**
 * After a REPLAY that FAILED (bad status, or VERIFY could not confirm the effect): quarantine the
 * card so the very next attempt goes to the UI — one failure is enough, because a stale internal
 * API silently doing the wrong thing is the expensive error this whole mechanism must not cause.
 * The card is not deleted: the UI re-record overwrites it, and until then its shape is a useful
 * starting point for the recorder.
 */
function onFailed(card, now = 0) {
  return { ...card, fails: (card.fails || 0) + 1, quarantined: true, confidence: Math.max(0, (card.confidence || 0) - 2), lastFailedAt: now };
}

/**
 * BUILD THE REPLAY REQUEST from a verified card + the slot values for this act (e.g. {message: "..."}).
 * Returns what an in-page fetch needs: url, method, and a body built from the card's shape. The auth
 * token is NOT here — it is re-read live from where the card says it lives, INSIDE the page context,
 * so replay never carries a captured (expired) token and this pure function never touches a secret.
 * Returns null if a required slot has no value — a replay with a missing field would post a blank.
 */
function buildReplay(card, values = {}) {
  if (!card || !card.url || !card.method) return null;
  // Every non-auth slot must be supplied — the auth-at fields are filled live in the page, not here.
  const authNames = new Set((card.authAt || []).filter((a) => a.in === 'body').map((a) => a.name));
  const need = (card.slots || []).filter((s) => !authNames.has(s));
  for (const s of need) if (values[s] == null) return null;
  return {
    url: card.url,
    method: card.method,
    bodyKind: card.bodyKind,
    slots: card.slots || [],
    authAt: card.authAt || [],
    values,            // the caller's real field values; the page merges the live token in
  };
}

/**
 * THE REPLAY OUTCOME, applied to a card. `ok` true after VERIFY confirmed the act's effect live →
 * onVerified; anything else (bad status, or verify could not confirm) → onFailed, which quarantines.
 * This is where Carla's rule is enforced by shape: a failed replay ALWAYS returns { fallback: 'ui' },
 * so the caller retries the SAME job by UI in the same run — and because the UI walk re-records, the
 * card is re-learned. Success returns { fallback: null }.
 */
function afterReplay(card, { ok, now = 0 } = {}) {
  return ok
    ? { card: onVerified(card, now), fallback: null }
    : { card: onFailed(card, now), fallback: 'ui' };
}

/** The card key: one card per (origin, intent). Intents are the caller's vocabulary, e.g. facebook.page.post. */
const cardKey = (origin, intent) => `${origin}::${intent}`;

/** A url without its query or fragment: the part that says WHICH request, not which session. */
const pathOf = (u) => String(u == null ? '' : u).split('?')[0].split('#')[0];

/** The same request said twice: same door, same method, same body shape, same fields, same auth places. */
function sameShape(a, b) {
  if (!a || !b) return false;
  if (String(a.origin) !== String(b.origin)) return false;
  if (String(a.method) !== String(b.method)) return false;
  if (pathOf(a.url) !== pathOf(b.url)) return false;
  if (String(a.bodyKind) !== String(b.bodyKind)) return false;
  const fields = (l) => (l || []).map(String).sort().join('|');
  if (fields(a.slots) !== fields(b.slots)) return false;
  const auth = (l) => (l || []).map((x) => x.in + ':' + String(x.name).toLowerCase()).sort().join('|');
  return auth(a.authAt) === auth(b.authAt);
}

/**
 * WHAT A FRESH RECORDING MEANS FOR THE CARD WE ALREADY HAD — the step this file promised and never had.
 *
 * The comment on planFor says an unproven card "only rides ALONGSIDE a UI walk to be verified". That
 * ride was never implemented, and the result was a closed loop: lastVerified was set only after a
 * successful replay, and a replay was only attempted for a card that already had lastVerified. So the
 * fast path could never open for any platform. Live proof: three Herald cards recorded from real acts,
 * all still at confidence 0, none ever quarantined, none ever replayed.
 *
 * A UI walk that just completed the act IS the ride. If the request it actually made matches the shape
 * the stored card predicted, that card is CONFIRMED BY OBSERVATION. Nothing is re-fired — re-firing a
 * create to prove a card is exactly the destructive act this design refuses, and it still refuses it.
 *
 * The rules, in order:
 *   nothing stored yet     keep the fresh card, untrusted. One sighting is not a promise.
 *   shape matches          promote the stored card: the second sighting of the same request.
 *   shape differs          the site changed. Keep the fresh card, untrusted, trust reset.
 *   stored is quarantined  a replay of it once failed, so one match is not enough: lift the quarantine
 *                          and stay untrusted, needing one more clean sighting before it may replay.
 *
 * On a match the newest url is adopted while the earned trust is kept, because a url's query can carry
 * a per-session id that changes between runs even though the request is the same one.
 */
function learnFrom(existing, fresh, now = 0) {
  if (!fresh) return { card: null, promoted: false, reason: 'nothing was recorded' };
  if (!existing) return { card: fresh, promoted: false, reason: 'first sighting of this act — recorded, not yet trusted' };
  if (!sameShape(existing, fresh)) {
    return { card: fresh, promoted: false, reason: 'the request changed shape since last time — recorded afresh, trust reset' };
  }
  const merged = { ...existing, url: fresh.url };
  if (existing.quarantined) {
    return {
      card: { ...merged, quarantined: false, fails: 0, lastVerified: null },
      promoted: false,
      reason: 'matches again after a failed replay — quarantine lifted, one more clean sighting before it may replay',
    };
  }
  const card = onVerified(merged, now);
  return { card, promoted: true, reason: 'confirmed by watching the UI walk make the same request (confidence ' + card.confidence + ')' };
}

module.exports = {
  isLearnable, originOf, shapeOf, distill, planFor, onVerified, onFailed, buildReplay, afterReplay, cardKey,
  learnFrom, sameShape, pathOf,
  AUTH_HEADERS, IGNORE_EXT, IGNORE_HOST,
};
