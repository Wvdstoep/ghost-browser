/* Live browser proof. Supply a short-lived authorized platform session in a local file.
 * No passwords, session cookies, handoff fragments or device keys are printed or saved in reports. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium, devices } = require('playwright');
(async () => {
  const session = JSON.parse(fs.readFileSync(process.env.GB_E2E_SESSION_FILE, 'utf8'));
  const browser = await chromium.launch({ headless: true, ...(process.env.GHOST_TEST_CHROMIUM ? { executablePath: process.env.GHOST_TEST_CHROMIUM } : {}) });
  const results = [];
  async function context(options = {}) {
    const ctx = await browser.newContext(options);
    await ctx.addCookies([{ name: 'ac_session', value: session.token, url: 'https://' + session.host, secure: true, httpOnly: true, sameSite: 'Lax' }]);
    return ctx;
  }
  try {
    if (process.argv.includes('--baseline')) {
      const ctx = await context(); const page = await ctx.newPage(); let exchanges = 0;
      page.on('request', r => { if (new URL(r.url()).pathname.endsWith('/api/auth/sso')) exchanges++; });
      await page.goto('https://' + session.host + '/api/cluster-tools/ghost-browser/open', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(5000);
      const state = await page.evaluate(() => fetch('/api/auth/state', { credentials: 'include' }).then(r => r.json()));
      results.push({ check: 'original Open journey', ssoExchanges: exchanges, signedIn: state.signedIn, passwordConfigured: state.hasPassword });
      await ctx.close();
    } else {
      for (const [label, options] of [['desktop', {}], ['Android viewport', devices['Pixel 5']]]) {
        const ctx = await context(options); const page = await ctx.newPage(); page.setDefaultTimeout(20000);
        try {
          await page.goto(session.tool, { waitUntil: 'domcontentloaded' });
          await page.getByRole('link', { name: 'Sign in with MyApp.Engineer' }).waitFor();
          if (await page.locator('#password-option').isVisible()) throw new Error('Unconfigured password form is still shown');
          if (process.env.GB_E2E_ARTIFACT_DIR && label === 'Android viewport') await page.screenshot({ path: path.join(process.env.GB_E2E_ARTIFACT_DIR, 'ghost-hosted-signin.png'), fullPage: true });
          await page.getByRole('link', { name: 'Sign in with MyApp.Engineer' }).click();
          await page.waitForURL(u => u.hostname === new URL(session.tool).hostname && !u.hash, { timeout: 40000 });
          await page.waitForFunction(() => document.getElementById('auth-gate')?.hidden === true);
          const state = await page.evaluate(() => fetch('/api/auth/state', { credentials: 'include' }).then(r => r.json()));
          if (!state.signedIn) throw new Error('Browser did not create a session');
          await page.reload(); await page.waitForFunction(() => document.getElementById('auth-gate')?.hidden === true);
          await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })); await page.reload();
          await page.getByRole('link', { name: 'Sign in with MyApp.Engineer' }).waitFor();
          results.push({ check: label, directSignIn: true, sessionAfterReload: true, signedOut: true });
        } finally { await ctx.close(); }
      }
      const anon = await browser.newContext(devices['Pixel 5']); const login = await anon.newPage();
      await login.goto(session.tool); await login.getByRole('link', { name: 'Sign in with MyApp.Engineer' }).click();
      await login.locator('#login-email').waitFor({ state: 'visible', timeout: 20000 });
      if (!(await login.getByRole('button', { name: 'Sign in with Google', exact: true }).isVisible())) throw new Error('Google option missing');
      results.push({ check: 'signed-out platform page', emailAndGoogleVisible: true }); await anon.close();
      const ctx = await context(devices['Pixel 5']); const page = await ctx.newPage();
      const verifier = crypto.randomBytes(32).toString('base64url'), state = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const deviceId = 'e2e-' + crypto.randomBytes(8).toString('hex'); let enrolled = false;
      try {
        const next = '/api/cluster-tools/ghost-browser/open?' + new URLSearchParams({ device_challenge: challenge, device_state: state });
        await page.goto('https://' + session.host + '/?next=' + encodeURIComponent(next), { waitUntil: 'domcontentloaded' });
        const open = page.getByRole('link', { name: 'Open Ghost Browser Mobile' }); await open.waitFor({ timeout: 40000 });
        const callback = new URL(await open.getAttribute('href'));
        if (callback.searchParams.get('state') !== state || callback.searchParams.get('cluster') !== session.tool || callback.searchParams.has('token')) throw new Error('Invalid mobile callback');
        const body = { code: callback.searchParams.get('code'), verifier, deviceId, name: 'Temporary login verification' };
        const exchange = await ctx.request.post(session.tool + '/api/auth/device-token', { data: body });
        if (exchange.status() !== 200) throw new Error('Native code redemption failed');
        const record = await exchange.json(); enrolled = true;
        const probe = await ctx.request.get(session.tool + '/v1/device/list', { headers: { authorization: 'Bearer ' + record.token } });
        if (probe.status() !== 200) throw new Error('Redeemed device key is not usable');
        if ((await ctx.request.post(session.tool + '/api/auth/device-token', { data: body })).status() !== 401) throw new Error('Code was reusable');
        results.push({ check: 'live mobile connection', callbackValidated: true, deviceKeyWorks: true, codeSingleUse: true });
      } finally {
        if (enrolled) await ctx.request.delete(session.tool + '/v1/device/tokens/' + deviceId);
        await ctx.close();
      }
    }
    console.log(JSON.stringify(results, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message.replace(/#leadflow=[^\s]+/g, '#leadflow=[redacted]')); process.exitCode = 1; });
