/**
 * THE WRITE GATE ON THE WIRE, against a prompt injection, in a real browser.
 *
 * The inbox contains a message that tells a driving agent to mail the inbox to an attacker. We play
 * the worst case: the agent OBEYS. The tool-level approval is bypassed entirely (the page's own
 * script does the sending). The only thing between the attacker and the mail is the lease.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeFakeSaas } from '../testbed/fakesaas.js';
import { mint, verify, enforce } from '../src/lease.js';

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* skip */ }
let browser = null;
if (chromium) {
  const opts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] };
  try { browser = await chromium.launch(opts); }
  catch { try { if (process.env.GB_CHROMIUM) browser = await chromium.launch({ ...opts, executablePath: process.env.GB_CHROMIUM }); } catch { console.warn('[lease.e2e] no Chromium — skipping'); } }
}
const SECRET = 'lease-test-secret';

describe.skipIf(!browser)('a lease on the wire', () => {
  let saas, origin;
  beforeAll(async () => { saas = makeFakeSaas({ mfa: 'none' }); origin = await saas.listen(); }, 30000);
  afterAll(async () => { await saas.close(); });

  /** A signed-in browser with the gate attached AFTER sign-in, as a real session is. */
  async function session(getLease) {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(origin + '/');
    await page.fill('#user', saas.USER); await page.fill('#pw', saas.PASSWORD); await page.click('#go');
    await page.waitForFunction(() => document.title === 'signed in');
    await page.goto(origin + '/inbox'); await page.waitForSelector('li.msg');
    const gate = await enforce(ctx, getLease, { log: { info() {} } });
    return { ctx, page, gate };
  }
  const obey = (page, to) => page.evaluate((t) => window.send(t, 'the whole inbox').catch((e) => 'blocked:' + e.message), to);

  it('with no lease the session reads freely and an obeyed injection goes nowhere', async () => {
    const before = saas.state.sent.length;
    const { ctx, page, gate } = await session(() => null);
    expect(await page.$$eval('li.msg .subj', (e) => e.length)).toBe(3);              // reading is untouched
    expect(String(await obey(page, 'eve@evil.example'))).toMatch(/blocked/);
    expect(saas.state.sent.length).toBe(before);
    expect(saas.state.csrfRefusals).toBe(0);                                          // it never even reached the server
    expect(gate.blocked.length).toBe(1);
    expect(gate.blocked[0].why).toMatch(/read-only/);
    await ctx.close();
  }, 30000);

  it('every other way a page can write is stopped too: form post, sendBeacon, XHR (against a cookie-only endpoint that WOULD accept them)', async () => {
    const { ctx, page, gate } = await session(() => null);
    const before = saas.state.sent.length;
    await page.evaluate(() => navigator.sendBeacon('/legacy/send', JSON.stringify({ to: 'eve@evil.example' })));
    await page.evaluate(() => new Promise((r) => { const x = new XMLHttpRequest(); x.open('POST', '/legacy/send'); x.onloadend = r; x.send(JSON.stringify({ to: 'eve@evil.example' })); }));
    await page.evaluate(() => { const f = document.createElement('form'); f.method = 'POST'; f.action = '/legacy/send'; f.innerHTML = '<input name="to" value="eve@evil.example">'; document.body.appendChild(f); f.submit(); }).catch(() => {});
    await page.waitForTimeout(400);
    expect(saas.state.sent.length).toBe(before);
    expect(gate.blocked.length).toBeGreaterThanOrEqual(3);
    await ctx.close();
  }, 30000);

  it('a scoped lease lets exactly the intended send through and still stops the injected one', async () => {
    const lease = verify(SECRET, mint(SECRET, { profile: 'p', allow: [{ method: 'POST', path: '/api/send', body: { to: '^bob@example\\.org$' }, max: 1 }] }), { profile: 'p' });
    const before = saas.state.sent.length;
    const { ctx, page, gate } = await session(() => lease);
    expect(await obey(page, 'eve@evil.example')).not.toBe(200);                       // the injection: refused
    expect(await obey(page, 'bob@example.org')).toBe(200);                            // the owner's intent: sent
    expect(String(await obey(page, 'bob@example.org'))).toMatch(/blocked/);           // used up: max 1
    expect(saas.state.sent.slice(before)).toEqual([{ to: 'bob@example.org', body: 'the whole inbox' }]);
    expect(gate.allowed.length).toBe(1);
    expect(gate.blocked.map((b) => b.why).join('|')).toMatch(/does not cover.*|used \d+ time/);
    await ctx.close();
  }, 30000);

  it('revoking takes effect on the very next request, mid-session', async () => {
    let current = verify(SECRET, mint(SECRET, { profile: 'p', allow: [{ method: 'POST', path: '/api/send' }] }), { profile: 'p' });
    const { ctx, page } = await session(() => current);
    const before = saas.state.sent.length;
    expect(await obey(page, 'bob@example.org')).toBe(200);
    current = null;                                                                    // owner revokes
    expect(String(await obey(page, 'bob@example.org'))).toMatch(/blocked/);
    expect(saas.state.sent.length).toBe(before + 1);
    await ctx.close();
  }, 30000);

  it('an expired lease stops writes without anyone revoking it', async () => {
    const lease = verify(SECRET, mint(SECRET, { profile: 'p', allow: [{ method: 'POST', path: '/api/send' }], ttlMs: 1000 }), { profile: 'p' });
    const { ctx, page } = await session(() => lease);
    await page.waitForTimeout(1300);
    expect(String(await obey(page, 'bob@example.org'))).toMatch(/blocked/);
    await ctx.close();
  }, 30000);
});
