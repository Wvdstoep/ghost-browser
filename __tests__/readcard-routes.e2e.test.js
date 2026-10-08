/**
 * Read cards through the session API, the way an MCP client or a script uses them: the CLIENT does the
 * UI walk and reports the rows it read; the server learns the card, proves it against that baseline,
 * answers later reads from it, and shadows it against a fresh walk. Real Chromium, real recorder hook,
 * real HTTP; the only stand-in is the auth/session lookup (the server's SSRF guard would refuse a
 * local fixture, which is the guard doing its job).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { makeRecorder } from '../src/recorder.js';
import { attachRecorder } from '../src/pool.js';
import { makeCardStore } from '../src/cardstore.js';
import { mountReadCardRoutes } from '../src/readcardRoutes.js';
import { makeBookSite } from '../testbed/booksite.js';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* skip */ }
let browser = null;
if (chromium) {
  const opts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] };
  try { browser = await chromium.launch(opts); }
  catch { try { if (process.env.GB_CHROMIUM) browser = await chromium.launch({ ...opts, executablePath: process.env.GB_CHROMIUM }); } catch { console.warn('[readcard-routes] no Chromium — skipping'); } }
}

describe.skipIf(!browser)('read cards over HTTP', () => {
  let site, siteBase, ctx, page, session, api, srv, dir, store; const log = { info() {}, warn() {} };
  const call = async (method, p, body) => { const r = await fetch(api + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };

  async function uiWalk(query) {
    await page.fill('#q', ''); await page.waitForTimeout(450);
    const answered = page.waitForResponse((r) => /search\?query=/.test(r.url()) && r.url().includes('query=' + encodeURIComponent(query)));
    await page.fill('#q', query); await answered; await page.waitForTimeout(200);
    return page.$$eval('#results li.hit', (els) => els.map((e) => ({ title: e.querySelector('.t').textContent, by: e.querySelector('.by').textContent })));
  }

  beforeAll(async () => {
    site = makeBookSite(); siteBase = await site.listen();
    ctx = await browser.newContext(); page = await ctx.newPage();
    session = { owner: 'o', page, context: ctx }; attachRecorder(ctx, session, makeRecorder, log);
    await page.goto(siteBase + '/');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-cards-')); store = makeCardStore({ dir, log });
    const app = express(); app.use(express.json());
    mountReadCardRoutes(app, { mine: () => session, store, fail: (res, e) => res.status(e.status || 500).json({ error: e.message }), log });
    await new Promise((r) => { srv = app.listen(0, '127.0.0.1', r); }); api = `http://127.0.0.1:${srv.address().port}`;
  }, 30000);
  afterAll(async () => { await browser.close(); srv.close(); await site.close(); });

  it('refuses nonsense before it does anything', async () => {
    expect((await call('POST', '/v1/sessions/x/readcard/arm', {})).status).toBe(400);
    expect((await call('POST', '/v1/sessions/x/readcard/learn', { uiRows: [{ a: 1 }] })).status).toBe(409);           // not armed
    await call('POST', '/v1/sessions/x/readcard/arm', { intent: 'books.search' });
    expect((await call('POST', '/v1/sessions/x/readcard/learn', { uiRows: [] })).status).toBe(400);
    expect((await call('POST', '/v1/sessions/x/readcard/learn', { uiRows: 'rows' })).status).toBe(400);
    session.recorder.discard();
  });

  it('with no card, replay says to walk the UI', async () => {
    const r = await call('POST', '/v1/sessions/x/readcard/replay', { intent: 'books.search', values: { query: 'ghost' } });
    expect(r.body.mode).toBe('ui');
  });

  it('arm → UI walk → learn: the card is proven against the walk that taught it', async () => {
    const a = await call('POST', '/v1/sessions/x/readcard/arm', { intent: 'books.search' });
    expect(a.body.origin).toBe(siteBase);
    const rows = await uiWalk('ghost');
    const l = await call('POST', '/v1/sessions/x/readcard/learn', { uiRows: rows, inputs: { query: 'ghost' } });
    expect(l.body).toMatchObject({ learned: true, verified: true });
    expect(l.body.card).toMatchObject({ kind: 'read', auth: 'none', slots: ['query'], columns: ['title', 'by'] });
    expect(l.body.card.lastVerified).toBeTruthy();
    expect(JSON.stringify(l.body)).not.toMatch(/cookie|bearer/i);
  }, 30000);

  it('replay answers a NEW input from the card alone, equal to a UI walk for that input', async () => {
    const before = site.hits.search;
    const r = await call('POST', '/v1/sessions/x/readcard/replay', { intent: 'books.search', values: { query: 'browser' } });
    expect(r.body.mode).toBe('card');
    expect(site.hits.search).toBe(before + 1);                                       // exactly one request
    const walked = await uiWalk('browser');
    expect(r.body.rows).toEqual(walked);
    expect(r.body.shadowDue).toBeTruthy();                                           // never shadowed yet: a check is due
  }, 30000);

  it('the card survives a restart: a fresh store on the same directory finds it', () => {
    const again = makeCardStore({ dir, log });
    expect(again.findByIntent('books.search')).toMatchObject({ kind: 'read', lastVerified: expect.any(Number) });
  });

  it('shadow agrees while the site is unchanged, then catches stale-but-200 data and quarantines', async () => {
    const rows = await uiWalk('ghost');
    const ok = await call('POST', '/v1/sessions/x/readcard/shadow', { intent: 'books.search', values: { query: 'ghost' }, uiRows: rows });
    expect(ok.body.verdict).toBe('agree');
    expect(ok.body.card.shadow.agree).toBe(1);

    site.mode.apiVersion = 'v2'; await page.goto(siteBase + '/');                     // v1 goes stale, still 200, same shape
    const blind = await call('POST', '/v1/sessions/x/readcard/replay', { intent: 'books.search', values: { query: 'ghost' } });
    expect(blind.body.mode).toBe('card');                                            // a plain replay cannot tell…
    expect(blind.body.rows.every((r) => r.by === 'unknown')).toBe(true);
    const fresh = await uiWalk('ghost');
    const caught = await call('POST', '/v1/sessions/x/readcard/shadow', { intent: 'books.search', values: { query: 'ghost' }, uiRows: fresh });
    expect(caught.body.verdict).toBe('drift');                                       // …the shadow check can
    expect(caught.body.card.quarantined).toBe(true);
    expect(caught.body.advice).toMatch(/re-learn/);
    const after = await call('POST', '/v1/sessions/x/readcard/replay', { intent: 'books.search', values: { query: 'ghost' } });
    expect(after.body.mode).toBe('ui');                                              // the next read walks the UI
  }, 60000);

  it('re-learning from a UI walk restores the fast path on the new shape', async () => {
    await call('POST', '/v1/sessions/x/readcard/arm', { intent: 'books.search' });
    const rows = await uiWalk('ghost');
    const l = await call('POST', '/v1/sessions/x/readcard/learn', { uiRows: rows, inputs: { query: 'ghost' } });
    expect(l.body.verified).toBe(true);
    const r = await call('POST', '/v1/sessions/x/readcard/replay', { intent: 'books.search', values: { query: 'browser' } });
    expect(r.body.mode).toBe('card');
    expect(r.body.rows.every((x) => x.by !== 'unknown')).toBe(true);
    expect((await call('GET', '/v1/readcards')).body.cards.map((c) => c.intent)).toEqual(['books.search']);
  }, 60000);
});
