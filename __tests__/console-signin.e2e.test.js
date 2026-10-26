// Explicit browser test: GHOST_BROWSER_E2E=1 npm test -- __tests__/console-signin.e2e.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { chromium, devices } from 'playwright';
const require = createRequire(import.meta.url);
const express = require('express');
const { makeMobileAuth } = require('../src/mobileAuth');
const sso = require('../src/sso');
const enabled = process.env.GHOST_BROWSER_E2E === '1';
const suite = enabled ? describe : describe.skip;
suite('fresh browser authentication and native connection', () => {
  let server, browser, base, accounts, dir;
  const secret = 'browser-e2e-secret', owner = 'browser-test@example.test';
  const mint = (claims = {}) => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    const b = Buffer.from(JSON.stringify({ email: owner, exp: Math.floor(Date.now() / 1000) + 120, ...claims })).toString('base64url');
    return h + '.' + b + '.' + crypto.createHmac('sha256', secret).update(h + '.' + b).digest('base64url');
  };
  const handoff = (device, expired = false) => base + '/#leadflow=' + encodeURIComponent(JSON.stringify({ auth: mint(expired ? { exp: 1 } : {}), ...(device ? { device } : {}) }));
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gb-browser-auth-'));
    process.env.PROFILE_DIR = dir;
    delete require.cache[require.resolve('../src/accounts')]; accounts = require('../src/accounts');
    const record = accounts.signup(owner, 'test-only-owner-password');
    const app = express(); app.use(express.json());
    const mobile = makeMobileAuth({ mintDevice: input => ({ ...input, token: 'test-device-token' }) });
    const signedIn = req => accounts.verifyToken(accounts.readCookie(req));
    app.get('/', (_req, res) => res.type('html').send(readFileSync(new URL('../public/compose-index.html', import.meta.url))));
    app.get('/js/console-auth.js', (_req, res) => res.type('js').send(readFileSync(new URL('../public/js/console-auth.js', import.meta.url))));
    app.get('/console/live-overlay.js', (_req, res) => res.type('js').send(''));
    app.get('/console/gbweb.js', (_req, res) => res.type('js').send('document.body.dataset.consoleStarted="true"'));
    app.get('/api/auth/state', (req, res) => res.json({ signedIn: !!signedIn(req), sso: true, ssoOnly: true, hasPassword: false }));
    app.post('/api/auth/sso', (req, res) => {
      try { sso.verifyLeadflowToken(req.body.token, secret); const session = accounts.issue(record); accounts.setCookie(res, session.token, session.exp); res.json({ username: owner }); }
      catch { res.status(401).json({ error: 'expired' }); }
    });
    app.post('/api/auth/logout', (_req, res) => { accounts.clearCookie(res); res.json({ ok: true }); });
    app.post('/api/auth/device-code', (req, res) => {
      if (!signedIn(req)) return res.sendStatus(401);
      res.json(mobile.issue(owner, req.body.challenge));
    });
    app.post('/api/auth/device-token', (req, res) => { try { res.json(mobile.redeem(req.body)); } catch { res.sendStatus(401); } });
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, ...(process.env.GHOST_TEST_CHROMIUM ? { executablePath: process.env.GHOST_TEST_CHROMIUM } : {}) });
  }, 30000);
  afterAll(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); if (dir) rmSync(dir, { recursive: true, force: true }); });
  for (const [label, options] of [['desktop', {}], ['Android viewport', devices['Pixel 5']]]) {
    it(`${label}: fresh install -> sign-in button -> handoff -> session -> reload -> sign-out`, async () => {
      const context = await browser.newContext(options); const page = await context.newPage();
      page.setDefaultTimeout(5000);
      let step = 'fresh sign-in screen';
      try {
        await page.goto(base);
        await page.getByRole('link', { name: 'Sign in with MyApp.Engineer' }).waitFor();
        expect(await page.locator('#password-option').isVisible()).toBe(false);
        expect(await page.locator('#ComposeTarget').isVisible()).toBe(false);
        step = 'exchange handoff and start console'; await page.goto(handoff());
        await page.waitForFunction(() => document.body.dataset.consoleStarted === 'true');
        expect(new URL(page.url()).hash).toBe('');
        expect((await page.evaluate(() => fetch('/api/auth/state', { credentials: 'include' }).then(r => r.json()))).signedIn).toBe(true);
        step = 'reload signed-in console'; await page.reload(); await page.waitForFunction(() => document.body.dataset.consoleStarted === 'true');
        step = 'sign out and reload';
        await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })); await page.reload();
        await page.getByRole('link', { name: 'Sign in with MyApp.Engineer' }).waitFor();
      } catch (error) { throw new Error(step + ': ' + error.message); }
      finally { await context.close(); }
    }, 30000);
  }
  it('an expired handoff stays on a useful retry screen', async () => {
    const context = await browser.newContext(); const page = await context.newPage();
    try {
      await page.goto(handoff(null, true));
      await page.getByText('This sign-in link expired or could not be verified. Please sign in again.').waitFor();
      expect(await page.locator('#password-option').isVisible()).toBe(false);
    } finally { await context.close(); }
  });
  it('a mobile return exchanges its code once using the app verifier', async () => {
    const context = await browser.newContext(devices['Pixel 5']); const page = await context.newPage();
    const verifier = 'v'.repeat(43), challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    try {
      await page.goto(handoff({ challenge, state: 's'.repeat(43) }));
      const open = page.getByRole('link', { name: 'Open Ghost Browser Mobile' }); await open.waitFor();
      const callback = new URL(await open.getAttribute('href'));
      expect(callback.protocol).toBe('ghostbrowser:');
      const code = callback.searchParams.get('code');
      const exchange = await context.request.post(base + '/api/auth/device-token', { data: { code, verifier, deviceId: 'test-phone' } });
      expect(exchange.status()).toBe(200);
      expect((await exchange.json()).owner).toBe(owner);
      expect((await context.request.post(base + '/api/auth/device-token', { data: { code, verifier, deviceId: 'test-phone' } })).status()).toBe(401);
    } finally { await context.close(); }
  }, 30000);
});
