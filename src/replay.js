'use strict';
/**
 * replay.js — the REPLAY half of route cards, wired into a walk: execute a proven card as one in-page
 * fetch instead of the whole UI walk, read the verdict, and feed the heal state machine.
 *
 * This is the thin, testable seam between the pure card logic (routecards.js: buildReplay/afterReplay)
 * and the live browser (agent.js supplies `runInPage`, which runs the fetch inside the logged-in page).
 * Keeping it here — with `runInPage` and `ensureOrigin` INJECTED — means the whole decision can be unit
 * tested against a fake page, and the one live edge (a real in-page fetch) is proven by replay.e2e.
 *
 * THE RULES IT ENFORCES, all from Carla:
 *  · a card that cannot be rebuilt from the values at hand is NOT a failure — it just isn't replayable
 *    here (a fingerprinted body whose fields the caller can't supply), so fall to the UI without
 *    quarantining a card that never actually ran.
 *  · a replay is a SUCCESS only if the API answered 2xx; anything else — a bad status, a thrown fetch,
 *    no response — is a failure that quarantines the card and returns to the UI, which re-records it.
 *  · one failure is enough: afterReplay quarantines on the spot, because a stale internal API doing the
 *    wrong thing silently is the expensive error this whole mechanism must never cause.
 */

const { buildReplay, afterReplay } = require('./routecards');

/**
 * Attempt one replay of `card` with `values` (the payload slots the caller supplies — e.g. the new
 * page's name, or a post's text). Returns a plain verdict the agent acts on:
 *   { done, healed, card, reason, status }
 *   · done:true   → the act was replayed and verified; skip the UI walk. `card` is the raised card.
 *   · healed:true → the replay ran and failed; `card` is quarantined; walk the UI (which re-records).
 *   · neither     → nothing ran (couldn't rebuild); walk the UI; the card is unchanged.
 *
 * `runInPage(replay)` runs the fetch inside the page and returns { status, ok, text? } (or throws).
 * `ensureOrigin(origin)` makes the page sit on the card's origin first, so the fetch carries the
 * logged-in session — only called once we know the card actually builds, never speculatively.
 */
async function attemptReplay({ card, values = {}, runInPage, ensureOrigin = null, now = 0 }) {
  const replay = buildReplay(card, values);
  if (!replay) {
    return {
      done: false, healed: false, card, status: null,
      reason: 'the card cannot be rebuilt from the values at hand (a body field the caller does not supply) — walking the UI',
    };
  }

  if (ensureOrigin) {
    try { await ensureOrigin(card.origin); }
    catch (e) {
      // Could not even get onto the origin to run the fetch. Not the card's fault — do not quarantine
      // a card that never ran; just walk the UI.
      return { done: false, healed: false, card, status: null, reason: `could not reach ${card.origin} to replay (${e && e.message || e}) — walking the UI` };
    }
  }

  let result;
  try { result = await runInPage(replay); }
  catch (e) { result = { status: 0, ok: false, error: String((e && e.message) || e) }; }

  const status = result && typeof result.status === 'number' ? result.status : 0;
  const ok = status >= 200 && status < 300;
  const outcome = afterReplay(card, { ok, now });

  return ok
    ? { done: true, healed: false, card: outcome.card, status,
        reason: `replayed the card straight to the API — it answered ${status}, no UI walk needed` }
    : { done: false, healed: true, card: outcome.card, status,
        reason: `replay did not verify (${status || (result && result.error) || 'no response'}) — card quarantined, walking the UI to re-record` };
}

/**
 * THE IN-PAGE FETCH, as a function serialised into page.evaluate() by the agent. It re-reads the live
 * auth token from where the card said it lives (a hidden input, a meta tag, or a cookie — best-effort
 * and generic, since a token's DOM home is platform-shaped) and NEVER uses a captured one, then fires
 * the fetch same-origin with the session's cookies. Returned as a source string so the agent can hand
 * it to page.evaluate without bundling; kept beside attemptReplay so the two read as one mechanism.
 *
 * Pure of Node — it runs in the browser. Exported for the agent to inject and for a test to read.
 */
const IN_PAGE_FETCH = async (r) => {
  function liveToken(name) {
    try {
      const inp = document.querySelector(`input[name="${name}"]`);
      if (inp && inp.value) return inp.value;
      const meta = document.querySelector(`meta[name="${name}"]`);
      if (meta && meta.content) return meta.content;
      const esc = name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
      const m = document.cookie.match(new RegExp('(?:^|; )' + esc + '=([^;]*)'));
      if (m) return decodeURIComponent(m[1]);
    } catch (e) { /* a token we cannot read just stays absent — the API refuses, and heal takes over */ }
    return null;
  }
  const headers = {};
  for (const a of (r.authAt || [])) if (a.in === 'header') { const t = liveToken(a.name); if (t) headers[a.name] = t; }
  let body;
  if (r.bodyKind === 'json') {
    const obj = { ...(r.values || {}) };
    for (const a of (r.authAt || [])) if (a.in === 'body') { const t = liveToken(a.name); if (t != null) obj[a.name] = t; }
    headers['content-type'] = 'application/json';
    body = JSON.stringify(obj);
  } else if (r.bodyKind === 'form') {
    const p = new URLSearchParams();
    for (const k of Object.keys(r.values || {})) p.set(k, r.values[k]);
    for (const a of (r.authAt || [])) if (a.in === 'body') { const t = liveToken(a.name); if (t != null) p.set(a.name, t); }
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = p.toString();
  }
  try {
    const resp = await fetch(r.url, { method: r.method, headers, body, credentials: 'include' });
    let text = ''; try { text = await resp.text(); } catch (e) { /* a body we cannot read is fine; the status is the verdict */ }
    return { status: resp.status, ok: resp.ok, text: String(text).slice(0, 300) };
  } catch (e) {
    return { status: 0, ok: false, error: String((e && e.message) || e) };
  }
};

module.exports = { attemptReplay, IN_PAGE_FETCH };
