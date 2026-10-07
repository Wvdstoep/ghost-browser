'use strict';
/**
 * readcardRoutes.js — read cards over the session API, so any client can use them.
 *
 *   POST /v1/sessions/:id/readcard/arm     { intent }                     start listening to the page's own data requests
 *   POST /v1/sessions/:id/readcard/learn   { uiRows, inputs, verify? }    the UI walk's rows → the card that explains them
 *   POST /v1/sessions/:id/readcard/replay  { intent, values }             answer from the card alone, or say "walk the UI"
 *   POST /v1/sessions/:id/readcard/shadow  { intent, values, uiRows, uiRowsRepeat? }   check a trusted card against the UI
 *   GET  /v1/readcards                                                      what has been learned (shapes only)
 *
 * The client does the UI walk (an agent, a script, a person) and tells us what it READ; the card is
 * the request that explains it. That keeps the baseline honest: it is what a real walk saw, not
 * something this module made up. Cards are stored beside the write cards, keyed by (origin, intent).
 *
 * Kept out of server.js on purpose: it takes everything it needs as arguments, so it is tested
 * against a real browser without booting the whole server.
 */

const routecards = require('./routecards');
const replay = require('./replay');
const shadow = require('./cardshadow');

const summary = (c) => c && ({
  intent: c.intent, origin: c.origin, kind: c.kind || 'write', url: c.url, slots: c.slots, columns: c.columns,
  auth: c.auth, confidence: c.confidence, lastVerified: c.lastVerified, quarantined: c.quarantined, fails: c.fails,
  shadow: c.shadow ? { checks: c.shadow.checks, agree: c.shadow.agree, flaky: c.shadow.flaky, drift: c.shadow.drift, suspect: c.shadow.suspect } : null,
});

const rowsOk = (rows) => Array.isArray(rows) && rows.length > 0 && rows.every((r) => r && typeof r === 'object' && !Array.isArray(r));

function mountReadCardRoutes(app, { mine, store, fail, log = console, authed = (_q, _s, n) => n() }) {
  const runIn = (s) => (r) => s.page.evaluate(replay.IN_PAGE_FETCH, r);
  const ensure = (s) => async (origin) => { if (routecards.originOf(s.page.url()) !== origin) await s.page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 45000 }); };

  app.post('/v1/sessions/:id/readcard/arm', (req, res) => {
    try {
      const s = mine(req);
      const intent = String((req.body && req.body.intent) || '').trim();
      if (!intent) return res.status(400).json({ error: 'say what you are reading: an intent such as "books.search"' });
      if (!s.recorder) return res.status(409).json({ error: 'this session cannot record' });
      const origin = routecards.originOf(s.page.url());
      s.recorder.armRead({ intent, origin });
      res.json({ ok: true, intent, origin, next: 'do the UI walk, then POST readcard/learn with the rows you read' });
    } catch (e) { fail(res, e); }
  });

  app.post('/v1/sessions/:id/readcard/learn', async (req, res) => {
    try {
      const s = mine(req);
      const { uiRows, inputs = {}, verify = true } = req.body || {};
      if (!rowsOk(uiRows)) return res.status(400).json({ error: 'uiRows must be the rows the UI showed: a non-empty list of {column: text}' });
      if (!s.recorder || !s.recorder.armedRead) return res.status(409).json({ error: 'not armed: POST readcard/arm before the UI walk' });
      const out = s.recorder.finishRead({ uiRows, inputs, now: Date.now() });
      if (!out || !out.ok) return res.status(422).json({ learned: false, reason: out ? out.reason : 'nothing was recorded' });
      let card = out.card; let verified = false; let why = 'recorded, not yet trusted';
      if (verify) {
        // the card has never run: prove it against the walk that just happened, with the same inputs.
        const r = await replay.attemptRead({ card, values: inputs, runInPage: runIn(s), ensureOrigin: ensure(s), baseline: uiRows, now: Date.now() });
        card = r.card; verified = !!r.done; why = r.reason;
      }
      store.put(card);
      log.info?.(`[readcard] ${card.intent} @ ${card.origin}: ${verified ? 'learned and verified' : 'learned, not verified'}`);
      res.json({ learned: true, verified, reason: why, coverage: out.coverage, card: summary(card) });
    } catch (e) { fail(res, e); }
  });

  app.post('/v1/sessions/:id/readcard/replay', async (req, res) => {
    try {
      const s = mine(req);
      const { intent, values = {} } = req.body || {};
      const card = store.findByIntent(String(intent || ''));
      if (!card || card.kind !== 'read') return res.json({ mode: 'ui', reason: 'no read card for this intent: walk the UI and learn one' });
      const plan = routecards.planFor(card);
      if (plan.mode !== 'fast') return res.json({ mode: 'ui', reason: plan.reason, card: summary(card) });
      const r = await replay.attemptRead({ card: plan.card, values, runInPage: runIn(s), ensureOrigin: ensure(s), now: Date.now() });
      if (r.card) store.put({ ...r.card, shadow: card.shadow });                 // keep the shadow ledger across a replay
      if (!r.done) return res.json({ mode: 'ui', reason: r.reason, quarantined: !!(r.card && r.card.quarantined) });
      const due = shadow.due(r.card);
      res.json({ mode: 'card', rows: r.rows, status: r.status, reason: r.reason, shadowDue: due.due ? due.why : null });
    } catch (e) { fail(res, e); }
  });

  app.post('/v1/sessions/:id/readcard/shadow', async (req, res) => {
    try {
      const s = mine(req);
      const { intent, values = {}, uiRows, uiRowsRepeat } = req.body || {};
      const card = store.findByIntent(String(intent || ''));
      if (!card || card.kind !== 'read') return res.status(404).json({ error: 'no read card for this intent' });
      if (!rowsOk(uiRows)) return res.status(400).json({ error: 'uiRows: what a UI walk read for these values, right now' });
      const walks = [uiRows, uiRowsRepeat].filter(Boolean);
      let i = 0;
      const out = await shadow.shadowCheck({
        card, values, runInPage: runIn(s), ensureOrigin: ensure(s), now: Date.now(),
        uiWalk: async () => walks[Math.min(i++, walks.length - 1)],            // no repeat given: the same walk answers again
      });
      store.put(out.card);
      res.json({ verdict: out.verdict, reason: out.reason, diff: out.diff || null, card: summary(out.card),
        advice: out.verdict === 'drift' ? 'card quarantined: walk the UI and POST readcard/learn to re-learn it'
          : out.verdict === 'flaky' ? 'live data moved between reads; the card is kept and will be checked on every use' : null });
    } catch (e) { fail(res, e); }
  });

  app.get('/v1/readcards', authed, (_req, res) => {
    res.json({ cards: store.list().filter((c) => c && c.kind === 'read').map(summary) });
  });
}

module.exports = { mountReadCardRoutes, summary };
