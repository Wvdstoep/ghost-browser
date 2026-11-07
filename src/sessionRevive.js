'use strict';
/*
 * A SESSION THAT TIMED OUT COMES BACK WHEN IT IS USED AGAIN (2026-11-07).
 *
 * Measured over 40 hours of the platform's browser: 74 sessions closed for being idle, 0 crashes, 0
 * restarts. An AI working a Facebook page designs a picture, deploys a helper, waits for a certificate —
 * and comes back to "no such session". It took that for the browser restarting ("Ghost Browser herstart
 * steeds"), opened a new session, retyped a post twice, and lost a draft.
 *
 * Now the pool remembers, for a while, what an idle-closed session was (owner, profile, the page it was
 * on, the device it ran on), and the next call with that id reopens it under the SAME id: the profile's
 * logins are there (persistent profiles), the page is loaded again, a device session goes back to its
 * device. The reply says so (header X-GB-Revived), because what was typed but not saved is gone.
 */

function makeReviver({ pool, log = console, timeoutMs = 45000 }) {
  return async function revive(req, res, next) {
    const id = req.params && req.params.id;
    if (!id || pool.sessions.has(id)) return next();
    const owner = req.client && req.client.owner;
    const rest = pool.takeResting(id, owner);
    if (!rest) return next();   // the route answers its own "no such session"
    // Closing a session that already closed is done: no browser to open just to close it again.
    if (req.method === 'DELETE' && /^\/v1\/sessions\/[^/]+\/?$/.test(req.originalUrl.split('?')[0])) {
      return res.json({ closed: true, sessionId: id, note: 'it had already closed after inactivity' });
    }
    try {
      await pool.createSession({ owner, maxConcurrent: req.client.maxConcurrent, reserved: !!req.client.console, profile: rest.profile, id });
      const s = pool.get(id);
      if (rest.ring) s.ring = { ...rest.ring, elements: [] };
      else if (/^https?:\/\//i.test(rest.url || '') && s.page) {
        await s.page.goto(rest.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
      }
      log.info?.(`[pool] ~ ${id} reopened after ${Math.round((Date.now() - rest.closedAt) / 60000)} min ${rest.why} (${rest.profile || 'no profile'}${rest.ring ? `, on ${rest.ring.name}` : ''})`);
      res.set('X-GB-Revived', encodeURIComponent(JSON.stringify({ url: rest.url || '', profile: rest.profile || null, onDevice: rest.ring ? rest.ring.name : null, closedMinutesAgo: Math.round((Date.now() - rest.closedAt) / 60000) })));
      return next();
    } catch (e) {
      log.warn?.(`[pool] ${id} could not be reopened: ${e.message}`);
      pool.putResting(id, rest);   // keep it for another try (e.g. the profile was busy)
      return res.status(e.status || 409).json({ error: `this session closed after inactivity and could not be reopened: ${e.message}`,
        hint: 'Open a new session with browser_open (same profile); its logins are kept.' });
    }
  };
}

/* The note an MCP client reads alongside the reply of a revived session. */
function revivedNote(header) {
  if (!header) return null;
  let r = {}; try { r = JSON.parse(decodeURIComponent(header)); } catch { /* still say it */ }
  return `Note: this session had closed after ${r.closedMinutesAgo ?? 'some'} minutes without use and was reopened with the same id`
    + `${r.profile ? ` in the "${r.profile}" profile (its logins are kept)` : ''}${r.onDevice ? ` on ${r.onDevice}` : ''}`
    + `${r.url ? `, back on ${r.url}` : ''}. The page was loaded again: anything typed or uploaded but not saved is gone — look at the page (browser_analyze or browser_screenshot) before continuing.`;
}

module.exports = { makeReviver, revivedNote };
