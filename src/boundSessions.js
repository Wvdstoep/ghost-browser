'use strict';
/**
 * boundSessions.js — notice a site whose sessions only work on the device that made them.
 *
 * Device Bound Session Credentials (and anything shaped like them) make the session cookie short
 * lived and refreshable only by a signed proof from a key that never leaves the device. Two things in
 * this codebase quietly assume the opposite:
 *
 *   sessionVault   saves the cookie jar and puts it back after a restart. A bound cookie is dead
 *                  within minutes, so restoring it "restores" a signed-out state and stores
 *                  credential material that is worth nothing and risks plenty.
 *   the cluster    treats any logged-in profile as runnable anywhere it can reach.
 *
 * The site announces binding itself: a response carrying `Secure-Session-Registration` (the
 * registration the browser answers by generating the key). Seeing that header on a host is the
 * signal. The host is then recorded in siteWalls with reason 'bound', which is the channel routing
 * already reads: the work goes to the device that holds the login, and the vault leaves the host's
 * cookies alone.
 *
 * Header names follow the DBSC proposal as published; if a deployment names them differently the
 * detector simply never fires and nothing changes from today.
 */

const REGISTRATION = 'secure-session-registration';
const seen = new Set();                       // hosts already recorded this process: one write per host, not per response

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; } };

/** Does this response header set announce a bound session? Pure. */
function announces(headers) {
  if (!headers) return false;
  for (const k of Object.keys(headers)) if (k.toLowerCase() === REGISTRATION) return !!headers[k];
  return false;
}

/** Record a host as bound. Returns the record, or null if it was already known. */
function mark(host, evidence = '', walls = require('./siteWalls')) {
  if (!host || seen.has(host)) return null;
  seen.add(host);
  return walls.record(host, {
    reason: 'bound',
    why: 'this site binds its session to a key held on the device that signed in, so a copied session does not work anywhere else',
    evidence: String(evidence).slice(0, 200),
  });
}

/** Is this host's session device-bound? */
function isBound(host, walls = require('./siteWalls')) {
  try { return walls.reasonFor(host) === 'bound'; } catch { return false; }
}

/** Listen on a browser context. Cheap: one header lookup per response, a write only the first time a host announces. */
function watch(context, { log = console } = {}) {
  if (!context || typeof context.on !== 'function') return;
  context.on('response', (res) => {
    try {
      const h = res.headers();
      if (!announces(h)) return;
      const host = hostOf(res.url());
      const rec = mark(host, h[REGISTRATION]);
      if (rec) log.info?.(`[bound] ${host} binds its sessions to the device — routing it to the device that holds the login, and the vault will not copy its cookies`);
    } catch { /* a response we cannot read is not worth failing a page over */ }
  });
}

/** Drop the cookies of hosts that are device-bound: they cannot be saved or restored usefully. */
function withoutBound(cookies, walls = require('./siteWalls')) {
  return (cookies || []).filter((c) => {
    const h = String((c && c.domain) || '').replace(/^\./, '').toLowerCase();
    return !(h && isBound(h, walls));
  });
}

module.exports = { announces, mark, isBound, watch, withoutBound, REGISTRATION, _forget: () => seen.clear() };
