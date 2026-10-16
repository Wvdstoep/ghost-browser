/**
 * Device-bound sessions: noticed from the site's own announcement, routed to the device that holds
 * the login, and never copied by the cookie vault. The browser half runs against the fake SaaS in
 * device-bound mode (its /dbsc/start answers with Secure-Session-Registration, as DBSC does).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-bound-'));
process.env.PROFILE_DIR = DIR;
const walls = await import('../src/siteWalls.js').then((m) => m.default || m);
const bound = await import('../src/boundSessions.js').then((m) => m.default || m);
const vault = await import('../src/sessionVault.js').then((m) => m.default || m);
const sites = await import('../src/sites/index.js').then((m) => m.default || m);
const { makeFakeSaas } = await import('../testbed/fakesaas.js');
const { totp } = await import('../src/tools/craft-parts.js');

const cookie = (domain, name, value = 'v') => ({ domain, name, value, path: '/', expires: Date.now() / 1000 + 3600 });

describe('detection (pure)', () => {
  beforeEach(() => { bound._forget(); walls.reload(); try { fs.rmSync(walls.FILE); } catch { /* none */ } walls.reload(); });
  it('announces() reads the registration header whatever its case', () => {
    expect(bound.announces({ 'Secure-Session-Registration': '(ES256); path="/x"' })).toBe(true);
    expect(bound.announces({ 'secure-session-registration': '(ES256)' })).toBe(true);
    expect(bound.announces({ 'content-type': 'text/html' })).toBe(false);
    expect(bound.announces(null)).toBe(false);
  });
  it('marking a host records it as bound once, and routing sees it', () => {
    expect(bound.isBound('github.com')).toBe(false);
    expect(bound.mark('github.com', '(ES256)')).toBeTruthy();
    expect(bound.mark('github.com', '(ES256)')).toBeNull();                 // one write per host, not per response
    expect(bound.isBound('github.com')).toBe(true);
    expect(walls.reasonFor('github.com')).toBe('bound');
    expect(sites.needsDevice('github.com')).toBe(true);                      // the route to the device ring is the existing one
  });
  it('the vault will not save or restore a bound host\'s cookies, and still treats other hosts normally', () => {
    bound.mark('github.com', '(ES256)');
    const jar = [cookie('.github.com', 'user_session'), cookie('.linkedin.com', 'li_at'), cookie('.linkedin.com', 'JSESSIONID')];
    const r = vault.save('prof', jar, {});
    expect(r.hosts).toEqual(['linkedin.com']);                               // github.com's session was not written down
    const plan = vault.planRestore([], { cookies: jar });
    expect(plan.hosts).toEqual(['linkedin.com']);
    expect(plan.restore.every((c) => !/github/.test(c.domain))).toBe(true);
  });
  it('a jar holding ONLY a bound session is not worth saving, so it cannot overwrite a good snapshot', () => {
    bound.mark('github.com', '(ES256)');
    expect(vault.save('prof2', [cookie('.github.com', 'user_session')], {}).saved).toBe(false);
  });
});

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* skip */ }
let browser = null;
if (chromium) {
  const opts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] };
  try { browser = await chromium.launch(opts); }
  catch { try { if (process.env.GB_CHROMIUM) browser = await chromium.launch({ ...opts, executablePath: process.env.GB_CHROMIUM }); } catch { console.warn('[bound] no Chromium — skipping'); } }
}

describe.skipIf(!browser)('against a site that binds its sessions', () => {
  let saas, origin;
  beforeAll(async () => { bound._forget(); try { fs.rmSync(walls.FILE); } catch { /* none */ } walls.reload(); saas = makeFakeSaas({ mfa: 'totp', bound: true, boundTtlMs: 1500 }); origin = await saas.listen(); }, 30000);
  afterAll(async () => { await saas.close(); if (browser) await browser.close(); });

  it('signing in is enough for the browser to notice, record the host, and route it to a device', async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    bound.watch(ctx, { log: { info() {} } });
    expect(walls.walled('localhost')).toBe(false);
    await page.goto(origin + '/');
    await page.fill('#user', saas.USER); await page.fill('#pw', saas.PASSWORD); await page.click('#go');
    await page.waitForSelector('#code'); await page.fill('#code', totp(saas.TOTP_SECRET).code); await page.click('#verify');
    await page.waitForFunction(() => document.title === 'signed in');
    await page.waitForTimeout(300);
    walls.reload();                                                          // siteWalls caches reads for 5s; the browser wrote the record
    expect(walls.reasonFor('localhost')).toBe('bound');
    expect(walls.all().find((w) => w.host === 'localhost').evidence).toMatch(/ES256/);
    await ctx.close();
  }, 30000);
});
