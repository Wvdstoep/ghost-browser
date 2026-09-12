'use strict';
/**
 * diagnostics.js — what the browser SAW that a screenshot cannot show.
 *
 * THE RUN THAT MADE THIS NECESSARY. A freshly built app was handed to QA. The owner opened the same
 * URL and watched it bounce: the landing page redirected to /login, over and over, so fast that the
 * form could not be filled in. The console said it in one line — `GET /api/… 401 (Unauthorized)` —
 * and the network tab showed the same request looping. QA saw none of that. All it had was `look`,
 * which caught a page mid-navigation and reported "0 things to click", fifty times. It could not
 * describe the bug because it could not perceive it, and the fixer it fed then spent 1.37M tokens
 * debugging the wrong layer.
 *
 * Playwright hands all of this over for free — console messages, uncaught page errors, failed
 * responses, and every frame navigation. Nothing was listening. Now something is.
 *
 * WHY THIS IS QA-ONLY (the owner's instruction, and the right call). These buffers capture whatever
 * a page logs — including, on a site the owner is signed into, tokens, ids and personal data that
 * end up in console noise. QA drives OUR OWN freshly built apps, where that risk does not exist and
 * the signal is the entire point. Every other role browses real accounts on real sites, so the tool
 * is not in their list and the buffer is not read for them. Capture is cheap and bounded; exposure
 * is what is scoped.
 */

const MAX = 120;              // per session, per kind — a loop must be visible without unbounded memory
const push = (arr, v) => { arr.push(v); if (arr.length > MAX) arr.shift(); };

/**
 * Start listening on a page. Idempotent per page: attaching twice would double every entry, and a
 * doubled count is worse than none when the whole point is counting repeats.
 */
function attach(page, session, log = console) {
  if (!page || !session || page.__diagAttached) return;
  page.__diagAttached = true;
  session.diag = session.diag || { console: [], errors: [], network: [], navigations: [] };
  const d = session.diag;
  const at = () => new Date().toISOString().slice(11, 19);

  try {
    page.on('console', (m) => {
      try {
        const type = m.type();
        if (type !== 'error' && type !== 'warning') return;   // info/debug is noise, not signal
        push(d.console, { at: at(), type, text: String(m.text()).slice(0, 400) });
      } catch { /* a message we cannot read is not worth failing over */ }
    });
    page.on('pageerror', (e) => push(d.errors, { at: at(), text: String((e && e.message) || e).slice(0, 400) }));
    page.on('response', (r) => {
      try {
        const st = r.status();
        if (st < 400) return;                                  // only what failed
        push(d.network, { at: at(), status: st, url: String(r.url()).slice(0, 300) });
      } catch { /* ignore */ }
    });
    page.on('framenavigated', (f) => {
      try { if (f === page.mainFrame()) push(d.navigations, { at: at(), url: String(f.url()).slice(0, 300) }); }
      catch { /* ignore */ }
    });
  } catch (e) { log.warn?.(`[diag] could not attach: ${e.message}`); }
}

/**
 * The one pattern a human spots instantly and an agent never will from a single look: the same page
 * being navigated to again and again. A redirect loop makes every other observation meaningless —
 * nothing renders, nothing is clickable, and no amount of retrying helps — so it is named first.
 */
function loopOf(navigations = []) {
  if (navigations.length < 6) return null;
  const recent = navigations.slice(-20).map((n) => String(n.url).split('?')[0]);
  const counts = {};
  for (const u of recent) counts[u] = (counts[u] || 0) + 1;
  const [worst, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
  if (!worst || n < 4) return null;
  const distinct = Object.keys(counts).length;
  return { url: worst, times: n, distinct, window: recent.length };
}

/** A short, human-readable account of what the page did — the thing a person would say out loud. */
function summarise(session) {
  const d = (session && session.diag) || { console: [], errors: [], network: [], navigations: [] };
  const out = [];
  const loop = loopOf(d.navigations);
  if (loop) {
    out.push(`REDIRECT LOOP: the page went to ${loop.url} ${loop.times} times in the last ${loop.window} navigations`
      + (loop.distinct <= 3 ? ` (bouncing between ${loop.distinct} addresses)` : '')
      + '. Nothing can be clicked or filled in while this is happening — this IS the bug, and every '
      + 'other symptom is downstream of it.');
  }
  if (d.errors.length) {
    out.push(`UNCAUGHT ERRORS (${d.errors.length}): ` + d.errors.slice(-3).map((e) => e.text).join(' | '));
  }
  const fails = d.network.slice(-8);
  if (fails.length) {
    const byStatus = {};
    for (const f of d.network) byStatus[f.status] = (byStatus[f.status] || 0) + 1;
    out.push('FAILED REQUESTS: ' + Object.entries(byStatus).map(([s, n]) => `${n}× ${s}`).join(', ')
      + ' — most recent: ' + fails.map((f) => `${f.status} ${f.url}`).slice(-3).join(' | '));
  }
  const errs = d.console.filter((c) => c.type === 'error').slice(-3);
  if (errs.length) out.push('CONSOLE ERRORS: ' + errs.map((c) => c.text).join(' | '));
  if (!out.length) return 'Nothing abnormal: no uncaught errors, no failed requests, no console errors, no redirect loop.';
  return out.join('\n');
}

/** Everything, for a report. Bounded by MAX per kind. */
function dump(session) {
  const d = (session && session.diag) || {};
  return {
    summary: summarise(session),
    loop: loopOf(d.navigations || []),
    errors: (d.errors || []).slice(-10),
    network: (d.network || []).slice(-15),
    console: (d.console || []).slice(-15),
    navigations: (d.navigations || []).slice(-20),
  };
}

/** Forget what was seen — called when a job ends, so one run never reads another's page. */
function clear(session) {
  if (session) session.diag = { console: [], errors: [], network: [], navigations: [] };
}

/**
 * CAN A STRANGER BEGIN? — the single question a smoke check answers.
 *
 * Kept here, next to the perception it reads, and kept PURE so it can be tested without a browser.
 * The bar is deliberately low: each of these means nobody who has never been here can start at all.
 * Anything subtler is QA's to find, and putting it here would only make this check expensive and
 * flaky, which is how a check stops being run.
 *
 * The wording matters as much as the rule. Whatever comes out of here is read by a FIXER, so each
 * line names the fault and its consequence for a visitor, never just a metric.
 */
function smokeVerdict({ loadError = null, dump = {}, textLength = null, clickable = null, settleMs = 6000 } = {}) {
  const problems = [];
  const errors = dump.errors || [];
  if (loadError) problems.push(`The page did not load: ${loadError}`);
  if (dump.loop) {
    problems.push(`REDIRECT LOOP: the page went to ${dump.loop.url} ${dump.loop.times} times in the last `
      + `${dump.loop.window} navigations. Nothing can be read, clicked or filled in while this is happening.`);
  }
  // Only worth saying when the page is not already looping — during a loop "nothing rendered" is a
  // symptom of the loop, and naming it separately sends a fixer after the wrong thing.
  /*
   * NOT MEASURED is not the same as MEASURED EMPTY, and conflating them is how a check starts
   * inventing faults. A page that refuses to answer `evaluate` — mid-navigation, or cross-origin —
   * leaves these null, and a null must produce silence, never a verdict of "blank".
   */
  const measured = Number.isFinite(textLength) && Number.isFinite(clickable);
  if (!loadError && !dump.loop && measured && textLength < 20 && clickable === 0) {
    problems.push('The page rendered NOTHING — no text and no controls at all after waiting '
      + `${Math.round(settleMs / 1000)}s. A visitor sees a blank screen.`);
  }
  if (errors.length) {
    problems.push(`${errors.length} uncaught JavaScript error(s), most recent: `
      + errors.slice(-2).map((e) => e.text).join(' | '));
  }
  return problems;
}

/**
 * IS THIS THE APP'S FAULT, OR THE GROUND IT STANDS ON?
 *
 * Found the first time the smoke check ran against a real deployed product: it came back
 * ERR_CERT_AUTHORITY_INVALID, because Traefik was serving its own default self-signed certificate
 * instead of the issued one. That IS a genuine "a stranger cannot begin" — a browser shows an
 * interstitial and nobody clicks past it — but no amount of application code can fix it, and a gate
 * that cannot tell the difference would have dispatched build after build against a certificate.
 *
 * The distinction is transport versus content. By the time smoke runs, the platform has already
 * confirmed every replica is ready, so a connection that cannot be established at all is about the
 * edge — DNS, TLS, routing — and not about anything the builder wrote. Everything the browser
 * reports AFTER a page loads (a redirect loop, a blank render, a thrown error) is the app's.
 *
 * Returns a plain explanation when it is the ground's fault, or null when it is the app's.
 */
const PLATFORM_FAULTS = [
  [/ERR_CERT_|ERR_SSL_|SSL_ERROR|ERR_BAD_SSL/i, 'the HTTPS certificate is not valid, so a browser refuses to show the site at all'],
  [/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION/i, 'the address does not resolve — DNS or the ingress route is not in place'],
  [/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/i, 'nothing accepted the connection at the public address, although the app itself is running'],
  [/ERR_CONNECTION_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_CHANGED/i, 'the public address could not be reached from outside'],
];

function platformFaultOf(loadError) {
  const s = String(loadError || '');
  if (!s) return null;
  for (const [re, why] of PLATFORM_FAULTS) if (re.test(s)) return why;
  return null;
}

module.exports = { attach, summarise, dump, clear, loopOf, smokeVerdict, platformFaultOf, MAX };
