/**
 * RECORD + REPLAY, END TO END, against a REAL browser.
 *
 * Every other route-card test is pure — it feeds hand-written request objects to the logic. This one
 * proves the live edge that pure tests cannot: that a real Chromium, driving a page that behaves like
 * a platform (a form whose JS POSTs to an internal API with a CSRF token), actually produces requests
 * the recorder captures, that distill finds the TRUE act among them, and that an in-page fetch built
 * from the learned card REALLY posts — same origin, same cookies, no clicks — and can be verified.
 *
 * The fixture is a local HTTP server standing in for a platform: GET / serves a "composer" page whose
 * button, when clicked, reads a CSRF token from the DOM and POSTs {message, csrf} to /api/post; the
 * server records the post and a later GET /api/posts proves it landed. This is exactly the shape of a
 * real platform's UI-over-internal-API, with none of the flakiness (or the ToS) of hitting one live.
 *
 * If Chromium cannot launch (a CI box with no browser), the whole file SKIPS rather than failing —
 * the pure suites already prove the logic; this proves the wiring where a browser exists.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { makeRecorder } from '../src/recorder.js';
import { distill, planFor, onVerified, buildReplay, afterReplay } from '../src/routecards.js';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* no playwright — skip below */ }

// ── the fixture platform ─────────────────────────────────────────────────────
const posts = [];
function fixtureServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.setHeader('content-type', 'text/html');
      return res.end(`<!doctype html><html><body>
        <input id="msg" value="">
        <div id="csrf" data-token="tok-${Date.now()}"></div>
        <button id="post">Post</button>
        <script>
          document.getElementById('post').addEventListener('click', async () => {
            const message = document.getElementById('msg').value;
            const csrf = document.getElementById('csrf').dataset.token;
            // the page fires analytics AND the real act — the recorder must pick the act
            navigator.sendBeacon && navigator.sendBeacon('/collect', 'x');
            await fetch('/api/post', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ message, csrf }) });
            document.title = 'posted';
          });
        </script>
      </body></html>`);
    }
    if (req.method === 'POST' && req.url === '/api/post') {
      let body = ''; req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        let j = {}; try { j = JSON.parse(body); } catch { /* ignore */ }
        // a real internal API checks the token; ours does too, so a tokenless replay is REFUSED
        if (!req.headers['x-csrf-token']) { res.statusCode = 403; return res.end('{"error":"no csrf"}'); }
        posts.push(j.message);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, id: posts.length }));
      });
    }
    if (req.method === 'POST' && req.url === '/collect') { res.statusCode = 204; return res.end(); }
    if (req.method === 'GET' && req.url === '/api/posts') {
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ posts }));
    }
    res.statusCode = 404; res.end('no');
  });
}

/*
 * The PACKAGE always imports — it is a dependency. The browser it drives lives in the image and not
 * in this checkout, so an environment without one is a skip, not a defect to report.
 *
 * ASK BY LAUNCHING, NOT BY LOOKING. This used to check `existsSync(chromium.executablePath())`,
 * which answers a different question than the one that matters: installing the Chromium build on a
 * host that lacks the shared libraries it links against put the file on disk and still died at
 * launch with exit 127, so the guard said yes and the suite failed anyway. Its sibling
 * postwatch-extract.test.js already probes by launching; this does the same, once, at module scope.
 */
let browser = null;
if (chromium) {
  try { browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] }); }
  catch (e) { browser = null; console.warn(`[replay.e2e] no launchable Chromium here (${String(e.message).split('\n')[0]}) — skipping; runs in the pod image / CI`); }
}

describe.skipIf(!browser)('record + replay against a real browser', () => {
  let server; let base;
  beforeAll(async () => {
    server = fixtureServer();
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  }, 60000);
  afterAll(async () => { if (browser) await browser.close(); if (server) await new Promise((r) => server.close(r)); });

  it('a real UI walk is recorded, distilled to the true act, and a replay fetch posts for real', async () => {
    const origin = base;   // http://127.0.0.1:PORT
    const context = await browser.newContext();
    const page = await context.newPage();

    // 1) RECORD — wire the recorder to the real request stream, exactly as the pool does.
    const recorder = makeRecorder({ log: { info() {}, warn() {} } });
    recorder.arm({ intent: 'fixture.post', origin });
    context.on('request', (req) => {
      recorder.observe({ method: req.method(), url: req.url(), headers: req.headers(), postData: req.postData() || '' });
    });

    // 2) DRIVE THE UI like the agent would — type, click, the page's own JS does the POST.
    await page.goto(base + '/');
    await page.fill('#msg', 'the FIRST post, sent by clicking');
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/post')),
      page.click('#post'),
    ]);
    expect(posts).toContain('the FIRST post, sent by clicking');   // the UI walk really posted

    // 3) DISTILL — the recorder learned the act (not the /collect beacon, not the GET).
    const out = recorder.finish({ now: 1 });
    expect(out.ok).toBe(true);
    expect(out.card.url).toBe(base + '/api/post');
    expect(out.card.method).toBe('POST');
    expect(out.card.slots).toContain('message');
    // the CSRF header was seen and remembered as auth-at, by NAME never value
    expect(out.card.authAt.some((a) => a.name === 'x-csrf-token')).toBe(true);
    expect(JSON.stringify(out.card)).not.toMatch(/tok-\d/);

    // 4) PLAN — a verified card replays; ours is fresh, so it would still walk UI. Mark it verified
    //    (as a successful first replay+verify would) to exercise the fast path.
    const verified = onVerified(out.card, 2);
    expect(planFor(verified).mode).toBe('fast');

    // 5) REPLAY — build the fetch and run it IN THE PAGE, re-reading the live token from the DOM,
    //    exactly as the real replay wrapper will. No clicks.
    const replay = buildReplay(verified, { message: 'the SECOND post, sent by REPLAY (no clicks)' });
    expect(replay).toBeTruthy();
    const result = await page.evaluate(async (r) => {
      const token = document.getElementById('csrf').dataset.token;   // live token, from where the card said it lives
      const resp = await fetch(r.url, {
        method: r.method,
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ ...r.values, csrf: token }),
      });
      return { status: resp.status, body: await resp.json().catch(() => null) };
    }, replay);

    // 6) VERIFY — read the effect back; the replay REALLY posted, no browser clicks involved.
    expect(result.status).toBe(200);
    const check = await page.evaluate(async () => (await (await fetch('/api/posts')).json()).posts);
    expect(check).toContain('the SECOND post, sent by REPLAY (no clicks)');

    // 7) the verify feeds the heal state machine — a good replay raises the card, no fallback.
    const healed = afterReplay(verified, { ok: result.status === 200, now: 3 });
    expect(healed.fallback).toBeNull();
    expect(healed.card.confidence).toBeGreaterThan(verified.confidence);

    await context.close();
  }, 60000);

  it("a replay that loses its auth is REFUSED by the API, and heal returns fallback 'ui'", async () => {
    // Proves the failure path is real: without the token the fixture 403s, and afterReplay quarantines
    // AND says 'ui' — the same job would retry by clicking, re-recording. This is Carla's rule, live.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(base + '/');
    const card = onVerified(distill({ intent: 'fixture.post', origin: base,
      requests: [{ method: 'POST', url: base + '/api/post', headers: { 'x-csrf-token': 'x' }, postData: '{"message":"m","csrf":"x"}' }], now: 1 }).card, 2);
    const replay = buildReplay(card, { message: 'this replay forgets its token' });
    const result = await page.evaluate(async (r) => {
      const resp = await fetch(r.url, { method: r.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(r.values) });
      return { status: resp.status };
    }, replay);
    expect(result.status).toBe(403);
    const healed = afterReplay(card, { ok: result.status === 200, now: 4 });
    expect(healed.fallback).toBe('ui');
    expect(healed.card.quarantined).toBe(true);
    await context.close();
  }, 60000);
});
