/**
 * READ CARDS, END TO END, against a real browser — the UI walk is the BASELINE.
 *
 * The fixture is an open, no-login site shaped like a real one (think a search page whose UI is a
 * client of its own JSON API): typing fires a suggest call and telemetry as well as the real search,
 * so picking the right request is a real decision, not a lone candidate.
 *
 * What this proves, in the order a card lives:
 *   1 BASELINE  a real UI walk (type, wait, read the rows off the screen) — timed, requests counted.
 *   2 LEARN     the pool's own recorder hook (pool.attachRecorder) hears the walk; finishRead picks the
 *               request whose answer reproduces the rows the UI showed — and not the suggest call.
 *   3 VERIFY    the card is replayed with the SAME input and must equal the UI baseline. Only then is
 *               it trusted (lastVerified) — nothing was re-fired, it is a GET.
 *   4 REPLAY    a NEW input goes through the card alone (one in-page fetch, no typing, no waiting) and
 *               is compared with a fresh UI walk for that same input.
 *   5 DRIFT     the site renames a field. The replay still answers 200 — and must be REFUSED, the card
 *               quarantined, the UI walk re-learns it, and the new card replays correctly again.
 *
 * Skips (not fails) with no launchable Chromium. GB_CHROMIUM=/path/to/chrome points it at one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeRecorder } from '../src/recorder.js';
import { attachRecorder } from '../src/pool.js';
import { attemptRead, IN_PAGE_FETCH } from '../src/replay.js';
import { planFor } from '../src/routecards.js';
import { due, shadowCheck } from '../src/cardshadow.js';
import { makeBookSite } from '../testbed/booksite.js';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* skip below */ }

let browser = null;
if (chromium) {
  const opts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] };
  try { browser = await chromium.launch(opts); }
  catch {
    try { if (process.env.GB_CHROMIUM) browser = await chromium.launch({ ...opts, executablePath: process.env.GB_CHROMIUM }); }
    catch (e) { console.warn(`[readcard.e2e] no launchable Chromium (${String(e.message).split('\n')[0]}) — skipping`); }
  }
}

describe.skipIf(!browser)('a read card, replayed, against the UI walk as baseline', () => {
  let site; let base; let context; let page; let session; const log = { info() {}, warn() {} };
  const requestsSeen = [];

  /** The UI WALK, exactly what an agent does: type, wait for the page to settle, read the screen. */
  async function uiWalk(query) {
    const before = requestsSeen.length; const t0 = Date.now();
    await page.fill('#q', '');
    await page.waitForTimeout(450);                    // let the cleared box's own search finish first
    const answered = page.waitForResponse((r) => /search\?query=/.test(r.url()) && r.url().includes('query=' + encodeURIComponent(query)));
    await page.fill('#q', query);
    await answered;                                    // the walk waits for the page's OWN answer, not for rows to merely exist
    await page.waitForTimeout(200);                    // …then lets the page paint it
    const rows = await page.$$eval('#results li.hit', (els) => els.map((e) => ({ title: e.querySelector('.t').textContent, by: e.querySelector('.by').textContent })));
    return { rows, ms: Date.now() - t0, requests: requestsSeen.length - before };
  }

  beforeAll(async () => {
    site = makeBookSite();
    base = await site.listen();
    context = await browser.newContext();
    page = await context.newPage();
    session = {};
    attachRecorder(context, session, makeRecorder, log);      // the pool's OWN hook, not a re-implementation
    context.on('request', (r) => requestsSeen.push(r.url()));
    await page.goto(base + '/');
  }, 60000);
  afterAll(async () => { if (browser) await browser.close(); if (site) await site.close(); });

  const inPage = (r) => page.evaluate(IN_PAGE_FETCH, r);
  const ensure = async (o) => { if (!page.url().startsWith(o)) await page.goto(o + '/'); };
  let card; const metrics = {};

  it('1-2 a UI walk is the baseline, and the card is the request that holds its rows (not the decoy)', async () => {
    session.recorder.armRead({ intent: 'books.search', origin: base });
    const ui = await uiWalk('ghost');
    expect(ui.rows.map((r) => r.title)).toEqual(['The Ghost in the Browser', 'Ghost Writers of the Web', 'Headless Ghosts', 'Ghost Town']);
    metrics.ui = ui;
    const out = session.recorder.finishRead({ uiRows: ui.rows, inputs: { query: 'ghost' }, now: 1 });
    expect(out.ok).toBe(true);
    expect(new URL(out.card.url).pathname).toBe('/api/search');           // not /api/suggest, not telemetry
    expect(out.card.auth).toBe('none');                                    // an open site: no token, still a card
    expect(out.card.urlSlots).toEqual([{ name: 'query', param: 'query' }]);
    expect(out.card.extract.fields).toEqual({ title: 'title', by: 'author' });
    expect(planFor(out.card).mode).toBe('ui');                             // learned, NOT yet trusted
    card = out.card; metrics.baseline = ui.rows;
  }, 30000);

  it('3 verified against the baseline: the replay equals what the UI read, then the card is trusted', async () => {
    const r = await attemptRead({ card, values: { query: 'ghost' }, runInPage: inPage, ensureOrigin: ensure, baseline: metrics.baseline, now: 2 });
    expect(r.done).toBe(true);
    expect(r.cmp.equal).toBe(true);
    card = r.card;
    expect(planFor(card).mode).toBe('fast');
  }, 30000);

  it('4 a NEW input goes through the card alone and equals a fresh UI walk for that input', async () => {
    const before = requestsSeen.length; const t0 = Date.now();
    const r = await attemptRead({ card, values: { query: 'browser' }, runInPage: inPage, ensureOrigin: ensure, now: 3 });
    const replayMs = Date.now() - t0; const replayRequests = requestsSeen.length - before;
    expect(r.done).toBe(true);
    const ui = await uiWalk('browser');                                    // the baseline for THIS input
    expect(r.rows).toEqual(ui.rows);
    expect(r.rows.length).toBe(4);
    expect(replayRequests).toBe(1);                                        // one request, no suggest, no telemetry
    expect(ui.requests).toBeGreaterThan(replayRequests);
    console.log(`\n  [read card vs UI baseline]  UI walk: ${ui.ms} ms, ${ui.requests} requests   ·   card replay: ${replayMs} ms, ${replayRequests} request   ·   rows equal: ${r.rows.length}/${ui.rows.length}\n`);
    card = r.card;
  }, 30000);

  it('5 drift: a renamed field answers 200 but is REFUSED, quarantined, re-learned by the UI, and replays again', async () => {
    site.mode.field = 'name';                                                         // the site changes shape under the card
    const bad = await attemptRead({ card, values: { query: 'ghost' }, runInPage: inPage, ensureOrigin: ensure, now: 4 });
    expect(bad.status).toBe(200);                                          // the API is up and happy…
    expect(bad.done).toBe(false);                                          // …and the card still refuses its answer
    expect(bad.healed).toBe(true);
    expect(bad.card.quarantined).toBe(true);
    expect(planFor(bad.card).mode).toBe('ui');

    await page.goto(base + '/');                                           // fall back to the UI, re-recording
    session.recorder.armRead({ intent: 'books.search', origin: base });
    const ui = await uiWalk('ghost');
    const out = session.recorder.finishRead({ uiRows: ui.rows, inputs: { query: 'ghost' }, now: 5 });
    expect(out.ok).toBe(true);
    expect(out.card.extract.fields.title).toBe('name');                    // learned the new shape
    const again = await attemptRead({ card: out.card, values: { query: 'ghost' }, runInPage: inPage, ensureOrigin: ensure, baseline: ui.rows, now: 6 });
    expect(again.done).toBe(true);
    const fresh = await attemptRead({ card: again.card, values: { query: 'browser' }, runInPage: inPage, ensureOrigin: ensure, now: 7 });
    expect(fresh.done).toBe(true);
    expect(fresh.rows.length).toBe(4);
  }, 45000);

  it('6 SHADOW: a card that still answers 200 with the right shape but stale data is caught by comparing with the UI, before any job trusts it', async () => {
    site.mode.apiVersion = 'v1'; site.mode.field = 'title';
    await page.goto(base + '/');
    session.recorder.armRead({ intent: 'books.search', origin: base });
    const ui0 = await uiWalk('ghost');
    let good = session.recorder.finishRead({ uiRows: ui0.rows, inputs: { query: 'ghost' }, now: 10 }).card;
    good = (await attemptRead({ card: good, values: { query: 'ghost' }, runInPage: inPage, ensureOrigin: ensure, baseline: ui0.rows, now: 11 })).card;
    expect(due(good, 12).due).toBe(true);                                   // never shadowed
    const walk = async (v) => (await uiWalk(v.query)).rows;

    const agree = await shadowCheck({ card: good, values: { query: 'browser' }, uiWalk: walk, runInPage: inPage, ensureOrigin: ensure, now: 20 * 3600e3 });
    expect(agree.verdict).toBe('agree');
    expect(agree.card.shadow.agree).toBe(1);
    expect(due(agree.card, 21 * 3600e3).due).toBe(false);                   // trust buys a longer gap

    site.mode.apiVersion = 'v2';                                                       // the site moves on; v1 goes stale but stays up
    await page.goto(base + '/');
    // WITHOUT a shadow check the card still passes its own steady-state test: right shape, status 200
    const blind = await attemptRead({ card: agree.card, values: { query: 'ghost' }, runInPage: inPage, ensureOrigin: ensure, now: 30 * 3600e3 });
    expect(blind.done).toBe(true);                                           // …which is exactly the silent failure
    expect(blind.rows.every((r) => r.by === 'unknown')).toBe(true);          // and the data is wrong

    const caught = await shadowCheck({ card: agree.card, values: { query: 'ghost' }, uiWalk: walk, runInPage: inPage, ensureOrigin: ensure, now: 40 * 3600e3 });
    expect(caught.verdict).toBe('drift');
    expect(caught.card.quarantined).toBe(true);
    expect(caught.diff.missing).toBeGreaterThan(0);
    expect(planFor(caught.card).mode).toBe('ui');                            // the next job walks the UI and re-learns
    expect(due(caught.card, 41 * 3600e3).due).toBe(false);                   // quarantined cards are not shadowed, they are re-learned
    site.mode.apiVersion = 'v1';
  }, 60000);

  it('a card never stores a value it did not need: no cookie or token text in the card', () => {
    expect(JSON.stringify(card)).not.toMatch(/cookie|bearer|set-cookie/i);
  });
});
